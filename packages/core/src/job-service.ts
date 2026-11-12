import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { SqliteDatabase } from "./db.js";
import { HandoffNotFoundError, JobConflictError, ManifestError } from "./errors.js";
import type { ManifestIssueDetail } from "./errors.js";
import { EvidenceStore, type ListEvidenceFilter } from "./evidence-store.js";
import { createCleanroomJobId } from "./ids.js";
import { JobAbortReason, JobRunner } from "./job-runner.js";
import { isTerminalJobState } from "./job-state.js";
import { JobStore } from "./job-store.js";
import type { LlmClient } from "./llm-client.js";
import type { Logger } from "./logger.js";
import {
  type InitManifestOptions,
  type LoadManifestOptions,
  type Manifest,
  initManifest as buildInitialManifest,
  parseManifestYaml,
} from "./manifest.js";
import type { ScopeGuard } from "./scope-guard.js";
import type {
  BusinessRule,
  Confidence,
  Evidence,
  JobRecord,
  JobState,
  JobStatus,
  JobSummary,
  Page,
  Phase,
  PhaseId,
} from "./types/index.js";

export type ValidateManifestServiceResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; issues: ManifestIssueDetail[] };

export interface StartJobOptions {
  enabledPhases?: readonly PhaseId[] | undefined;
}

/** Contrato interno compartilhado por CLI, MCP e REST (docs/07 §1). */
export interface JobService {
  validateManifest(yaml: string): Promise<ValidateManifestServiceResult>;
  initManifest(url: string, overrides?: InitManifestOptions): Promise<string>;
  start(manifestYaml: string, options?: StartJobOptions): Promise<{ jobId: string }>;
  status(jobId: string): Promise<JobStatus>;
  list(filter?: { state?: JobState; limit?: number }): Promise<JobSummary[]>;
  cancel(jobId: string, reason?: string): Promise<void>;
  resume(jobId: string): Promise<void>;
  resolveHandoff(jobId: string, handoffId: string, note?: string): Promise<void>;
  getReport(jobId: string, format: "markdown" | "json"): Promise<string>;
  listEvidence(
    jobId: string,
    filter?: { kind?: Evidence["kind"]; limit?: number; cursor?: string },
  ): Promise<Page<Evidence>>;
  getEvidence(jobId: string, evidenceId: string): Promise<Evidence & { blobUrl?: string }>;
  listRules(
    jobId: string,
    filter?: { module?: string; confidence?: Confidence },
  ): Promise<BusinessRule[]>;
}

export interface JobServiceOptions {
  db: SqliteDatabase;
  dataDir: string;
  phases: readonly Phase[];
  llm?: LlmClient | undefined;
  logger?: Logger | undefined;
  /** Sobrescreve o timeout global do runner (ms); útil em testes. */
  timeoutMs?: number | undefined;
  manifestOptions?: LoadManifestOptions | undefined;
  guardFactory?: ((manifest: Manifest) => ScopeGuard) | undefined;
  now?: (() => Date) | undefined;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<JobRecord>;
}

function guessJobName(yaml: string): { name: string; raw: Record<string, unknown> } {
  try {
    const raw: unknown = parseDocument(yaml).toJS();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const job = record.job;
      if (typeof job === "object" && job !== null) {
        const name = (job as Record<string, unknown>).name;
        if (typeof name === "string" && /^[a-z0-9-]{1,40}$/.test(name)) {
          return { name, raw: record };
        }
      }
      return { name: "invalid", raw: record };
    }
  } catch {
    // YAML ilegível: segue com nome genérico
  }
  return { name: "invalid", raw: {} };
}

function formatIssues(issues: readonly ManifestIssueDetail[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

export class CleanroomJobService implements JobService {
  readonly store: JobStore;
  readonly evidence: EvidenceStore;
  readonly runner: JobRunner;
  private readonly db: SqliteDatabase;
  private readonly manifestOptions: LoadManifestOptions | undefined;
  private readonly now: () => Date;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: JobServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.store = new JobStore({ db: options.db, dataDir: options.dataDir, now: this.now });
    this.evidence = new EvidenceStore({ db: options.db, dataDir: options.dataDir });
    this.runner = new JobRunner({
      store: this.store,
      evidence: this.evidence,
      phases: options.phases,
      llm: options.llm,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      guardFactory: options.guardFactory,
    });
    this.manifestOptions = options.manifestOptions;
  }

  async validateManifest(yaml: string): Promise<ValidateManifestServiceResult> {
    try {
      // Sempre conteúdo YAML: o serviço nunca lê caminhos de arquivo vindos do cliente.
      return { ok: true, manifest: parseManifestYaml(yaml, this.manifestOptions) };
    } catch (err) {
      if (err instanceof ManifestError) {
        return { ok: false, issues: [...err.issues] };
      }
      return { ok: false, issues: [{ path: "manifest", message: String(err) }] };
    }
  }

  async initManifest(url: string, overrides?: InitManifestOptions): Promise<string> {
    return buildInitialManifest(url, overrides);
  }

  async start(manifestYaml: string, options?: StartJobOptions): Promise<{ jobId: string }> {
    const { name, raw } = guessJobName(manifestYaml);
    const jobId = createCleanroomJobId(name, this.now());
    this.store.createJob({ id: jobId, name, manifest: raw, manifestYaml });
    this.store.transition(jobId, "validating_manifest");

    const result = await this.validateManifest(manifestYaml);
    if (!result.ok) {
      this.store.transition(jobId, "rejected", { error: formatIssues(result.issues) });
      throw new ManifestError(`Manifesto inválido; job ${jobId} rejeitado.`, {
        issues: result.issues,
        details: { jobId, issues: result.issues },
      });
    }

    this.store.transition(jobId, "running", { manifest: result.manifest });
    this.launch(jobId, options);
    return { jobId };
  }

  async status(jobId: string): Promise<JobStatus> {
    const job = this.store.getJobOrThrow(jobId);
    const phases = this.store.listPhases(jobId);
    const current = phases.find((p) => p.status === "running");
    const handoff = this.store.getPendingHandoff(jobId);
    const count = (sql: string) =>
      (this.db.prepare(sql).get(jobId) as { n: number } | undefined)?.n ?? 0;

    return {
      jobId: job.id,
      state: job.state,
      ...(current !== undefined ? { currentPhase: current.phase } : {}),
      phases: phases.map((p) => ({
        id: p.phase,
        status: p.status,
        ...(p.stats !== undefined ? { stats: p.stats } : {}),
      })),
      counters: {
        pages: count("SELECT COUNT(*) AS n FROM evidence WHERE job_id = ? AND kind = 'state'"),
        evidence: count("SELECT COUNT(*) AS n FROM evidence WHERE job_id = ?"),
        findings: count("SELECT COUNT(*) AS n FROM findings WHERE job_id = ?"),
        rules: count("SELECT COUNT(*) AS n FROM rules WHERE job_id = ?"),
      },
      ...(handoff !== null
        ? {
            pendingHandoff: {
              id: handoff.id,
              kind: handoff.kind,
              message: handoff.message,
              ...(handoff.liveUrl !== undefined ? { liveUrl: handoff.liveUrl } : {}),
            },
          }
        : {}),
      llm: { tokensIn: job.llmTokensIn, tokensOut: job.llmTokensOut },
      startedAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
  }

  async list(filter?: { state?: JobState; limit?: number }): Promise<JobSummary[]> {
    return this.store.listJobs(filter).map((job) => ({
      jobId: job.id,
      name: job.name,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.error !== undefined ? { error: job.error } : {}),
    }));
  }

  async cancel(jobId: string, reason?: string): Promise<void> {
    const job = this.store.getJobOrThrow(jobId);
    if (isTerminalJobState(job.state)) {
      throw new JobConflictError(`Job ${jobId} já está em estado final (${job.state}).`, {
        details: { jobId, state: job.state },
      });
    }
    const message = reason ?? "Cancelado pelo usuário.";
    const run = this.active.get(jobId);
    if (run !== undefined) {
      run.controller.abort(new JobAbortReason("cancelled", message));
      await run.promise;
    }
    const current = this.store.getJobOrThrow(jobId);
    if (!isTerminalJobState(current.state)) {
      this.store.transition(jobId, "cancelled", { error: message });
    }
    this.store.closeHandoffs(jobId, "cancelled");
  }

  async resume(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      throw new JobConflictError(`Job ${jobId} já está em execução.`, { details: { jobId } });
    }
    const job = this.store.getJobOrThrow(jobId);
    if (job.state === "awaiting_human") {
      const handoff = this.store.getPendingHandoff(jobId);
      if (handoff !== null) {
        throw new JobConflictError(
          `Job ${jobId} aguarda o handoff ${handoff.id}; resolva-o antes de retomar.`,
          { details: { jobId, handoffId: handoff.id } },
        );
      }
    } else if (job.state === "running") {
      // Processo anterior morreu no meio da execução: retoma da última fase não concluída.
      this.store.appendEvent(jobId, { type: "job_recovered" });
    } else {
      throw new JobConflictError(`Job ${jobId} em "${job.state}" não pode ser retomado.`, {
        details: { jobId, state: job.state },
      });
    }
    this.launch(jobId);
  }

  async resolveHandoff(jobId: string, handoffId: string, note?: string): Promise<void> {
    const job = this.store.getJobOrThrow(jobId);
    const handoff = this.store.getHandoff(jobId, handoffId);
    if (handoff === null) {
      throw new HandoffNotFoundError(`Handoff não encontrado: ${handoffId}`, { handoffId });
    }
    if (job.state !== "awaiting_human" || handoff.status !== "pending") {
      throw new JobConflictError(`Handoff ${handoffId} não está pendente.`, {
        details: { jobId, handoffId, state: job.state, handoffStatus: handoff.status },
      });
    }
    this.store.closeHandoffs(jobId, "resolved", handoffId);
    this.store.appendEvent(jobId, {
      type: "handoff_resolved",
      data: { handoffId, ...(note !== undefined ? { note } : {}) },
    });
    await this.resume(jobId);
  }

  async getReport(jobId: string, format: "markdown" | "json"): Promise<string> {
    this.store.getJobOrThrow(jobId);
    const file = format === "markdown" ? "report.md" : "report.json";
    const path = join(this.store.resolveJobDir(jobId), "report", file);
    if (!existsSync(path)) {
      throw new JobConflictError(`Relatório (${format}) ainda não foi gerado para ${jobId}.`, {
        details: { jobId, format },
      });
    }
    return readFileSync(path, "utf8");
  }

  async listEvidence(
    jobId: string,
    filter?: { kind?: Evidence["kind"]; limit?: number; cursor?: string },
  ): Promise<Page<Evidence>> {
    this.store.getJobOrThrow(jobId);
    const evidenceFilter: ListEvidenceFilter = {
      ...(filter?.kind !== undefined ? { kind: filter.kind } : {}),
      ...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter?.cursor !== undefined ? { cursor: filter.cursor } : {}),
    };
    return this.evidence.list(jobId, evidenceFilter);
  }

  async getEvidence(jobId: string, evidenceId: string): Promise<Evidence & { blobUrl?: string }> {
    this.store.getJobOrThrow(jobId);
    // `blobUrl` é preenchido pela API REST (Fase 2).
    return this.evidence.getOrThrow(jobId, evidenceId);
  }

  async listRules(
    jobId: string,
    filter?: { module?: string; confidence?: Confidence },
  ): Promise<BusinessRule[]> {
    this.store.getJobOrThrow(jobId);
    const rows = this.db
      .prepare("SELECT data_json FROM rules WHERE job_id = ? ORDER BY id")
      .all(jobId) as { data_json: string }[];
    return rows
      .map((row) => JSON.parse(row.data_json) as BusinessRule)
      .filter((rule) => filter?.module === undefined || rule.module === filter.module)
      .filter((rule) => filter?.confidence === undefined || rule.confidence === filter.confidence);
  }

  /** Retoma jobs que ficaram em `running` após reinício do processo. */
  async recoverInterrupted(): Promise<string[]> {
    const stale = this.store
      .listJobs({ state: "running", limit: 500 })
      .filter((job) => !this.active.has(job.id));
    for (const job of stale) {
      await this.resume(job.id);
    }
    return stale.map((job) => job.id);
  }

  isActive(jobId: string): boolean {
    return this.active.has(jobId);
  }

  /** Aguarda a execução corrente do job terminar (ou pausar) e devolve o registro final. */
  async waitForJob(jobId: string): Promise<JobRecord> {
    const run = this.active.get(jobId);
    if (run !== undefined) {
      return run.promise;
    }
    return this.store.getJobOrThrow(jobId);
  }

  private launch(jobId: string, options?: StartJobOptions): void {
    const controller = new AbortController();
    const promise = this.runner
      .run(jobId, {
        signal: controller.signal,
        ...(options?.enabledPhases !== undefined ? { enabledPhases: options.enabledPhases } : {}),
      })
      .catch((err: unknown) => {
        const job = this.store.getJobOrThrow(jobId);
        if (job.state === "running") {
          return this.store.transition(jobId, "failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return job;
      })
      .finally(() => {
        this.active.delete(jobId);
      });
    this.active.set(jobId, { controller, promise });
  }
}

export function createJobService(options: JobServiceOptions): CleanroomJobService {
  return new CleanroomJobService(options);
}
