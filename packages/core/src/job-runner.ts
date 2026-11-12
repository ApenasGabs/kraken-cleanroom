import pino from "pino";
import { JobBlockedError, JobConflictError, OutOfScopeError } from "./errors.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createHandoffId } from "./ids.js";
import type { JobStore } from "./job-store.js";
import { FakeLlmClient, type LlmClient, bindLlmClientToJob } from "./llm-client.js";
import { type Logger, createLogger } from "./logger.js";
import type { Manifest } from "./manifest.js";
import { type ScopeGuard, createScopeGuard } from "./scope-guard.js";
import { DEFAULT_PHASE_ORDER } from "./types/index.js";
import type {
  JobEvent,
  JobRecord,
  Phase,
  PhaseContext,
  PhaseId,
  PhaseResult,
} from "./types/index.js";

export type JobAbortKind = "timeout" | "cancelled";

/** Motivo usado em `AbortController.abort()` para distinguir timeout de cancelamento. */
export class JobAbortReason extends Error {
  readonly kind: JobAbortKind;

  constructor(kind: JobAbortKind, message?: string) {
    super(message ?? (kind === "timeout" ? "Timeout global do job excedido." : "Job cancelado."));
    this.name = "JobAbortReason";
    this.kind = kind;
  }
}

export interface JobRunnerOptions {
  store: JobStore;
  evidence: EvidenceStore;
  phases: readonly Phase[];
  /** Cliente LLM injetado nas fases; contabiliza tokens automaticamente no job. */
  llm?: LlmClient | undefined;
  /** Logger base; se omitido, cada job loga em `jobs/<jobId>/logs/job.ndjson`. */
  logger?: Logger | undefined;
  /** Sobrescreve o timeout global (ms). Default: `limits.maxDurationMin` do manifesto. */
  timeoutMs?: number | undefined;
  guardFactory?: ((manifest: Manifest) => ScopeGuard) | undefined;
}

export interface RunJobOptions {
  /** Sinal externo (cancelamento). Abortar com `JobAbortReason("cancelled")`. */
  signal?: AbortSignal | undefined;
  /** Restringe as fases executadas (ex.: `cleanroom run --phases intake,explore`). */
  enabledPhases?: readonly PhaseId[] | undefined;
}

class AbortedRunError extends Error {
  readonly reason: JobAbortReason;

  constructor(reason: JobAbortReason) {
    super(reason.message);
    this.reason = reason;
  }
}

function toAbortReason(reason: unknown): JobAbortReason {
  if (reason instanceof JobAbortReason) {
    return reason;
  }
  return new JobAbortReason("cancelled", reason instanceof Error ? reason.message : undefined);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new AbortedRunError(toAbortReason(signal.reason)));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(new AbortedRunError(toAbortReason(signal.reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(err);
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Executa as fases de um job em sequência, com checkpoint por fase, retomada da
 * última fase não concluída e timeout global via `AbortSignal` (docs/02 §4, docs/04).
 */
export class JobRunner {
  private readonly store: JobStore;
  private readonly evidence: EvidenceStore;
  private readonly registry: Map<PhaseId, Phase>;
  private readonly llm: LlmClient;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly guardFactory: (manifest: Manifest) => ScopeGuard;

  constructor(options: JobRunnerOptions) {
    this.store = options.store;
    this.evidence = options.evidence;
    this.registry = new Map(options.phases.map((p) => [p.id, p]));
    this.llm = options.llm ?? new FakeLlmClient();
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs;
    this.guardFactory = options.guardFactory ?? ((manifest) => createScopeGuard(manifest));
  }

  /**
   * Roda (ou retoma) o job. Aceita jobs em `running` (início ou retomada após crash)
   * e `awaiting_human` (retomada após handoff). Retorna o registro final do job.
   */
  async run(jobId: string, options?: RunJobOptions): Promise<JobRecord> {
    let job = this.store.getJobOrThrow(jobId);
    if (job.state === "awaiting_human") {
      job = this.store.transition(jobId, "running");
      this.store.appendEvent(jobId, { type: "job_resumed" });
    } else if (job.state !== "running") {
      throw new JobConflictError(
        `Job ${jobId} está em "${job.state}" e não pode ser executado pelo runner.`,
        { details: { jobId, state: job.state } },
      );
    }

    const manifest = job.manifest;
    this.store.ensurePhases(jobId, DEFAULT_PHASE_ORDER);

    const controller = new AbortController();
    const timeoutMs = this.timeoutMs ?? manifest.limits.maxDurationMin * 60_000;
    const timer = setTimeout(() => {
      controller.abort(
        new JobAbortReason("timeout", `Timeout global de ${timeoutMs} ms excedido.`),
      );
    }, timeoutMs);
    timer.unref?.();
    const external = options?.signal;
    const onExternalAbort = () => controller.abort(toAbortReason(external?.reason));
    if (external !== undefined) {
      if (external.aborted) {
        onExternalAbort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const { log, close } = this.createJobLogger(jobId);
    try {
      return await this.runPhases(job, manifest, controller.signal, log, options?.enabledPhases);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
      close();
    }
  }

  private async runPhases(
    initialJob: JobRecord,
    manifest: Manifest,
    signal: AbortSignal,
    log: Logger,
    enabledPhases: readonly PhaseId[] | undefined,
  ): Promise<JobRecord> {
    const jobId = initialJob.id;
    const guard = this.guardFactory(manifest);

    for (const phaseId of DEFAULT_PHASE_ORDER) {
      if (signal.aborted) {
        return this.handleAbort(jobId, phaseId, toAbortReason(signal.reason), false);
      }
      const record = this.store.getPhase(jobId, phaseId);
      if (record?.status === "done" || record?.status === "skipped") {
        continue;
      }

      const phase = this.registry.get(phaseId);
      const enabled =
        phase !== undefined &&
        (enabledPhases === undefined || enabledPhases.includes(phaseId)) &&
        (phase.isEnabled?.(manifest) ?? true);
      if (!enabled || phase === undefined) {
        this.store.setPhaseStatus(jobId, phaseId, "skipped");
        this.store.appendEvent(jobId, { type: "phase_skipped", phase: phaseId });
        continue;
      }

      const resumed = record?.checkpoint !== undefined;
      this.store.setPhaseStatus(jobId, phaseId, "running");
      this.store.appendEvent(jobId, {
        type: "phase_started",
        phase: phaseId,
        data: { resumed },
      });

      let live = true;
      const phaseLog = log.child({ phase: phaseId });
      const ctx: PhaseContext = {
        job: this.store.getJobOrThrow(jobId),
        manifest,
        guard,
        evidence: this.evidence,
        llm: bindLlmClientToJob(this.llm, this.store, jobId, () => {
          ctx.job = this.store.getJobOrThrow(jobId);
        }),
        log: phaseLog,
        signal,
        checkpoint: record?.checkpoint,
        saveCheckpoint: (checkpoint) => {
          if (!live) {
            return;
          }
          this.store.saveCheckpoint(jobId, phaseId, checkpoint);
          this.store.appendEvent(jobId, { type: "checkpoint_saved", phase: phaseId });
        },
        emit: (event: JobEvent) => {
          if (!live) {
            return;
          }
          this.store.appendEvent(jobId, { ...event, phase: event.phase ?? phaseId });
        },
      };

      let result: PhaseResult;
      try {
        result = await raceAbort(
          Promise.resolve().then(() => phase.run(ctx)),
          signal,
        );
      } catch (err) {
        live = false;
        if (err instanceof AbortedRunError) {
          return this.handleAbort(jobId, phaseId, err.reason, true);
        }
        phaseLog.error({ err }, "fase falhou");
        this.store.setPhaseStatus(jobId, phaseId, "failed");
        this.store.appendEvent(jobId, {
          type: "phase_failed",
          phase: phaseId,
          data: { error: errorMessage(err) },
        });
        const blocked = err instanceof JobBlockedError || err instanceof OutOfScopeError;
        return this.finish(jobId, blocked ? "blocked" : "failed", errorMessage(err));
      }
      live = false;

      // Outro processo pode ter cancelado o job enquanto a fase rodava.
      const current = this.store.getJobOrThrow(jobId);
      if (current.state !== "running") {
        return current;
      }

      if (result.status === "ok") {
        this.store.setPhaseStatus(jobId, phaseId, "done", result.stats);
        this.store.appendEvent(jobId, {
          type: "phase_completed",
          phase: phaseId,
          data: { stats: result.stats },
        });
        continue;
      }

      if (result.status === "awaiting_human") {
        const handoff = this.store.createHandoff(jobId, createHandoffId(), result.handoff);
        this.store.appendEvent(jobId, {
          type: "handoff_requested",
          phase: phaseId,
          data: { handoffId: handoff.id, kind: handoff.kind },
        });
        return this.store.transition(jobId, "awaiting_human");
      }

      this.store.setPhaseStatus(jobId, phaseId, "failed");
      this.store.appendEvent(jobId, {
        type: "phase_blocked",
        phase: phaseId,
        data: { reason: result.reason },
      });
      return this.finish(jobId, "blocked", result.reason);
    }

    return this.finish(jobId, "completed");
  }

  private handleAbort(
    jobId: string,
    phaseId: PhaseId,
    reason: JobAbortReason,
    phaseStarted: boolean,
  ): JobRecord {
    if (reason.kind === "timeout") {
      if (phaseStarted) {
        this.store.setPhaseStatus(jobId, phaseId, "failed");
      }
      this.store.appendEvent(jobId, {
        type: "job_timeout",
        phase: phaseId,
        data: { message: reason.message },
      });
      return this.finish(jobId, "failed", reason.message);
    }
    if (phaseStarted) {
      // Fase interrompida: volta a `pending` preservando o checkpoint.
      this.store.setPhaseStatus(jobId, phaseId, "pending");
    }
    return this.finish(jobId, "cancelled", reason.message);
  }

  private finish(
    jobId: string,
    to: "completed" | "failed" | "blocked" | "cancelled",
    error?: string,
  ): JobRecord {
    const current = this.store.getJobOrThrow(jobId);
    if (current.state !== "running") {
      return current;
    }
    return this.store.transition(jobId, to, error !== undefined ? { error } : undefined);
  }

  private createJobLogger(jobId: string): { log: Logger; close: () => void } {
    if (this.logger !== undefined) {
      return { log: this.logger.child({ jobId }), close: () => undefined };
    }
    const destination = pino.destination({
      dest: this.store.resolveLogPath(jobId),
      sync: true,
      append: true,
      mkdir: true,
    });
    const log = createLogger({ base: { jobId } }, destination);
    return {
      log,
      close: () => {
        try {
          destination.end();
        } catch {
          // destino já fechado
        }
      },
    };
  }
}
