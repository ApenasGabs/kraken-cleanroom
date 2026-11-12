import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CleanroomJobService,
  DEFAULT_PHASE_ORDER,
  JobBlockedError,
  JobConflictError,
  ManifestError,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
  type SqliteDatabase,
  assertJobTransition,
  canTransitionJob,
  createCleanroomJobId,
  createJobService,
  isTerminalJobState,
  openDatabase,
} from "./index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const MANIFEST_YAML = readFileSync(
  resolve(here, "../../../examples/demo-app.cleanroom.yaml"),
  "utf8",
);

type Behavior = (ctx: PhaseContext, call: number) => Promise<PhaseResult> | PhaseResult;

interface FakePhase extends Phase {
  calls: number;
  checkpoints: unknown[];
}

function fakePhase(id: PhaseId, behavior?: Behavior): FakePhase {
  const phase: FakePhase = {
    id,
    calls: 0,
    checkpoints: [],
    async run(ctx) {
      phase.calls += 1;
      phase.checkpoints.push(ctx.checkpoint);
      if (behavior !== undefined) {
        return behavior(ctx, phase.calls);
      }
      return { status: "ok", stats: { items: 1 } };
    },
  };
  return phase;
}

function fakePipeline(overrides: Partial<Record<PhaseId, Behavior>> = {}): FakePhase[] {
  return DEFAULT_PHASE_ORDER.map((id) => fakePhase(id, overrides[id]));
}

function byId(phases: FakePhase[], id: PhaseId): FakePhase {
  const phase = phases.find((p) => p.id === id);
  if (phase === undefined) {
    throw new Error(`fase ${id} ausente`);
  }
  return phase;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("job state machine", () => {
  it("allows only the transitions from docs/02 §4", () => {
    expect(canTransitionJob("created", "validating_manifest")).toBe(true);
    expect(canTransitionJob("validating_manifest", "rejected")).toBe(true);
    expect(canTransitionJob("validating_manifest", "running")).toBe(true);
    expect(canTransitionJob("running", "awaiting_human")).toBe(true);
    expect(canTransitionJob("awaiting_human", "running")).toBe(true);
    expect(canTransitionJob("awaiting_human", "cancelled")).toBe(true);
    expect(canTransitionJob("running", "completed")).toBe(true);
    expect(canTransitionJob("created", "running")).toBe(false);
    expect(canTransitionJob("completed", "running")).toBe(false);
    expect(canTransitionJob("failed", "running")).toBe(false);
    expect(() => assertJobTransition("rejected", "running", "cr-x")).toThrow(JobConflictError);
    expect(isTerminalJobState("completed")).toBe(true);
    expect(isTerminalJobState("awaiting_human")).toBe(false);
  });

  it("creates jobIds following the glossary format", () => {
    const id = createCleanroomJobId("demo-app-local", new Date("2026-11-12T10:00:00Z"));
    expect(id).toMatch(/^cr-20261112-demo-app-local-[a-z0-9]{4}$/);
    expect(createCleanroomJobId("Weird Name!!")).toMatch(/^cr-\d{8}-weird-name-[a-z0-9]{4}$/);
  });
});

describe("JobService + JobRunner", () => {
  let dataDir: string;
  let db: SqliteDatabase;
  const extraDbs: SqliteDatabase[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cleanroom-jobs-"));
    db = openDatabase({ dataDir });
  });

  afterEach(() => {
    for (const extra of extraDbs.splice(0)) {
      if (extra.open) extra.close();
    }
    if (db.open) db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function service(phases: Phase[], timeoutMs?: number): CleanroomJobService {
    return createJobService({ db, dataDir, phases, timeoutMs });
  }

  it("runs every phase in order and reaches completed (ok)", async () => {
    const order: PhaseId[] = [];
    const phases = DEFAULT_PHASE_ORDER.map((id) =>
      fakePhase(id, (ctx) => {
        order.push(id);
        ctx.emit({ type: "progress", data: { id } });
        return { status: "ok", stats: { n: order.length } };
      }),
    );
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    expect(jobId).toMatch(/^cr-\d{8}-demo-app-local-[a-z0-9]{4}$/);

    const job = await svc.waitForJob(jobId);
    expect(job.state).toBe("completed");
    expect(order).toEqual([...DEFAULT_PHASE_ORDER]);

    const status = await svc.status(jobId);
    expect(status.phases.map((p) => p.status)).toEqual(DEFAULT_PHASE_ORDER.map(() => "done"));
    expect(status.phases[0]?.stats).toEqual({ n: 1 });
    expect(status.counters).toEqual({ pages: 0, evidence: 0, findings: 0, rules: 0 });

    const transitions = svc.store
      .listEvents(jobId)
      .filter((e) => e.type === "state_changed")
      .map((e) => e.data?.to);
    expect(transitions).toEqual(["validating_manifest", "running", "completed"]);

    const jobDir = join(dataDir, "jobs", jobId);
    expect(readFileSync(join(jobDir, "manifest.yaml"), "utf8")).toBe(MANIFEST_YAML);
    const snapshot = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
    expect(snapshot.state).toBe("completed");
    expect(snapshot.phases).toHaveLength(DEFAULT_PHASE_ORDER.length);
    const ndjson = readFileSync(join(jobDir, "logs", "job.ndjson"), "utf8")
      .trim()
      .split("\n");
    expect(ndjson.some((line) => JSON.parse(line).type === "progress")).toBe(true);

    const list = await svc.list();
    expect(list.map((j) => j.jobId)).toContain(jobId);
    expect((await svc.list({ state: "running" })).length).toBe(0);
  });

  it("skips phases disabled by start options or by the manifest", async () => {
    const phases = fakePipeline();
    byId(phases, "explore").isEnabled = (manifest) => !manifest.methods.behavioralUi;
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML, {
      enabledPhases: ["intake", "explore", "capture"],
    });
    expect((await svc.waitForJob(jobId)).state).toBe("completed");
    const status = await svc.status(jobId);
    const map = Object.fromEntries(status.phases.map((p) => [p.id, p.status]));
    expect(map).toMatchObject({
      intake: "done",
      explore: "skipped",
      capture: "done",
      analyze: "skipped",
      report: "skipped",
    });
    expect(byId(phases, "explore").calls).toBe(0);
  });

  it("rejects an invalid manifest without running phases", async () => {
    const phases = fakePipeline();
    const svc = service(phases);
    const invalid = MANIFEST_YAML.replace("tosReviewed: true", "tosReviewed: maybe");
    await expect(svc.start(invalid)).rejects.toBeInstanceOf(ManifestError);
    const [rejected] = await svc.list({ state: "rejected" });
    expect(rejected?.error).toContain("tosReviewed");
    expect(phases.every((p) => p.calls === 0)).toBe(true);
    expect((await svc.validateManifest(invalid)).ok).toBe(false);
    expect((await svc.validateManifest(MANIFEST_YAML)).ok).toBe(true);
  });

  it("pauses on awaiting_human and resumes after the handoff is resolved", async () => {
    const phases = fakePipeline({
      explore: (ctx, call) => {
        if (call === 1) {
          ctx.saveCheckpoint({ visited: 3 });
          return {
            status: "awaiting_human",
            handoff: { kind: "captcha", message: "Resolva o desafio.", timeoutMin: 15 },
          };
        }
        return { status: "ok", stats: { visited: 5 } };
      },
    });
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    expect((await svc.waitForJob(jobId)).state).toBe("awaiting_human");

    const paused = await svc.status(jobId);
    expect(paused.currentPhase).toBe("explore");
    expect(paused.pendingHandoff?.kind).toBe("captcha");
    await expect(svc.resume(jobId)).rejects.toBeInstanceOf(JobConflictError);

    const handoffId = paused.pendingHandoff?.id ?? "";
    await svc.resolveHandoff(jobId, handoffId, "feito");
    expect((await svc.waitForJob(jobId)).state).toBe("completed");

    expect(byId(phases, "intake").calls).toBe(1);
    expect(byId(phases, "explore").calls).toBe(2);
    expect(byId(phases, "explore").checkpoints).toEqual([undefined, { visited: 3 }]);
    expect((await svc.status(jobId)).pendingHandoff).toBeUndefined();
  });

  it("goes to blocked when a phase returns blocked or throws JobBlockedError", async () => {
    const viaResult = fakePipeline({
      explore: () => ({ status: "blocked", reason: "alvo respondeu 403" }),
    });
    let svc = service(viaResult);
    let { jobId } = await svc.start(MANIFEST_YAML);
    let job = await svc.waitForJob(jobId);
    expect(job.state).toBe("blocked");
    expect(job.error).toBe("alvo respondeu 403");
    expect(byId(viaResult, "capture").calls).toBe(0);

    const viaThrow = fakePipeline({
      intake: () => {
        throw new JobBlockedError("anti-bot detectado");
      },
    });
    svc = service(viaThrow);
    ({ jobId } = await svc.start(MANIFEST_YAML));
    job = await svc.waitForJob(jobId);
    expect(job.state).toBe("blocked");
    expect(job.error).toBe("anti-bot detectado");
  });

  it("goes to failed on an unexpected error and stops the pipeline", async () => {
    const phases = fakePipeline({
      analyze: () => {
        throw new Error("boom");
      },
    });
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    const job = await svc.waitForJob(jobId);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("boom");
    const status = await svc.status(jobId);
    const map = Object.fromEntries(status.phases.map((p) => [p.id, p.status]));
    expect(map).toMatchObject({ capture: "done", analyze: "failed", synthesize: "pending" });
    await expect(svc.resume(jobId)).rejects.toBeInstanceOf(JobConflictError);
  });

  it("cancels a running job through the AbortSignal", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => {
      started = r;
    });
    const phases = fakePipeline({
      explore: (ctx) => {
        ctx.saveCheckpoint({ step: 1 });
        started();
        return waitForAbort(ctx.signal);
      },
    });
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    await startedPromise;
    await svc.cancel(jobId, "parar");

    const job = svc.store.getJobOrThrow(jobId);
    expect(job.state).toBe("cancelled");
    expect(job.error).toBe("parar");
    expect(svc.store.getPhase(jobId, "explore")?.status).toBe("pending");
    expect(byId(phases, "capture").calls).toBe(0);
    await expect(svc.cancel(jobId)).rejects.toBeInstanceOf(JobConflictError);
  });

  it("cancels a job paused on awaiting_human", async () => {
    const phases = fakePipeline({
      intake: () => ({
        status: "awaiting_human",
        handoff: { kind: "sms_otp", message: "Informe o código.", timeoutMin: 5 },
      }),
    });
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    await svc.waitForJob(jobId);
    await svc.cancel(jobId);
    expect(svc.store.getJobOrThrow(jobId).state).toBe("cancelled");
    expect(svc.store.getPendingHandoff(jobId)).toBeNull();
  });

  it("fails the job when the global timeout aborts the signal", async () => {
    const phases = fakePipeline({
      capture: (ctx) => waitForAbort(ctx.signal),
    });
    const svc = service(phases, 50);
    const { jobId } = await svc.start(MANIFEST_YAML);
    const job = await svc.waitForJob(jobId);
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/Timeout global/);
    expect(svc.store.getPhase(jobId, "capture")?.status).toBe("failed");
    expect(svc.store.listEvents(jobId).some((e) => e.type === "job_timeout")).toBe(true);
  });

  it("resumes from the checkpoint after a crash without re-running done phases", async () => {
    // 1º processo: grava checkpoint em `capture` e "morre" (a fase nunca termina).
    let checkpointSaved!: () => void;
    const saved = new Promise<void>((r) => {
      checkpointSaved = r;
    });
    const firstRun = fakePipeline({
      capture: (ctx) => {
        ctx.saveCheckpoint({ processed: 2 });
        checkpointSaved();
        return new Promise<PhaseResult>(() => undefined);
      },
    });
    const crashed = service(firstRun);
    const { jobId } = await crashed.start(MANIFEST_YAML);
    await saved;
    expect(crashed.store.getJobOrThrow(jobId).state).toBe("running");

    // 2º processo: nova conexão com o mesmo banco, novo runner.
    const db2 = openDatabase({ dataDir });
    extraDbs.push(db2);
    const secondRun = fakePipeline({
      capture: (ctx) => {
        const cp = ctx.checkpoint as { processed: number };
        return { status: "ok", stats: { processed: cp.processed + 3 } };
      },
    });
    const restarted = createJobService({ db: db2, dataDir, phases: secondRun });
    expect(await restarted.recoverInterrupted()).toEqual([jobId]);
    const job = await restarted.waitForJob(jobId);

    expect(job.state).toBe("completed");
    expect(byId(secondRun, "intake").calls).toBe(0);
    expect(byId(secondRun, "explore").calls).toBe(0);
    expect(byId(secondRun, "capture").checkpoints).toEqual([{ processed: 2 }]);
    for (const id of ["analyze", "synthesize", "validate", "report"] as const) {
      expect(byId(secondRun, id).calls).toBe(1);
    }
    const status = await restarted.status(jobId);
    expect(status.phases.find((p) => p.id === "capture")?.stats).toEqual({ processed: 5 });
    expect(restarted.store.listEvents(jobId).some((e) => e.type === "job_recovered")).toBe(true);
    expect(existsSync(join(dataDir, "jobs", jobId, "job.json"))).toBe(true);
  });

  it("exposes evidence/rules/report contracts", async () => {
    const phases = fakePipeline({
      intake: (ctx) => {
        ctx.evidence.put({
          jobId: ctx.job.id,
          kind: "state",
          phase: "intake",
          summary: "home",
          data: { url: "/" },
        });
        return { status: "ok", stats: {} };
      },
    });
    const svc = service(phases);
    const { jobId } = await svc.start(MANIFEST_YAML);
    await svc.waitForJob(jobId);

    const page = await svc.listEvidence(jobId, { kind: "state" });
    expect(page.items).toHaveLength(1);
    const evidenceId = page.items[0]?.id ?? "";
    expect((await svc.getEvidence(jobId, evidenceId)).summary).toBe("home");
    expect((await svc.status(jobId)).counters.pages).toBe(1);
    expect(await svc.listRules(jobId)).toEqual([]);
    await expect(svc.getReport(jobId, "markdown")).rejects.toBeInstanceOf(JobConflictError);
    expect(await svc.initManifest("https://demo.playwright.dev/todomvc")).toContain("version: 1");
  });
});
