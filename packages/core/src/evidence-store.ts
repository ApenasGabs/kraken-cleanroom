import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import type { SqliteDatabase } from "./db.js";
import { EvidenceNotFoundError } from "./errors.js";
import { createEvidenceId } from "./ids.js";
import type { Evidence, EvidenceKind, Page, PhaseId } from "./types/index.js";

const MAX_SUMMARY_LENGTH = 300;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9._-]+$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

interface DefaultBlobLocation {
  subdir: string;
  ext: string;
}

const DEFAULT_BLOB_LOCATION_BY_KIND: Record<EvidenceKind, DefaultBlobLocation> = {
  http_response: { subdir: "network", ext: "json" },
  robots: { subdir: "intake", ext: "txt" },
  tech_signature: { subdir: "intake", ext: "json" },
  screenshot: { subdir: "screenshots", ext: "png" },
  dom_snapshot: { subdir: "dom", ext: "html" },
  a11y_snapshot: { subdir: "a11y", ext: "json" },
  state: { subdir: "states", ext: "json" },
  transition: { subdir: "states", ext: "json" },
  form_schema: { subdir: "forms", ext: "json" },
  form_probe: { subdir: "forms", ext: "json" },
  network_call: { subdir: "network", ext: "json" },
  doc_section: { subdir: "docs", ext: "md" },
  pricing_plan: { subdir: "docs", ext: "json" },
  bundle_route: { subdir: "bundles", ext: "json" },
  bundle_string: { subdir: "bundles", ext: "json" },
  feature_flag: { subdir: "bundles", ext: "json" },
  email_received: { subdir: "inbox", ext: "json" },
  validation_run: { subdir: "validation", ext: "json" },
};

export interface EvidenceStoreOptions {
  db: SqliteDatabase;
  dataDir: string;
}

export interface PutEvidenceInput {
  id?: string | undefined;
  jobId: string;
  kind: EvidenceKind;
  phase: PhaseId;
  sha256?: string | undefined;
  blob?: Buffer | Uint8Array | string | undefined;
  blobExt?: string | undefined;
  blobSubdir?: string | undefined;
  url?: string | undefined;
  stateId?: string | undefined;
  summary: string;
  data?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}

export interface PutEvidenceResult {
  evidence: Evidence;
  deduplicated: boolean;
}

export interface ListEvidenceFilter {
  kind?: EvidenceKind | undefined;
  phase?: PhaseId | undefined;
  stateId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListEvidenceOptions extends ListEvidenceFilter {
  jobId: string;
}

interface EvidenceRow {
  rowid?: number;
  id: string;
  job_id: string;
  kind: EvidenceKind;
  phase: PhaseId;
  sha256: string;
  blob_path: string | null;
  url: string | null;
  state_id: string | null;
  summary: string;
  data_json: string;
  created_at: string;
}

interface DecodedCursor {
  r: number;
  id: string;
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const propVal = record[key];
      if (propVal !== undefined) {
        result[key] = sortCanonicalValue(propVal);
      }
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function computeSha256(content: Buffer | Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

export function normalizeEvidenceSummary(summary: string): string {
  const collapsed = summary.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_SUMMARY_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function toBuffer(blob: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(blob)) {
    return blob;
  }
  if (typeof blob === "string") {
    return Buffer.from(blob, "utf8");
  }
  return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
}

function assertSafeSegment(segment: string, label: string): string {
  const trimmed = segment.trim().replace(/^\.+/, "");
  if (!trimmed || !SAFE_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Segmento de caminho inválido para ${label}: "${segment}"`);
  }
  return trimmed;
}

function encodeCursor(rowid: number, id: string): string {
  const payload: DecodedCursor = { r: rowid, id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function tryDecodeCursorToken(cursor: string): DecodedCursor | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "r" in parsed &&
      "id" in parsed &&
      typeof (parsed as { r: unknown }).r === "number" &&
      Number.isInteger((parsed as { r: number }).r) &&
      (parsed as { r: number }).r > 0 &&
      typeof (parsed as { id: unknown }).id === "string"
    ) {
      return {
        r: (parsed as { r: number }).r,
        id: (parsed as { id: string }).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function mapRowToEvidence(row: EvidenceRow): Evidence {
  let parsedData: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(row.data_json);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      parsedData = raw as Record<string, unknown>;
    }
  } catch {
    parsedData = {};
  }

  const evidence: Evidence = {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    phase: row.phase,
    sha256: row.sha256,
    summary: row.summary,
    data: parsedData,
    createdAt: row.created_at,
  };

  if (row.blob_path !== null) {
    evidence.blobPath = row.blob_path;
  }
  if (row.url !== null) {
    evidence.url = row.url;
  }
  if (row.state_id !== null) {
    evidence.stateId = row.state_id;
  }

  return evidence;
}

export class EvidenceStore {
  private readonly db: SqliteDatabase;
  private readonly dataDir: string;

  constructor(options: EvidenceStoreOptions) {
    this.db = options.db;
    this.dataDir = resolve(options.dataDir);
  }

  resolveJobDir(jobId: string): string {
    const safeJobId = assertSafeSegment(jobId, "jobId");
    const jobsRoot = resolve(this.dataDir, "jobs");
    const jobDir = resolve(jobsRoot, safeJobId);
    if (!jobDir.startsWith(`${jobsRoot}${sep}`)) {
      throw new Error(`Diretório de job fora do escopo permitido: ${jobId}`);
    }
    return jobDir;
  }

  resolveBlobDiskPath(jobId: string, relativeBlobPath: string): string {
    const jobDir = this.resolveJobDir(jobId);
    const fullPath = resolve(jobDir, relativeBlobPath);
    if (!fullPath.startsWith(`${jobDir}${sep}`)) {
      throw new Error(`Caminho de blob fora do diretório do job: ${relativeBlobPath}`);
    }
    return fullPath;
  }

  private ensureJobRecord(jobId: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, name, state, manifest_json, created_at, updated_at)
         VALUES (?, ?, 'running', '{}', ?, ?)`,
      )
      .run(jobId, jobId, nowIso, nowIso);
  }

  private writeBlobFile(
    jobId: string,
    kind: EvidenceKind,
    blob: Buffer | Uint8Array | string,
    blobSha256: string,
    customSubdir?: string | undefined,
    customExt?: string | undefined,
  ): string {
    const defaults = DEFAULT_BLOB_LOCATION_BY_KIND[kind];
    const subdir = assertSafeSegment(customSubdir ?? defaults.subdir, "blobSubdir");
    const ext = assertSafeSegment(customExt ?? defaults.ext, "blobExt");
    const relativeBlobPath = posix.join("evidence", subdir, `${blobSha256}.${ext}`);
    const fullDiskPath = this.resolveBlobDiskPath(jobId, relativeBlobPath);

    if (!existsSync(fullDiskPath)) {
      mkdirSync(dirname(fullDiskPath), { recursive: true });
      writeFileSync(fullDiskPath, toBuffer(blob));
    }

    return relativeBlobPath;
  }

  putWithResult(input: PutEvidenceInput): PutEvidenceResult {
    const jobId = assertSafeSegment(input.jobId, "jobId");
    const summary = normalizeEvidenceSummary(input.summary);
    const data = input.data ?? {};
    const createdAt = input.createdAt ?? new Date().toISOString();

    const blobBuffer = input.blob !== undefined ? toBuffer(input.blob) : undefined;
    const blobSha256 = blobBuffer !== undefined ? computeSha256(blobBuffer) : undefined;

    let sha256: string;
    if (input.sha256 !== undefined && input.sha256.trim().length > 0) {
      const candidate = input.sha256.trim().toLowerCase();
      sha256 = SHA256_HEX_REGEX.test(candidate) ? candidate : computeSha256(candidate);
    } else if (blobSha256 !== undefined) {
      sha256 = blobSha256;
    } else {
      sha256 = computeSha256(
        canonicalJson({
          kind: input.kind,
          url: input.url ?? null,
          stateId: input.stateId ?? null,
          summary,
          data,
        }),
      );
    }

    const tx = this.db.transaction((): PutEvidenceResult => {
      this.ensureJobRecord(jobId, createdAt);

      const existingRow = this.db
        .prepare(
          `SELECT id, job_id, kind, phase, sha256, blob_path, url, state_id, summary, data_json, created_at
           FROM evidence
           WHERE job_id = ? AND kind = ? AND sha256 = ?`,
        )
        .get(jobId, input.kind, sha256) as EvidenceRow | undefined;

      if (existingRow !== undefined) {
        if (blobBuffer !== undefined && blobSha256 !== undefined) {
          const targetBlobPath =
            existingRow.blob_path ??
            this.writeBlobFile(
              jobId,
              input.kind,
              blobBuffer,
              blobSha256,
              input.blobSubdir,
              input.blobExt,
            );

          const fullExistingPath = this.resolveBlobDiskPath(jobId, targetBlobPath);
          if (!existsSync(fullExistingPath)) {
            mkdirSync(dirname(fullExistingPath), { recursive: true });
            writeFileSync(fullExistingPath, blobBuffer);
          }

          if (existingRow.blob_path === null) {
            this.db
              .prepare("UPDATE evidence SET blob_path = ? WHERE id = ?")
              .run(targetBlobPath, existingRow.id);
            existingRow.blob_path = targetBlobPath;
          }
        }

        return {
          evidence: mapRowToEvidence(existingRow),
          deduplicated: true,
        };
      }

      const id = input.id ?? createEvidenceId();
      const blobPath =
        blobBuffer !== undefined && blobSha256 !== undefined
          ? this.writeBlobFile(
              jobId,
              input.kind,
              blobBuffer,
              blobSha256,
              input.blobSubdir,
              input.blobExt,
            )
          : null;

      const dataJson = canonicalJson(data);

      this.db
        .prepare(
          `INSERT INTO evidence (
            id, job_id, kind, phase, sha256, blob_path, url, state_id, summary, data_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          jobId,
          input.kind,
          input.phase,
          sha256,
          blobPath,
          input.url ?? null,
          input.stateId ?? null,
          summary,
          dataJson,
          createdAt,
        );

      const insertedRow: EvidenceRow = {
        id,
        job_id: jobId,
        kind: input.kind,
        phase: input.phase,
        sha256,
        blob_path: blobPath,
        url: input.url ?? null,
        state_id: input.stateId ?? null,
        summary,
        data_json: dataJson,
        created_at: createdAt,
      };

      return {
        evidence: mapRowToEvidence(insertedRow),
        deduplicated: false,
      };
    });

    return tx();
  }

  put(input: PutEvidenceInput): Evidence {
    return this.putWithResult(input).evidence;
  }

  get(evidenceId: string): Evidence | null;
  get(jobId: string, evidenceId: string): Evidence | null;
  get(jobIdOrEvidenceId: string, maybeEvidenceId?: string | undefined): Evidence | null {
    let row: EvidenceRow | undefined;
    if (maybeEvidenceId === undefined) {
      row = this.db
        .prepare(
          `SELECT id, job_id, kind, phase, sha256, blob_path, url, state_id, summary, data_json, created_at
           FROM evidence
           WHERE id = ?`,
        )
        .get(jobIdOrEvidenceId) as EvidenceRow | undefined;
    } else {
      row = this.db
        .prepare(
          `SELECT id, job_id, kind, phase, sha256, blob_path, url, state_id, summary, data_json, created_at
           FROM evidence
           WHERE job_id = ? AND id = ?`,
        )
        .get(jobIdOrEvidenceId, maybeEvidenceId) as EvidenceRow | undefined;
    }

    return row !== undefined ? mapRowToEvidence(row) : null;
  }

  getOrThrow(evidenceId: string): Evidence;
  getOrThrow(jobId: string, evidenceId: string): Evidence;
  getOrThrow(jobIdOrEvidenceId: string, maybeEvidenceId?: string | undefined): Evidence {
    const found =
      maybeEvidenceId !== undefined
        ? this.get(jobIdOrEvidenceId, maybeEvidenceId)
        : this.get(jobIdOrEvidenceId);
    if (found === null) {
      const targetId = maybeEvidenceId ?? jobIdOrEvidenceId;
      throw new EvidenceNotFoundError(`Evidência não encontrada: ${targetId}`, {
        evidenceId: targetId,
      });
    }
    return found;
  }

  readBlob(jobId: string, evidenceIdOrBlobPath: string): Buffer | null {
    const byId = this.get(jobId, evidenceIdOrBlobPath);
    const relativeBlobPath =
      byId !== null
        ? byId.blobPath
        : evidenceIdOrBlobPath.startsWith("evidence/")
          ? evidenceIdOrBlobPath
          : undefined;

    if (relativeBlobPath === undefined) {
      return null;
    }

    const fullPath = this.resolveBlobDiskPath(jobId, relativeBlobPath);
    if (!existsSync(fullPath)) {
      return null;
    }
    return readFileSync(fullPath);
  }

  private resolveCursorRowid(jobId: string, cursor: string): number {
    const decoded = tryDecodeCursorToken(cursor);
    if (decoded !== null) {
      const verified = this.db
        .prepare("SELECT rowid FROM evidence WHERE job_id = ? AND id = ?")
        .get(jobId, decoded.id) as { rowid: number } | undefined;
      return verified !== undefined ? verified.rowid : decoded.r;
    }

    const byId = this.db
      .prepare("SELECT rowid FROM evidence WHERE job_id = ? AND id = ?")
      .get(jobId, cursor) as { rowid: number } | undefined;

    if (byId !== undefined) {
      return byId.rowid;
    }

    throw new Error(`Cursor de paginação inválido para o job "${jobId}": ${cursor}`);
  }

  list(options: ListEvidenceOptions): Page<Evidence>;
  list(jobId: string, filter?: ListEvidenceFilter | undefined): Page<Evidence>;
  list(
    jobIdOrOptions: string | ListEvidenceOptions,
    maybeFilter?: ListEvidenceFilter | undefined,
  ): Page<Evidence> {
    const jobId = typeof jobIdOrOptions === "string" ? jobIdOrOptions : jobIdOrOptions.jobId;
    const filter: ListEvidenceFilter =
      typeof jobIdOrOptions === "string" ? (maybeFilter ?? {}) : jobIdOrOptions;

    const rawLimit = filter.limit ?? DEFAULT_PAGE_LIMIT;
    const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(rawLimit)));

    const conditions: string[] = ["job_id = ?"];
    const params: unknown[] = [jobId];

    if (filter.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.phase !== undefined) {
      conditions.push("phase = ?");
      params.push(filter.phase);
    }
    if (filter.stateId !== undefined) {
      conditions.push("state_id = ?");
      params.push(filter.stateId);
    }
    if (filter.cursor !== undefined && filter.cursor.trim().length > 0) {
      const afterRowid = this.resolveCursorRowid(jobId, filter.cursor.trim());
      conditions.push("rowid > ?");
      params.push(afterRowid);
    }

    params.push(limit + 1);

    const sql = `
      SELECT rowid, id, job_id, kind, phase, sha256, blob_path, url, state_id, summary, data_json, created_at
      FROM evidence
      WHERE ${conditions.join(" AND ")}
      ORDER BY rowid ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as EvidenceRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapRowToEvidence);

    const page: Page<Evidence> = { items };
    if (hasMore && pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1];
      if (lastRow !== undefined && lastRow.rowid !== undefined) {
        page.nextCursor = encodeCursor(lastRow.rowid, lastRow.id);
      }
    }

    return page;
  }

  count(
    jobId: string,
    filter?: { kind?: EvidenceKind | undefined; phase?: PhaseId | undefined } | undefined,
  ): number {
    const conditions: string[] = ["job_id = ?"];
    const params: unknown[] = [jobId];

    if (filter?.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.phase !== undefined) {
      conditions.push("phase = ?");
      params.push(filter.phase);
    }

    const row = this.db
      .prepare(`SELECT COUNT(*) as total FROM evidence WHERE ${conditions.join(" AND ")}`)
      .get(...params) as { total: number } | undefined;

    return row?.total ?? 0;
  }
}

export function createEvidenceStore(options: EvidenceStoreOptions): EvidenceStore {
  return new EvidenceStore(options);
}
