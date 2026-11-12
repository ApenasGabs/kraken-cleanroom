import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvidenceNotFoundError,
  EvidenceStore,
  canonicalJson,
  computeSha256,
  createEvidenceId,
  createFindingId,
  createHandoffId,
  createJobId,
  createUlid,
  getDatabaseUserVersion,
  loadMigrationFiles,
  openDatabase,
  runMigrations,
} from "./index.js";

describe("ULID and prefixed IDs", () => {
  it("generates monotonically increasing ULIDs even within the same millisecond", () => {
    const fixedTime = 1_762_880_000_000;
    const generated: string[] = [];
    for (let i = 0; i < 40; i++) {
      generated.push(createUlid(fixedTime));
    }

    for (let i = 1; i < generated.length; i++) {
      const prev = generated[i - 1] ?? "";
      const curr = generated[i] ?? "";
      expect(curr.length).toBe(26);
      expect(curr > prev).toBe(true);
    }
  });

  it("creates standardized prefixed IDs according to docs/05 §2", () => {
    expect(createEvidenceId()).toMatch(/^ev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createFindingId()).toMatch(/^fd_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createJobId()).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createHandoffId()).toMatch(/^ho_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("SQLite database and PRAGMA user_version migrations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-db-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates cleanroom.db, applies 001_initial.sql, and is idempotent on re-run", () => {
    const migrations = loadMigrationFiles();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.filename).toBe("001_initial.sql");

    const db = openDatabase(tempDir);
    try {
      expect(existsSync(join(tempDir, "cleanroom.db"))).toBe(true);
      expect(getDatabaseUserVersion(db)).toBe(1);

      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
        )
        .all() as { name: string }[];

      expect(tables.map((t) => t.name)).toEqual([
        "events",
        "evidence",
        "findings",
        "handoffs",
        "jobs",
        "phases",
        "rules",
      ]);

      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name ASC`,
        )
        .all() as { name: string }[];

      expect(indexes.map((i) => i.name)).toEqual(["idx_events_job", "idx_evidence_job_kind"]);

      // Running migrations again is a no-op
      const secondRun = runMigrations(db);
      expect(secondRun).toEqual({
        previousVersion: 1,
        currentVersion: 1,
        applied: [],
      });
    } finally {
      db.close();
    }
  });

  it("applies incremental numbered migrations and rolls back on SQL failure", () => {
    const customMigrationsDir = join(tempDir, "migrations");
    const dbPath = join(tempDir, "custom.db");
    const defaultMigrations = loadMigrationFiles();
    const initialSql = defaultMigrations[0]?.sql ?? "";

    const db = openDatabase({ dbPath, migrate: false });
    try {
      expect(getDatabaseUserVersion(db)).toBe(0);

      // Write 001 and 002
      const migDir = mkdtempSync(join(tempDir, "migs-"));
      writeFileSync(join(migDir, "001_initial.sql"), initialSql, "utf8");
      writeFileSync(
        join(migDir, "002_add_events_index.sql"),
        "CREATE INDEX idx_events_type ON events(type);",
        "utf8",
      );

      const firstResult = runMigrations(db, { migrationsDir: migDir });
      expect(firstResult).toEqual({
        previousVersion: 0,
        currentVersion: 2,
        applied: [1, 2],
      });
      expect(getDatabaseUserVersion(db)).toBe(2);

      // Add a broken 003 migration and verify transaction rollback preserves user_version = 2
      writeFileSync(
        join(migDir, "003_broken.sql"),
        "CREATE TABLE valid_before_err (id TEXT PRIMARY KEY); INVALID SQL SYNTAX HERE;",
        "utf8",
      );

      expect(() => runMigrations(db, { migrationsDir: migDir })).toThrow();
      expect(getDatabaseUserVersion(db)).toBe(2);
      const strayTable = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'valid_before_err'`,
        )
        .get();
      expect(strayTable).toBeUndefined();
      expect(customMigrationsDir).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe("EvidenceStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-evidence-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("deduplicates evidence by (jobId, kind, sha256) and canonicalizes data JSON", () => {
    const db = openDatabase(tempDir);
    try {
      const store = new EvidenceStore({ db, dataDir: tempDir });

      const first = store.putWithResult({
        jobId: "job_01",
        kind: "tech_signature",
        phase: "intake",
        url: "https://example.test",
        summary: "Detectado framework SPA",
        data: { framework: "React", ssr: false },
      });

      expect(first.deduplicated).toBe(false);
      expect(first.evidence.id).toMatch(/^ev_/);
      expect(first.evidence.sha256).toHaveLength(64);

      // Same content with reversed key order -> same canonical JSON -> deduplicated
      const second = store.putWithResult({
        jobId: "job_01",
        kind: "tech_signature",
        phase: "intake",
        url: "https://example.test",
        summary: "Detectado framework SPA",
        data: { ssr: false, framework: "React" },
      });

      expect(second.deduplicated).toBe(true);
      expect(second.evidence.id).toBe(first.evidence.id);
      expect(store.count("job_01")).toBe(1);

      // Same sha256 but different kind -> NOT deduplicated
      const differentKind = store.putWithResult({
        jobId: "job_01",
        kind: "http_response",
        phase: "intake",
        sha256: first.evidence.sha256,
        summary: "Resposta HTTP inicial",
        data: { status: 200 },
      });
      expect(differentKind.deduplicated).toBe(false);
      expect(differentKind.evidence.id).not.toBe(first.evidence.id);
      expect(store.count("job_01")).toBe(2);

      // Same sha256 and kind but different job -> NOT deduplicated
      const differentJob = store.putWithResult({
        jobId: "job_02",
        kind: "tech_signature",
        phase: "intake",
        sha256: first.evidence.sha256,
        summary: "Detectado framework SPA",
        data: { framework: "React", ssr: false },
      });
      expect(differentJob.deduplicated).toBe(false);
      expect(differentJob.evidence.id).not.toBe(first.evidence.id);
      expect(store.count("job_02")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("persists and reads blobs on disk by SHA-256 relative to jobs/<jobId>/evidence/...", () => {
    const db = openDatabase(tempDir);
    try {
      const store = new EvidenceStore({ db, dataDir: tempDir });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
      const expectedHash = computeSha256(pngBytes);

      const ev = store.put({
        jobId: "job_blob_test",
        kind: "screenshot",
        phase: "explore",
        stateId: "state_home",
        url: "https://example.test/",
        summary: "Screenshot desktop da home",
        blob: pngBytes,
        data: { viewport: "1440x900" },
      });

      expect(ev.sha256).toBe(expectedHash);
      expect(ev.blobPath).toBe(`evidence/screenshots/${expectedHash}.png`);

      const expectedDiskPath = join(
        tempDir,
        "jobs",
        "job_blob_test",
        "evidence",
        "screenshots",
        `${expectedHash}.png`,
      );
      expect(existsSync(expectedDiskPath)).toBe(true);

      const readById = store.readBlob("job_blob_test", ev.id);
      expect(readById).not.toBeNull();
      expect(readById?.equals(pngBytes)).toBe(true);

      const readByPath = store.readBlob("job_blob_test", ev.blobPath ?? "");
      expect(readByPath?.equals(pngBytes)).toBe(true);

      // Truncates summaries longer than 300 characters
      const longSummary = "A".repeat(350);
      const domEv = store.put({
        jobId: "job_blob_test",
        kind: "dom_snapshot",
        phase: "explore",
        summary: longSummary,
        blob: "<main><h1>Cleanroom</h1></main>",
        data: {},
      });
      expect(domEv.summary.length).toBe(300);
      expect(domEv.summary.endsWith("...")).toBe(true);
      expect(domEv.blobPath).toMatch(/^evidence\/dom\/[a-f0-9]{64}\.html$/);
    } finally {
      db.close();
    }
  });

  it("supports resumption across database restarts without losing or duplicating evidence", () => {
    const docMarkdown = "# Guia de Preços\nPlano Free permite até 3 projetos.";
    let originalId = "";
    let originalBlobPath = "";

    // Session 1: create DB, insert evidence with blob, close DB
    {
      const db1 = openDatabase(tempDir);
      try {
        const store1 = new EvidenceStore({ db: db1, dataDir: tempDir });
        const created = store1.put({
          jobId: "job_resume_01",
          kind: "doc_section",
          phase: "analyze",
          url: "https://example.test/pricing",
          summary: "Seção de preços",
          blob: docMarkdown,
          data: { heading: "Guia de Preços" },
        });
        originalId = created.id;
        originalBlobPath = created.blobPath ?? "";
      } finally {
        db1.close();
      }
    }

    // Session 2: reopen DB on the same dataDir, verify existing state and dedup on retry
    {
      const db2 = openDatabase(tempDir);
      try {
        expect(getDatabaseUserVersion(db2)).toBe(1);
        const store2 = new EvidenceStore({ db: db2, dataDir: tempDir });

        const loaded = store2.get("job_resume_01", originalId);
        expect(loaded).not.toBeNull();
        expect(loaded?.id).toBe(originalId);
        expect(loaded?.blobPath).toBe(originalBlobPath);
        expect(store2.readBlob("job_resume_01", originalId)?.toString("utf8")).toBe(docMarkdown);

        // Re-running the same phase step deduplicates against persisted evidence
        const retry = store2.putWithResult({
          jobId: "job_resume_01",
          kind: "doc_section",
          phase: "analyze",
          url: "https://example.test/pricing",
          summary: "Seção de preços",
          blob: docMarkdown,
          data: { heading: "Guia de Preços" },
        });
        expect(retry.deduplicated).toBe(true);
        expect(retry.evidence.id).toBe(originalId);
        expect(store2.count("job_resume_01")).toBe(1);

        // Adding new evidence after resume works normally
        const nextEv = store2.put({
          jobId: "job_resume_01",
          kind: "pricing_plan",
          phase: "analyze",
          summary: "Plano Free: 3 projetos",
          data: { plan: "Free", maxProjects: 3 },
        });
        expect(nextEv.id).not.toBe(originalId);
        expect(store2.count("job_resume_01")).toBe(2);
      } finally {
        db2.close();
      }
    }
  });

  it("paginates evidence by cursor and filters by kind", () => {
    const db = openDatabase(tempDir);
    try {
      const store = new EvidenceStore({ db, dataDir: tempDir });
      const jobId = "job_pagination";

      const insertedIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const ev = store.put({
          jobId,
          kind: i % 2 === 1 ? "screenshot" : "form_probe",
          phase: "explore",
          summary: `Evidência #${i}`,
          data: { index: i },
        });
        insertedIds.push(ev.id);
      }

      // Paginate all 5 items with limit = 2
      const page1 = store.list(jobId, { limit: 2 });
      expect(page1.items.map((e) => e.id)).toEqual(insertedIds.slice(0, 2));
      expect(page1.nextCursor).toBeDefined();

      const page2 = store.list(jobId, { limit: 2, cursor: page1.nextCursor });
      expect(page2.items.map((e) => e.id)).toEqual(insertedIds.slice(2, 4));
      expect(page2.nextCursor).toBeDefined();

      const page3 = store.list(jobId, { limit: 2, cursor: page2.nextCursor });
      expect(page3.items.map((e) => e.id)).toEqual(insertedIds.slice(4, 5));
      expect(page3.nextCursor).toBeUndefined();

      // Filter by kind = "screenshot" (indices 1, 3, 5 -> 3 items) with limit = 2
      const screenshotsPage1 = store.list({ jobId, kind: "screenshot", limit: 2 });
      expect(screenshotsPage1.items.map((e) => e.id)).toEqual([
        insertedIds[0] ?? "",
        insertedIds[2] ?? "",
      ]);
      expect(screenshotsPage1.nextCursor).toBeDefined();

      const screenshotsPage2 = store.list({
        jobId,
        kind: "screenshot",
        limit: 2,
        cursor: screenshotsPage1.nextCursor,
      });
      expect(screenshotsPage2.items.map((e) => e.id)).toEqual([insertedIds[4] ?? ""]);
      expect(screenshotsPage2.nextCursor).toBeUndefined();

      // Also supports raw evidence.id as cursor
      const afterSecond = store.list(jobId, { limit: 10, cursor: insertedIds[1] });
      expect(afterSecond.items.map((e) => e.id)).toEqual(insertedIds.slice(2));
    } finally {
      db.close();
    }
  });

  it("throws EvidenceNotFoundError on getOrThrow for missing evidence and blocks path traversal", () => {
    const db = openDatabase(tempDir);
    try {
      const store = new EvidenceStore({ db, dataDir: tempDir });
      expect(store.get("job_01", "ev_missing")).toBeNull();
      expect(() => store.getOrThrow("job_01", "ev_missing")).toThrow(EvidenceNotFoundError);

      expect(() =>
        store.put({
          jobId: "../escape",
          kind: "robots",
          phase: "intake",
          summary: "Invalid jobId",
          data: {},
        }),
      ).toThrow();

      expect(() => store.resolveBlobDiskPath("job_01", "../../outside.txt")).toThrow();
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    } finally {
      db.close();
    }
  });
});
