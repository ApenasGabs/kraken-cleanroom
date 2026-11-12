import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SqliteDatabase } from "./db.js";
import { JobNotFoundError } from "./errors.js";
import { assertJobTransition } from "./job-state.js";
import type { Manifest } from "./manifest.js";
import type {
  HandoffKind,
  HandoffRecord,
  HandoffRequest,
  HandoffStatus,
  JobEvent,
  JobRecord,
  JobState,
  PhaseId,
  PhaseRecord,
  PhaseStatus,
  StoredJobEvent,
} from "./types/index.js";

interface JobRow {
  id: string;
  name: string;
  state: string;
  manifest_json: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
}

interface PhaseRow {
  job_id: string;
  phase: string;
  status: string;
  checkpoint_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  stats_json: string | null;
}

interface HandoffRow {
  id: string;
  job_id: string;
  kind: string;
  status: string;
  message: string;
  live_url: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface EventRow {
  id: number;
  job_id: string;
  ts: string;
  phase: string | null;
  type: string;
  data_json: string | null;
}

export interface JobStoreOptions {
  db: SqliteDatabase;
  dataDir: string;
  now?: (() => Date) | undefined;
}

export interface CreateJobInput {
  id: string;
  name: string;
  manifest: Manifest | Record<string, unknown>;
  manifestYaml: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null) {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    name: row.name,
    state: row.state as JobState,
    manifest: JSON.parse(row.manifest_json) as Manifest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error !== null ? { error: row.error } : {}),
    llmTokensIn: row.llm_tokens_in ?? 0,
    llmTokensOut: row.llm_tokens_out ?? 0,
  };
}

function rowToPhase(row: PhaseRow): PhaseRecord {
  const checkpoint = parseJson<unknown>(row.checkpoint_json);
  const stats = parseJson<Record<string, number>>(row.stats_json);
  return {
    jobId: row.job_id,
    phase: row.phase as PhaseId,
    status: row.status as PhaseStatus,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(stats !== undefined ? { stats } : {}),
  };
}

function rowToHandoff(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind as HandoffKind,
    status: row.status as HandoffStatus,
    message: row.message,
    ...(row.live_url !== null ? { liveUrl: row.live_url } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

/**
 * Persistência de jobs, fases, handoffs e eventos (SQLite) + espelhos em disco
 * (`jobs/<jobId>/job.json`, `manifest.yaml`, `logs/job.ndjson`).
 */
export class JobStore {
  readonly db: SqliteDatabase;
  readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: JobStoreOptions) {
    this.db = options.db;
    this.dataDir = resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  resolveJobDir(jobId: string): string {
    if (!SAFE_SEGMENT.test(jobId) || jobId === "." || jobId === "..") {
      throw new Error(`jobId inválido: ${jobId}`);
    }
    const root = resolve(this.dataDir, "jobs");
    const dir = resolve(root, jobId);
    if (!dir.startsWith(`${root}${sep}`)) {
      throw new Error(`Diretório de job fora do escopo permitido: ${jobId}`);
    }
    return dir;
  }

  resolveLogPath(jobId: string): string {
    return join(this.resolveJobDir(jobId), "logs", "job.ndjson");
  }

  createJob(input: CreateJobInput): JobRecord {
    const ts = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, state, manifest_json, created_at, updated_at)
         VALUES (?, ?, 'created', ?, ?, ?)`,
      )
      .run(input.id, input.name, JSON.stringify(input.manifest), ts, ts);
    const jobDir = this.resolveJobDir(input.id);
    mkdirSync(join(jobDir, "logs"), { recursive: true });
    // Cópia imutável do manifesto como recebido (docs/02 §5).
    writeFileSync(join(jobDir, "manifest.yaml"), input.manifestYaml, { flag: "wx" });
    this.appendEvent(input.id, { type: "job_created", data: { name: input.name } });
    this.writeSnapshot(input.id);
    return this.getJobOrThrow(input.id);
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row !== undefined ? rowToJob(row) : null;
  }

  getJobOrThrow(jobId: string): JobRecord {
    const job = this.getJob(jobId);
    if (job === null) {
      throw new JobNotFoundError(`Job não encontrado: ${jobId}`, { jobId });
    }
    return job;
  }

  listJobs(filter?: { state?: JobState | undefined; limit?: number | undefined }): JobRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(filter?.limit ?? 50)));
    const rows = (
      filter?.state !== undefined
        ? this.db
            .prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ?")
            .all(filter.state, limit)
        : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
    ) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Valida e aplica uma transição de estado; registra evento e atualiza `job.json`. */
  transition(
    jobId: string,
    to: JobState,
    options?: { error?: string | undefined; manifest?: Manifest | undefined },
  ): JobRecord {
    const job = this.getJobOrThrow(jobId);
    assertJobTransition(job.state, to, jobId);
    const ts = this.timestamp();
    const sets = ["state = ?", "updated_at = ?"];
    const params: unknown[] = [to, ts];
    if (options?.error !== undefined) {
      sets.push("error = ?");
      params.push(options.error);
    }
    if (options?.manifest !== undefined) {
      sets.push("manifest_json = ?");
      params.push(JSON.stringify(options.manifest));
    }
    params.push(jobId);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.appendEvent(jobId, {
      type: "state_changed",
      data: {
        from: job.state,
        to,
        ...(options?.error !== undefined ? { error: options.error } : {}),
      },
    });
    this.writeSnapshot(jobId);
    return this.getJobOrThrow(jobId);
  }

  touch(jobId: string): void {
    this.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(this.timestamp(), jobId);
  }

  // ---------------------------------------------------------------- phases

  listPhases(jobId: string): PhaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM phases WHERE job_id = ? ORDER BY rowid")
      .all(jobId) as PhaseRow[];
    return rows.map(rowToPhase);
  }

  getPhase(jobId: string, phase: PhaseId): PhaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM phases WHERE job_id = ? AND phase = ?")
      .get(jobId, phase) as PhaseRow | undefined;
    return row !== undefined ? rowToPhase(row) : null;
  }

  /** Garante as linhas de `phases` na ordem de execução (status `pending`). */
  ensurePhases(jobId: string, phases: readonly PhaseId[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO phases (job_id, phase, status) VALUES (?, ?, 'pending')",
    );
    this.db.transaction(() => {
      for (const phase of phases) {
        insert.run(jobId, phase);
      }
    })();
  }

  setPhaseStatus(
    jobId: string,
    phase: PhaseId,
    status: PhaseStatus,
    stats?: Record<string, number> | undefined,
  ): void {
    const ts = this.timestamp();
    const sets = ["status = ?"];
    const params: unknown[] = [status];
    if (status === "running") {
      sets.push("started_at = COALESCE(started_at, ?)");
      params.push(ts);
    }
    if (status === "done" || status === "failed" || status === "skipped") {
      sets.push("finished_at = ?");
      params.push(ts);
    }
    if (stats !== undefined) {
      sets.push("stats_json = ?");
      params.push(JSON.stringify(stats));
    }
    params.push(jobId, phase);
    this.db
      .prepare(`UPDATE phases SET ${sets.join(", ")} WHERE job_id = ? AND phase = ?`)
      .run(...params);
    this.touch(jobId);
    this.writeSnapshot(jobId);
  }

  saveCheckpoint(jobId: string, phase: PhaseId, checkpoint: unknown): void {
    this.db
      .prepare("UPDATE phases SET checkpoint_json = ? WHERE job_id = ? AND phase = ?")
      .run(JSON.stringify(checkpoint ?? null), jobId, phase);
    this.touch(jobId);
  }

  // -------------------------------------------------------------- handoffs

  createHandoff(jobId: string, id: string, request: HandoffRequest): HandoffRecord {
    this.db
      .prepare(
        `INSERT INTO handoffs (id, job_id, kind, status, message, live_url, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, jobId, request.kind, request.message, request.liveUrl ?? null, this.timestamp());
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow;
    return rowToHandoff(row);
  }

  getHandoff(jobId: string, handoffId: string): HandoffRecord | null {
    const row = this.db
      .prepare("SELECT * FROM handoffs WHERE job_id = ? AND id = ?")
      .get(jobId, handoffId) as HandoffRow | undefined;
    return row !== undefined ? rowToHandoff(row) : null;
  }

  getPendingHandoff(jobId: string): HandoffRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM handoffs WHERE job_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(jobId) as HandoffRow | undefined;
    return row !== undefined ? rowToHandoff(row) : null;
  }

  closeHandoffs(
    jobId: string,
    status: Exclude<HandoffStatus, "pending">,
    handoffId?: string,
  ): void {
    const ts = this.timestamp();
    if (handoffId !== undefined) {
      this.db
        .prepare(
          "UPDATE handoffs SET status = ?, resolved_at = ? WHERE job_id = ? AND id = ? AND status = 'pending'",
        )
        .run(status, ts, jobId, handoffId);
      return;
    }
    this.db
      .prepare(
        "UPDATE handoffs SET status = ?, resolved_at = ? WHERE job_id = ? AND status = 'pending'",
      )
      .run(status, ts, jobId);
  }

  // ---------------------------------------------------------------- events

  /** Grava evento em `events` e espelha em `logs/job.ndjson`. */
  appendEvent(jobId: string, event: JobEvent): StoredJobEvent {
    const ts = this.timestamp();
    const dataJson = event.data !== undefined ? JSON.stringify(event.data) : null;
    const info = this.db
      .prepare("INSERT INTO events (job_id, ts, phase, type, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, ts, event.phase ?? null, event.type, dataJson);
    const stored: StoredJobEvent = {
      id: Number(info.lastInsertRowid),
      jobId,
      ts,
      type: event.type,
      ...(event.phase !== undefined ? { phase: event.phase } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    };
    const logPath = this.resolveLogPath(jobId);
    mkdirSync(join(this.resolveJobDir(jobId), "logs"), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ level: "event", ...stored })}\n`);
    return stored;
  }

  listEvents(jobId: string): StoredJobEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id")
      .all(jobId) as EventRow[];
    return rows.map((row) => {
      const data = parseJson<Record<string, unknown>>(row.data_json);
      return {
        id: row.id,
        jobId: row.job_id,
        ts: row.ts,
        type: row.type,
        ...(row.phase !== null ? { phase: row.phase as PhaseId } : {}),
        ...(data !== undefined ? { data } : {}),
      };
    });
  }

  // -------------------------------------------------------------- snapshot

  /** Espelho do estado do job em `jobs/<jobId>/job.json`. */
  writeSnapshot(jobId: string): void {
    const job = this.getJob(jobId);
    if (job === null) {
      return;
    }
    const jobDir = this.resolveJobDir(jobId);
    mkdirSync(jobDir, { recursive: true });
    const snapshot = {
      id: job.id,
      name: job.name,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.error !== undefined ? { error: job.error } : {}),
      llm: { tokensIn: job.llmTokensIn, tokensOut: job.llmTokensOut },
      phases: this.listPhases(jobId).map((p) => ({
        id: p.phase,
        status: p.status,
        ...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}),
        ...(p.finishedAt !== undefined ? { finishedAt: p.finishedAt } : {}),
        ...(p.stats !== undefined ? { stats: p.stats } : {}),
      })),
    };
    writeFileSync(join(jobDir, "job.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}
