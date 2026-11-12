import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTimeMs = -1;
let lastRandomDigits: number[] = [];

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 0xffffffffffff) {
    throw new RangeError(`Timestamp inválido para ULID: ${String(timeMs)}`);
  }
  let remaining = timeMs;
  const chars = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = remaining % 32;
    chars[i] = CROCKFORD_BASE32[mod] ?? "0";
    remaining = Math.floor(remaining / 32);
  }
  return chars.join("");
}

function generateRandomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const digits = new Array<number>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    digits[i] = (bytes[i] ?? 0) & 31;
  }
  return digits;
}

function incrementDigits(digits: number[]): number[] {
  const next = [...digits];
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const current = next[i] ?? 0;
    if (current < 31) {
      next[i] = current + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("Overflow monotônico de ULID no mesmo milissegundo.");
}

function encodeRandomDigits(digits: readonly number[]): string {
  const chars = new Array<string>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    chars[i] = CROCKFORD_BASE32[digits[i] ?? 0] ?? "0";
  }
  return chars.join("");
}

export function createUlid(nowMs: number = Date.now()): string {
  const timePart = encodeTime(nowMs);
  let randomDigits: number[];

  if (nowMs === lastTimeMs && lastRandomDigits.length === RANDOM_LEN) {
    randomDigits = incrementDigits(lastRandomDigits);
  } else {
    randomDigits = generateRandomDigits();
    lastTimeMs = nowMs;
  }

  lastRandomDigits = randomDigits;
  return `${timePart}${encodeRandomDigits(randomDigits)}`;
}

export function createPrefixedId<P extends string>(
  prefix: P,
  nowMs?: number | undefined,
): `${P}_${string}` {
  return `${prefix}_${createUlid(nowMs)}`;
}

export function createEvidenceId(nowMs?: number | undefined): string {
  return createPrefixedId("ev", nowMs);
}

export function createFindingId(nowMs?: number | undefined): string {
  return createPrefixedId("fd", nowMs);
}

export function createJobId(nowMs?: number | undefined): string {
  return createPrefixedId("job", nowMs);
}

export function createHandoffId(nowMs?: number | undefined): string {
  return createPrefixedId("ho", nowMs);
}

const JOB_ID_RAND_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function sanitizeJobSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/g, "");
  return slug.length > 0 ? slug : "job";
}

/**
 * jobId do glossário (docs/README.md): `cr-YYYYMMDD-<job.name>-<rand4>`.
 * Data em UTC; `rand4` são 4 caracteres `[a-z0-9]`.
 */
export function createCleanroomJobId(jobName: string, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const bytes = randomBytes(4);
  let rand = "";
  for (let i = 0; i < 4; i++) {
    rand += JOB_ID_RAND_ALPHABET[(bytes[i] ?? 0) % JOB_ID_RAND_ALPHABET.length] ?? "0";
  }
  return `cr-${yyyy}${mm}${dd}-${sanitizeJobSlug(jobName)}-${rand}`;
}
