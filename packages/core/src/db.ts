import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  filePath: string;
  sql: string;
}

export interface RunMigrationsOptions {
  migrationsDir?: string | undefined;
}

export interface MigrationResult {
  previousVersion: number;
  currentVersion: number;
  applied: number[];
}

export interface OpenDatabaseOptions {
  dataDir?: string | undefined;
  dbPath?: string | undefined;
  migrationsDir?: string | undefined;
  migrate?: boolean | undefined;
}

const MIGRATION_FILENAME_REGEX = /^(\d+)_([a-zA-Z0-9_-]+)\.sql$/;

export function resolveDefaultMigrationsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../migrations"),
    resolve(currentDir, "../../migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? resolve(currentDir, "../migrations");
}

export function loadMigrationFiles(migrationsDir?: string | undefined): MigrationFile[] {
  const dir = migrationsDir !== undefined ? resolve(migrationsDir) : resolveDefaultMigrationsDir();
  if (!existsSync(dir)) {
    throw new Error(`Diretório de migrações não encontrado: ${dir}`);
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const migrations: MigrationFile[] = [];
  const seenVersions = new Set<number>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = MIGRATION_FILENAME_REGEX.exec(entry.name);
    if (!match) {
      continue;
    }
    const versionStr = match[1];
    const name = match[2];
    if (versionStr === undefined || name === undefined) {
      continue;
    }
    const version = Number.parseInt(versionStr, 10);
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`Versão de migração inválida no arquivo: ${entry.name}`);
    }
    if (seenVersions.has(version)) {
      throw new Error(`Versão de migração duplicada (${version}) no arquivo: ${entry.name}`);
    }
    seenVersions.add(version);

    const filePath = join(dir, entry.name);
    const sql = readFileSync(filePath, "utf8");
    migrations.push({
      version,
      name,
      filename: entry.name,
      filePath,
      sql,
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

export function getDatabaseUserVersion(db: SqliteDatabase): number {
  const raw = db.pragma("user_version", { simple: true });
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

export function runMigrations(
  db: SqliteDatabase,
  options?: RunMigrationsOptions | undefined,
): MigrationResult {
  const migrations = loadMigrationFiles(options?.migrationsDir);
  const previousVersion = getDatabaseUserVersion(db);
  let currentVersion = previousVersion;
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }
    const applyOne = db.transaction((mig: MigrationFile) => {
      db.exec(mig.sql);
      db.pragma(`user_version = ${mig.version}`);
    });
    applyOne(migration);
    currentVersion = migration.version;
    applied.push(migration.version);
  }

  return {
    previousVersion,
    currentVersion,
    applied,
  };
}

export function resolveDatabasePath(dataDirOrDbPath: string): string {
  const trimmed = dataDirOrDbPath.trim();
  if (trimmed === ":memory:") {
    return ":memory:";
  }
  if (trimmed.endsWith(".db") || trimmed.endsWith(".sqlite") || trimmed.endsWith(".sqlite3")) {
    return resolve(trimmed);
  }
  return resolve(trimmed, "cleanroom.db");
}

export function openDatabase(options: OpenDatabaseOptions | string): SqliteDatabase {
  const normalized: OpenDatabaseOptions =
    typeof options === "string" ? { dataDir: options } : options;

  let dbPath: string;
  if (normalized.dbPath !== undefined && normalized.dbPath.trim().length > 0) {
    dbPath = resolveDatabasePath(normalized.dbPath);
  } else if (normalized.dataDir !== undefined && normalized.dataDir.trim().length > 0) {
    dbPath = resolveDatabasePath(normalized.dataDir);
  } else {
    throw new Error("É necessário informar dataDir ou dbPath para abrir o banco SQLite.");
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }

  if (normalized.migrate !== false) {
    runMigrations(db, { migrationsDir: normalized.migrationsDir });
  }

  return db;
}
