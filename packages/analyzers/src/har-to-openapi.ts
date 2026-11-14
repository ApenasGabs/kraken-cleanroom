import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type DetectedAuthScheme,
  type Evidence,
  type FormSchema,
  type HarEntry,
  type HarLog,
  MethodNotAllowedError,
  type NetworkCallEvidenceData,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
  canonicalJson,
} from "@cleanroom/core";

export const SAFE_ENUM_KEYS = ["status", "state", "type", "kind", "role", "plan"] as const;
export type SafeEnumKey = (typeof SAFE_ENUM_KEYS)[number];

export const SAFE_ENUM_KEY_REGEX = /^(?:status|state|type|kind|role|plan)$/i;
export const SAFE_ENUM_VALUE_REGEX = /^[a-z0-9_-]{2,24}$/i;
export const MAX_ENUM_VALUES = 8;

export const PAGINATION_PARAM_NAMES = [
  "page",
  "cursor",
  "offset",
  "limit",
  "pageSize",
  "per_page",
  "perPage",
] as const;

const PAGINATION_PARAM_SET = new Set(PAGINATION_PARAM_NAMES.map((p) => p.toLowerCase()));
const INTEGER_PAGINATION_PARAM_SET = new Set([
  "page",
  "offset",
  "limit",
  "pagesize",
  "per_page",
  "perpage",
]);

const SENSITIVE_QUERY_PARAM_REGEX = /token|secret|password|session|key|auth/i;
const REDACTED_MARKER = "[REDACTED]";

const HTTP_METHODS_ORDER = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
export type OpenApiHttpMethod = (typeof HTTP_METHODS_ORDER)[number];

export interface OpenApiSchemaObject {
  type?: string | string[];
  properties?: Record<string, OpenApiSchemaObject>;
  required?: string[];
  items?: OpenApiSchemaObject;
  enum?: string[];
  description?: string;
  $ref?: string;
}

export interface OpenApiParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: OpenApiSchemaObject;
  "x-cleanroom-pagination"?: boolean;
}

export interface OpenApiMediaTypeObject {
  schema: OpenApiSchemaObject;
}

export interface OpenApiRequestBodyObject {
  required: boolean;
  content: Record<string, OpenApiMediaTypeObject>;
}

export interface OpenApiResponseObject {
  description: string;
  content?: Record<string, OpenApiMediaTypeObject>;
}

export interface OpenApiPaginationExtension {
  style: "page" | "cursor" | "offset" | "custom";
  parameters: string[];
}

export interface OpenApiOperationObject {
  operationId: string;
  summary: string;
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
  responses: Record<string, OpenApiResponseObject>;
  security?: Array<Record<string, string[]>>;
  "x-cleanroom-evidence": string[];
  "x-cleanroom-pagination"?: OpenApiPaginationExtension;
  "x-cleanroom-enums"?: Record<string, string[]>;
}

export type OpenApiPathItemObject = Partial<Record<OpenApiHttpMethod, OpenApiOperationObject>>;

export interface OpenApiSecuritySchemeObject {
  type: "http" | "apiKey";
  scheme?: "bearer";
  in?: "cookie" | "header" | "query";
  name?: string;
  description?: string;
}

export interface OpenApiComponentsObject {
  securitySchemes?: Record<string, OpenApiSecuritySchemeObject>;
  schemas?: Record<string, OpenApiSchemaObject>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  security?: Array<Record<string, string[]>>;
  paths: Record<string, OpenApiPathItemObject>;
  components?: OpenApiComponentsObject;
}

export interface HarToOpenApiOptions {
  /** HAR explícito (objeto HarLog ou JSON string) para análise em memória. */
  har?: HarLog | string | undefined;
  /** Caminho explícito de arquivo HAR em disco. */
  harPath?: string | undefined;
  /** Lista explícita de evidências network_call. */
  evidences?: readonly Evidence[] | undefined;
  /** Lista explícita de dados de chamadas de API. */
  networkCalls?: readonly NetworkCallEvidenceData[] | undefined;
  /** Caminho de saída customizado para o openapi.yaml. */
  outputPath?: string | undefined;
  /** Título customizado para info.title do documento OpenAPI. */
  title?: string | undefined;
  /** Versão customizada para info.version (default: "0.1.0"). */
  version?: string | undefined;
  /** Fase associada (default: "analyze"). */
  phaseId?: PhaseId | undefined;
  /** Se verdadeiro, lança MethodNotAllowedError quando methods.networkHar=false. */
  throwOnMethodDisabled?: boolean | undefined;
}

export interface HarToOpenApiStats extends Record<string, number> {
  skipped: number;
  callsAnalyzed: number;
  pathsCount: number;
  operationsCount: number;
  enumsInferred: number;
  paginatedOperations: number;
  securitySchemesCount: number;
  standardErrorDetected: number;
}

export interface HarToOpenApiCheckpoint {
  outputPath: string;
  operationsCount: number;
  pathsCount: number;
  updatedAt: string;
}

export interface HarToOpenApiResult {
  skipped: boolean;
  document: OpenApiDocument;
  yaml: string;
  outputPath?: string;
  operationsCount: number;
  pathsCount: number;
  securitySchemes: string[];
  paginationParams: string[];
  hasStandardErrorSchema: boolean;
  stats: HarToOpenApiStats;
}

export interface OpenApiValidationResult {
  valid: boolean;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Path Templating & Resource Family Helpers
// ---------------------------------------------------------------------------

const UUID_SEGMENT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_NUMERIC_SEGMENT_REGEX = /^\d+$/;
const HEX_HASH_SEGMENT_REGEX = /^[0-9a-f]{8,64}$/i;
const ULID_SEGMENT_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const PREFIXED_ID_SEGMENT_REGEX =
  /^(?:proj|project|user|usr|item|order|org|team|st|task|run|job|doc|plan|sub|ev|fd|id|acct|account|cus|inv|msg|tok|sess)[-_][a-zA-Z0-9_-]+$/i;
const WORD_DIGITS_ID_REGEX = /^[a-z]{2,15}-\d+$/i;
const SLUG_HEX_SUFFIX_REGEX = /-[0-9a-f]{6,}$/i;
const API_VERSION_SEGMENT_REGEX = /^v\d+(?:\.\d+)?$/i;

export function isDynamicPathSegment(segment: string): boolean {
  if (!segment || API_VERSION_SEGMENT_REGEX.test(segment)) {
    return false;
  }
  if (/^\{[a-zA-Z0-9_]+\}$/.test(segment)) {
    return true;
  }
  return (
    PURE_NUMERIC_SEGMENT_REGEX.test(segment) ||
    UUID_SEGMENT_REGEX.test(segment) ||
    HEX_HASH_SEGMENT_REGEX.test(segment) ||
    ULID_SEGMENT_REGEX.test(segment) ||
    PREFIXED_ID_SEGMENT_REGEX.test(segment) ||
    WORD_DIGITS_ID_REGEX.test(segment) ||
    SLUG_HEX_SUFFIX_REGEX.test(segment)
  );
}

/**
 * Converte uma URL ou caminho em template de path OpenAPI (segmentos numéricos,
 * UUIDs, hashes e IDs prefixados viram `{id}`).
 */
export function normalizeOpenApiPathTemplate(inputUrlOrPath: string): {
  origin?: string;
  pathTemplate: string;
  pathParams: string[];
} {
  let origin: string | undefined;
  let rawPath = inputUrlOrPath.trim();

  try {
    if (/^https?:\/\//i.test(rawPath)) {
      const parsed = new URL(rawPath);
      origin = parsed.origin;
      rawPath = parsed.pathname;
    } else {
      const parsed = new URL(rawPath, "https://cleanroom.local");
      rawPath = parsed.pathname;
    }
  } catch {
    const qIndex = rawPath.indexOf("?");
    if (qIndex >= 0) {
      rawPath = rawPath.slice(0, qIndex);
    }
  }

  const rawSegments = rawPath.split("/").filter((s) => s.length > 0);
  const pathParams: string[] = [];
  const templatedSegments = rawSegments.map((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    if (/^\{([a-zA-Z0-9_]+)\}$/.test(decoded)) {
      const paramName = decoded.slice(1, -1);
      if (!pathParams.includes(paramName)) {
        pathParams.push(paramName);
      }
      return `{${paramName}}`;
    }
    if (isDynamicPathSegment(decoded)) {
      if (!pathParams.includes("id")) {
        pathParams.push("id");
      }
      return "{id}";
    }
    return decoded;
  });

  const pathTemplate = `/${templatedSegments.join("/")}`;
  return {
    ...(origin ? { origin } : {}),
    pathTemplate,
    pathParams,
  };
}

/**
 * Determina a família de recurso de um path template (ex.: `/api/projects/{id}/activate` -> `/api/projects`)
 * para compartilhamento seguro de enums do mesmo domínio.
 */
export function resolveResourceFamily(pathTemplate: string): string {
  const segments = pathTemplate.split("/").filter((s) => s.length > 0);
  const staticPrefix: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith("{")) {
      break;
    }
    staticPrefix.push(seg);
    if (
      staticPrefix.length >= 2 &&
      !API_VERSION_SEGMENT_REGEX.test(seg) &&
      seg.toLowerCase() !== "api" &&
      seg.toLowerCase() !== "rest"
    ) {
      break;
    }
  }
  return staticPrefix.length > 0 ? `/${staticPrefix.join("/")}` : pathTemplate;
}

export function isPaginationParam(paramName: string): boolean {
  return PAGINATION_PARAM_SET.has(paramName.trim().toLowerCase());
}

/**
 * Extrai amostras seguras de valores de enum a partir de um payload JSON.
 * Apenas chaves seguras (`status`, `state`, `type`, `kind`, `role`, `plan`) com
 * strings curtas (`^[a-z0-9_-]{2,24}$`) são retidas.
 */
export function extractSafeEnumsFromJson(
  value: unknown,
  target: Record<string, string[]> = {},
  currentPath = "",
): Record<string, string[]> {
  if (value === null || value === undefined) {
    return target;
  }

  if (Array.isArray(value)) {
    const nextPath = currentPath ? `${currentPath}[]` : "[]";
    for (const item of value) {
      extractSafeEnumsFromJson(item, target, nextPath);
    }
    return target;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const propPath = currentPath ? `${currentPath}.${k}` : k;
      if (
        typeof v === "string" &&
        v !== REDACTED_MARKER &&
        SAFE_ENUM_KEY_REGEX.test(k) &&
        SAFE_ENUM_VALUE_REGEX.test(v)
      ) {
        for (const bucketKey of [propPath, k.toLowerCase()]) {
          const list = target[bucketKey] ?? [];
          if (!list.includes(v)) {
            list.push(v);
            target[bucketKey] = list;
          }
        }
      } else if (typeof v === "object" && v !== null) {
        extractSafeEnumsFromJson(v, target, propPath);
      }
    }
  }

  return target;
}

// ---------------------------------------------------------------------------
// Schema Accumulator & Merger
// ---------------------------------------------------------------------------

interface SchemaAccumulator {
  sampleCount: number;
  objectSampleCount: number;
  types: Set<"string" | "number" | "integer" | "boolean" | "object" | "array" | "null">;
  properties: Map<string, { presentCount: number; acc: SchemaAccumulator }>;
  itemsAcc?: SchemaAccumulator;
  enumValues: Set<string>;
  hasUnsafeEnumValue: boolean;
  fieldKey?: string;
}

function createSchemaAccumulator(fieldKey?: string): SchemaAccumulator {
  return {
    sampleCount: 0,
    objectSampleCount: 0,
    types: new Set(),
    properties: new Map(),
    enumValues: new Set(),
    hasUnsafeEnumValue: false,
    ...(fieldKey !== undefined ? { fieldKey } : {}),
  };
}

function recordSafeEnumCandidate(
  acc: SchemaAccumulator,
  fieldKey: string | undefined,
  rawVal: string,
  resourceEnums?: Map<string, Set<string>>,
  allowResourcePool = true,
): void {
  if (!fieldKey || !SAFE_ENUM_KEY_REGEX.test(fieldKey)) {
    return;
  }
  if (rawVal === REDACTED_MARKER) {
    return;
  }
  if (SAFE_ENUM_VALUE_REGEX.test(rawVal)) {
    acc.enumValues.add(rawVal);
    if (allowResourcePool && resourceEnums) {
      const lowerKey = fieldKey.toLowerCase();
      let set = resourceEnums.get(lowerKey);
      if (!set) {
        set = new Set<string>();
        resourceEnums.set(lowerKey, set);
      }
      set.add(rawVal);
    }
  } else {
    acc.hasUnsafeEnumValue = true;
  }
}

function addJsonValueToAccumulator(
  acc: SchemaAccumulator,
  value: unknown,
  fieldKey?: string,
  resourceEnums?: Map<string, Set<string>>,
  allowResourcePool = true,
): void {
  if (value === undefined) {
    return;
  }

  if (fieldKey !== undefined && acc.fieldKey === undefined) {
    acc.fieldKey = fieldKey;
  }

  acc.sampleCount += 1;

  if (value === null) {
    acc.types.add("null");
    return;
  }

  if (typeof value === "string") {
    acc.types.add("string");
    recordSafeEnumCandidate(acc, fieldKey ?? acc.fieldKey, value, resourceEnums, allowResourcePool);
    return;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    acc.types.add("number");
    return;
  }

  if (typeof value === "boolean") {
    acc.types.add("boolean");
    return;
  }

  if (Array.isArray(value)) {
    acc.types.add("array");
    if (!acc.itemsAcc) {
      acc.itemsAcc = createSchemaAccumulator(fieldKey);
    }
    for (const item of value) {
      addJsonValueToAccumulator(acc.itemsAcc, item, fieldKey, resourceEnums, allowResourcePool);
    }
    return;
  }

  if (typeof value === "object") {
    acc.types.add("object");
    acc.objectSampleCount += 1;
    const record = value as Record<string, unknown>;
    for (const [key, propVal] of Object.entries(record)) {
      if (propVal === undefined) {
        continue;
      }
      let propEntry = acc.properties.get(key);
      if (!propEntry) {
        propEntry = { presentCount: 0, acc: createSchemaAccumulator(key) };
        acc.properties.set(key, propEntry);
      }
      propEntry.presentCount += 1;
      addJsonValueToAccumulator(propEntry.acc, propVal, key, resourceEnums, allowResourcePool);
    }
  }
}

function isPrimitiveShapeDescriptor(val: unknown): val is string {
  return (
    val === "string" ||
    val === "number" ||
    val === "integer" ||
    val === "boolean" ||
    val === "null" ||
    val === "undefined" ||
    val === "unknown"
  );
}

function addShapeSkeletonToAccumulator(
  acc: SchemaAccumulator,
  shape: unknown,
  fieldKey?: string,
  safeEnumSamples?: Record<string, string[]>,
  currentPath = "",
  resourceEnums?: Map<string, Set<string>>,
  allowResourcePool = true,
): void {
  if (shape === undefined || shape === "undefined") {
    return;
  }

  if (fieldKey !== undefined && acc.fieldKey === undefined) {
    acc.fieldKey = fieldKey;
  }

  acc.sampleCount += 1;

  if (shape === null || shape === "null") {
    acc.types.add("null");
    return;
  }

  if (isPrimitiveShapeDescriptor(shape)) {
    if (shape === "string" || shape === "unknown") {
      acc.types.add("string");
      const effectiveKey = fieldKey ?? acc.fieldKey;
      if (effectiveKey && SAFE_ENUM_KEY_REGEX.test(effectiveKey) && safeEnumSamples) {
        const candidates = [
          ...(safeEnumSamples[currentPath] ?? []),
          ...(safeEnumSamples[effectiveKey] ?? []),
          ...(safeEnumSamples[effectiveKey.toLowerCase()] ?? []),
        ];
        for (const c of candidates) {
          recordSafeEnumCandidate(acc, effectiveKey, c, resourceEnums, allowResourcePool);
        }
      }
    } else if (shape === "number" || shape === "integer") {
      acc.types.add("number");
    } else if (shape === "boolean") {
      acc.types.add("boolean");
    }
    return;
  }

  if (Array.isArray(shape)) {
    acc.types.add("array");
    if (!acc.itemsAcc) {
      acc.itemsAcc = createSchemaAccumulator(fieldKey);
    }
    const nextPath = currentPath ? `${currentPath}[]` : "[]";
    for (const itemShape of shape) {
      addShapeSkeletonToAccumulator(
        acc.itemsAcc,
        itemShape,
        fieldKey,
        safeEnumSamples,
        nextPath,
        resourceEnums,
        allowResourcePool,
      );
    }
    return;
  }

  if (typeof shape === "object") {
    const obj = shape as Record<string, unknown>;

    // Suporta descritores explícitos `{ type: "string", enum: [...] }` caso fornecidos em fixtures
    if (
      typeof obj.type === "string" &&
      (obj.type === "string" || obj.type === "number" || obj.type === "boolean") &&
      !("properties" in obj) &&
      Object.keys(obj).every((k) => k === "type" || k === "enum" || k === "description")
    ) {
      if (obj.type === "string") {
        acc.types.add("string");
        if (Array.isArray(obj.enum)) {
          for (const e of obj.enum) {
            if (typeof e === "string") {
              recordSafeEnumCandidate(
                acc,
                fieldKey ?? acc.fieldKey,
                e,
                resourceEnums,
                allowResourcePool,
              );
            }
          }
        }
      } else if (obj.type === "number") {
        acc.types.add("number");
      } else if (obj.type === "boolean") {
        acc.types.add("boolean");
      }
      return;
    }

    acc.types.add("object");
    acc.objectSampleCount += 1;

    for (const [key, propShape] of Object.entries(obj)) {
      if (propShape === undefined || propShape === "undefined") {
        continue;
      }
      let propEntry = acc.properties.get(key);
      if (!propEntry) {
        propEntry = { presentCount: 0, acc: createSchemaAccumulator(key) };
        acc.properties.set(key, propEntry);
      }
      propEntry.presentCount += 1;
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      addShapeSkeletonToAccumulator(
        propEntry.acc,
        propShape,
        key,
        safeEnumSamples,
        nextPath,
        resourceEnums,
        allowResourcePool,
      );
    }
  }
}

function buildSchemaFromAccumulator(
  acc: SchemaAccumulator,
  resourceEnums?: Map<string, Set<string>>,
  collectedOperationEnums?: Record<string, string[]>,
  allowResourcePool = true,
): OpenApiSchemaObject {
  const typesList = Array.from(acc.types);
  const nonNullTypes = typesList.filter((t) => t !== "null");
  const hasNull = acc.types.has("null");

  if (typesList.length === 0) {
    return { type: "object" };
  }

  const primaryType = nonNullTypes[0] ?? "null";
  const schema: OpenApiSchemaObject = {};

  if (nonNullTypes.length === 1 && !hasNull) {
    schema.type = primaryType;
  } else if (nonNullTypes.length === 1 && hasNull) {
    schema.type = [primaryType, "null"];
  } else if (nonNullTypes.length > 1) {
    schema.type = hasNull ? [...nonNullTypes, "null"] : nonNullTypes;
  } else {
    schema.type = "null";
  }

  if (acc.types.has("object")) {
    const properties: Record<string, OpenApiSchemaObject> = {};
    const required: string[] = [];
    const sortedKeys = Array.from(acc.properties.keys()).sort();

    for (const key of sortedKeys) {
      const propEntry = acc.properties.get(key);
      if (!propEntry) {
        continue;
      }
      properties[key] = buildSchemaFromAccumulator(
        propEntry.acc,
        resourceEnums,
        collectedOperationEnums,
        allowResourcePool,
      );
      if (acc.objectSampleCount > 0 && propEntry.presentCount === acc.objectSampleCount) {
        required.push(key);
      }
    }

    schema.properties = properties;
    if (required.length > 0) {
      schema.required = required;
    }
  }

  if (acc.types.has("array")) {
    if (acc.itemsAcc && acc.itemsAcc.sampleCount > 0) {
      schema.items = buildSchemaFromAccumulator(
        acc.itemsAcc,
        resourceEnums,
        collectedOperationEnums,
        allowResourcePool,
      );
    } else {
      schema.items = {};
    }
  }

  if (acc.types.has("string") && acc.fieldKey && SAFE_ENUM_KEY_REGEX.test(acc.fieldKey)) {
    if (!acc.hasUnsafeEnumValue) {
      const mergedEnums: string[] = [];
      for (const v of acc.enumValues) {
        if (!mergedEnums.includes(v)) {
          mergedEnums.push(v);
        }
      }
      if (allowResourcePool && resourceEnums) {
        const pooled = resourceEnums.get(acc.fieldKey.toLowerCase());
        if (pooled) {
          for (const v of pooled) {
            if (!mergedEnums.includes(v)) {
              mergedEnums.push(v);
            }
          }
        }
      }
      if (mergedEnums.length >= 1 && mergedEnums.length <= MAX_ENUM_VALUES) {
        schema.enum = mergedEnums;
        if (collectedOperationEnums) {
          collectedOperationEnums[acc.fieldKey] = mergedEnums;
        }
      }
    }
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Standard Error & Auth Detection
// ---------------------------------------------------------------------------

/**
 * Verifica se um objeto JSON ou OpenApiSchemaObject corresponde ao padrão de erro `{ error, message, code }`.
 */
export function isStandardErrorShape(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const obj = input as Record<string, unknown>;
  const props =
    typeof obj.properties === "object" && obj.properties !== null && !Array.isArray(obj.properties)
      ? (obj.properties as Record<string, unknown>)
      : obj;

  const hasError = "error" in props;
  const hasMessage = "message" in props;
  const hasCode = "code" in props;

  return (hasError && hasMessage) || (hasError && hasCode) || (hasMessage && hasCode);
}

export interface DetectedAuthInfo {
  schemes: Set<DetectedAuthScheme>;
  cookieNames: Set<string>;
  apiKeyHeaderNames: Set<string>;
}

export function detectAuthFromHarEntry(
  entry: HarEntry,
  target: DetectedAuthInfo,
): DetectedAuthScheme[] {
  const entrySchemes = new Set<DetectedAuthScheme>();

  for (const h of entry.request?.headers ?? []) {
    const lowerName = h.name.toLowerCase();
    const rawVal = h.value.trim();
    if (lowerName === "authorization" && /^bearer\b/i.test(rawVal)) {
      entrySchemes.add("bearer");
      target.schemes.add("bearer");
    } else if (lowerName === "cookie" && rawVal.length > 0) {
      entrySchemes.add("cookie");
      target.schemes.add("cookie");
      const firstCookiePair = rawVal.split(";")[0]?.trim();
      const eqIdx = firstCookiePair?.indexOf("=") ?? -1;
      if (firstCookiePair && eqIdx > 0) {
        target.cookieNames.add(firstCookiePair.slice(0, eqIdx).trim());
      }
    } else if (lowerName === "x-api-key" || lowerName === "api-key") {
      entrySchemes.add("apiKey");
      target.schemes.add("apiKey");
      target.apiKeyHeaderNames.add(h.name);
    }
  }

  for (const h of entry.response?.headers ?? []) {
    if (h.name.toLowerCase() === "set-cookie" && h.value.trim().length > 0) {
      entrySchemes.add("cookie");
      target.schemes.add("cookie");
      const firstCookiePair = h.value.split(";")[0]?.trim();
      const eqIdx = firstCookiePair?.indexOf("=") ?? -1;
      if (firstCookiePair && eqIdx > 0) {
        target.cookieNames.add(firstCookiePair.slice(0, eqIdx).trim());
      }
    }
  }

  for (const c of entry.request?.cookies ?? []) {
    entrySchemes.add("cookie");
    target.schemes.add("cookie");
    if (c.name) {
      target.cookieNames.add(c.name);
    }
  }

  for (const c of entry.response?.cookies ?? []) {
    entrySchemes.add("cookie");
    target.schemes.add("cookie");
    if (c.name) {
      target.cookieNames.add(c.name);
    }
  }

  return Array.from(entrySchemes);
}

// ---------------------------------------------------------------------------
// API Call Filtering & Sample Normalization
// ---------------------------------------------------------------------------

const STATIC_ASSET_EXT_REGEX =
  /\.(?:js|mjs|cjs|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|map|wasm|mp4|mp3|pdf)$/i;

export function isEligibleApiHarEntry(entry: HarEntry): boolean {
  const reqUrl = entry.request?.url ?? "";
  if (!reqUrl) {
    return false;
  }

  let pathname = reqUrl;
  try {
    const parsed = new URL(reqUrl, "https://cleanroom.local");
    pathname = parsed.pathname;
  } catch {
    // fallback
  }

  const lowerPath = pathname.toLowerCase();
  if (
    STATIC_ASSET_EXT_REGEX.test(lowerPath) ||
    lowerPath === "/robots.txt" ||
    lowerPath === "/sitemap.xml" ||
    lowerPath.startsWith("/static/") ||
    lowerPath.startsWith("/assets/")
  ) {
    return false;
  }

  const isExplicitApiPath =
    lowerPath.startsWith("/api/") ||
    lowerPath.startsWith("/v1/") ||
    lowerPath.startsWith("/v2/") ||
    lowerPath.startsWith("/v3/") ||
    lowerPath.startsWith("/graphql") ||
    lowerPath.startsWith("/rest/");

  const reqContentType =
    entry.request?.headers
      ?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ??
    entry.request?.postData?.mimeType?.toLowerCase() ??
    "";
  const resContentType =
    entry.response?.content?.mimeType?.toLowerCase() ??
    entry.response?.headers
      ?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ??
    "";
  const acceptHeader =
    entry.request?.headers?.find((h) => h.name.toLowerCase() === "accept")?.value.toLowerCase() ??
    "";

  const isJsonPayload =
    reqContentType.includes("json") ||
    resContentType.includes("json") ||
    acceptHeader.includes("application/json");

  if (isExplicitApiPath) {
    return true;
  }

  if (resContentType.includes("text/html") && !isJsonPayload) {
    return false;
  }

  const resourceType = entry._resourceType?.toLowerCase();
  if (
    (resourceType === "fetch" || resourceType === "xhr") &&
    (isJsonPayload || !resContentType.includes("text/html"))
  ) {
    return true;
  }

  return isJsonPayload;
}

interface NormalizedApiSample {
  method: OpenApiHttpMethod;
  url: string;
  origin?: string;
  pathTemplate: string;
  pathParams: string[];
  status: number;
  statusText?: string;
  queryParams: Map<string, string[]>;
  reqJson?: unknown;
  resJson?: unknown;
  reqShape?: unknown;
  resShape?: unknown;
  safeEnumSamples?: Record<string, string[]>;
  authSchemes: DetectedAuthScheme[];
  evidenceId: string;
}

function toOpenApiHttpMethod(method: string): OpenApiHttpMethod | null {
  const lower = method.trim().toLowerCase();
  if ((HTTP_METHODS_ORDER as readonly string[]).includes(lower)) {
    return lower as OpenApiHttpMethod;
  }
  return null;
}

function tryParseJsonBody(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractQueryParamsMap(
  url: string,
  harQuery?: ReadonlyArray<{ name: string; value: string }>,
  paramNamesList?: readonly string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  const addParam = (name: string, val?: string) => {
    const cleanName = name.trim();
    if (!cleanName || SENSITIVE_QUERY_PARAM_REGEX.test(cleanName)) {
      return;
    }
    const list = map.get(cleanName) ?? [];
    if (val !== undefined && val !== REDACTED_MARKER && !list.includes(val)) {
      list.push(val);
    }
    map.set(cleanName, list);
  };

  if (harQuery) {
    for (const q of harQuery) {
      addParam(q.name, q.value);
    }
  }

  try {
    const parsed = new URL(url, "https://cleanroom.local");
    parsed.searchParams.forEach((value, key) => {
      addParam(key, value);
    });
  } catch {
    // ignora
  }

  if (paramNamesList) {
    for (const name of paramNamesList) {
      addParam(name);
    }
  }

  return map;
}

function buildOperationId(method: OpenApiHttpMethod, pathTemplate: string): string {
  const segments = pathTemplate.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return `${method}Root`;
  }
  const parts: string[] = [method];
  for (const seg of segments) {
    if (seg.startsWith("{") && seg.endsWith("}")) {
      const param = seg.slice(1, -1);
      const capitalized = param.charAt(0).toUpperCase() + param.slice(1);
      parts.push(`By${capitalized}`);
    } else {
      const words = seg.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
      for (const w of words) {
        parts.push(w.charAt(0).toUpperCase() + w.slice(1));
      }
    }
  }
  return parts.join("");
}

function defaultStatusDescription(status: number, statusText?: string): string {
  if (statusText && statusText.trim().length > 0) {
    return statusText.trim();
  }
  switch (status) {
    case 200:
      return "OK";
    case 201:
      return "Created";
    case 202:
      return "Accepted";
    case 204:
      return "No Content";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 422:
      return "Unprocessable Entity";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    default:
      return `HTTP ${status}`;
  }
}

function inferQueryParamSchema(name: string, values: readonly string[]): OpenApiSchemaObject {
  const lower = name.toLowerCase();
  if (INTEGER_PAGINATION_PARAM_SET.has(lower)) {
    return { type: "integer" };
  }
  if (lower === "cursor") {
    return { type: "string" };
  }
  if (values.length > 0 && values.every((v) => /^\d+$/.test(v))) {
    return { type: "integer" };
  }
  if (values.length > 0 && values.every((v) => v === "true" || v === "false")) {
    return { type: "boolean" };
  }
  if (
    SAFE_ENUM_KEY_REGEX.test(name) &&
    values.length >= 1 &&
    values.length <= MAX_ENUM_VALUES &&
    values.every((v) => SAFE_ENUM_VALUE_REGEX.test(v))
  ) {
    return { type: "string", enum: [...values] };
  }
  return { type: "string" };
}

function hasPaginatedEnvelopeShape(schema: OpenApiSchemaObject | undefined): {
  paginated: boolean;
  inferredParams: string[];
} {
  if (!schema || !schema.properties) {
    return { paginated: false, inferredParams: [] };
  }
  const props = schema.properties;
  const inferredParams: string[] = [];

  const metaObj = props.meta?.properties ?? props.pagination?.properties;
  if (metaObj) {
    if ("page" in metaObj || "totalPages" in metaObj || "hasNextPage" in metaObj) {
      inferredParams.push("page");
    }
    if ("pageSize" in metaObj) {
      inferredParams.push("pageSize");
    }
    if ("limit" in metaObj) {
      inferredParams.push("limit");
    }
    if ("offset" in metaObj) {
      inferredParams.push("offset");
    }
    if ("nextCursor" in metaObj || "cursor" in metaObj) {
      inferredParams.push("cursor");
    }
  }

  for (const topKey of ["page", "cursor", "offset", "limit", "nextCursor"]) {
    if (topKey in props && ("items" in props || "data" in props || "results" in props)) {
      const normalized = topKey === "nextCursor" ? "cursor" : topKey;
      if (!inferredParams.includes(normalized)) {
        inferredParams.push(normalized);
      }
    }
  }

  return {
    paginated: inferredParams.length > 0,
    inferredParams,
  };
}

// ---------------------------------------------------------------------------
// YAML Serializer & OpenAPI 3.1 Validator
// ---------------------------------------------------------------------------

const YAML_PLAIN_SAFE_REGEX = /^[a-zA-Z_][a-zA-Z0-9_./-]*$/;
const YAML_RESERVED_WORDS = new Set([
  "true",
  "false",
  "null",
  "~",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
]);

function formatYamlKey(key: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key) && !YAML_RESERVED_WORDS.has(key.toLowerCase())) {
    return key;
  }
  if (/^\/[a-zA-Z0-9_./{}-]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    if (/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?$/.test(value)) {
      return value;
    }
    if (
      value.length > 0 &&
      value.length <= 80 &&
      YAML_PLAIN_SAFE_REGEX.test(value) &&
      !YAML_RESERVED_WORDS.has(value.toLowerCase()) &&
      !/^\d/.test(value)
    ) {
      return value;
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function serializeYamlNode(node: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (node === null || node === undefined || typeof node !== "object") {
    return [`${indent}${formatYamlScalar(node)}`];
  }

  if (Array.isArray(node)) {
    if (node.length === 0) {
      return [`${indent}[]`];
    }
    const lines: string[] = [];
    for (const item of node) {
      if (item === null || item === undefined || typeof item !== "object") {
        lines.push(`${indent}- ${formatYamlScalar(item)}`);
      } else if (Array.isArray(item)) {
        lines.push(`${indent}- ${JSON.stringify(item)}`);
      } else {
        const obj = item as Record<string, unknown>;
        const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          lines.push(`${indent}- {}`);
        } else {
          const [firstEntry, ...restEntries] = entries;
          if (firstEntry) {
            const [firstKey, firstVal] = firstEntry;
            const formattedFirstKey = formatYamlKey(firstKey);
            if (firstVal === null || typeof firstVal !== "object") {
              lines.push(`${indent}- ${formattedFirstKey}: ${formatYamlScalar(firstVal)}`);
            } else if (Array.isArray(firstVal) && firstVal.length === 0) {
              lines.push(`${indent}- ${formattedFirstKey}: []`);
            } else if (
              typeof firstVal === "object" &&
              !Array.isArray(firstVal) &&
              Object.keys(firstVal as Record<string, unknown>).length === 0
            ) {
              lines.push(`${indent}- ${formattedFirstKey}: {}`);
            } else {
              lines.push(`${indent}- ${formattedFirstKey}:`);
              lines.push(...serializeYamlNode(firstVal, indentLevel + 2));
            }
          }
          for (const [k, v] of restEntries) {
            const formattedKey = formatYamlKey(k);
            if (v === null || typeof v !== "object") {
              lines.push(`${indent}  ${formattedKey}: ${formatYamlScalar(v)}`);
            } else if (Array.isArray(v) && v.length === 0) {
              lines.push(`${indent}  ${formattedKey}: []`);
            } else if (
              typeof v === "object" &&
              !Array.isArray(v) &&
              Object.keys(v as Record<string, unknown>).length === 0
            ) {
              lines.push(`${indent}  ${formattedKey}: {}`);
            } else {
              lines.push(`${indent}  ${formattedKey}:`);
              lines.push(...serializeYamlNode(v, indentLevel + 2));
            }
          }
        }
      }
    }
    return lines;
  }

  const obj = node as Record<string, unknown>;
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    return [`${indent}{}`];
  }

  const lines: string[] = [];
  for (const [key, val] of entries) {
    const formattedKey = formatYamlKey(key);
    if (val === null || typeof val !== "object") {
      lines.push(`${indent}${formattedKey}: ${formatYamlScalar(val)}`);
    } else if (Array.isArray(val) && val.length === 0) {
      lines.push(`${indent}${formattedKey}: []`);
    } else if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      Object.keys(val as Record<string, unknown>).length === 0
    ) {
      lines.push(`${indent}${formattedKey}: {}`);
    } else {
      lines.push(`${indent}${formattedKey}:`);
      lines.push(...serializeYamlNode(val, indentLevel + 1));
    }
  }

  return lines;
}

/**
 * Serializa um `OpenApiDocument` em YAML determinístico compatível com OpenAPI 3.1.0.
 */
export function serializeOpenApiYaml(doc: OpenApiDocument): string {
  return `${serializeYamlNode(doc, 0).join("\n")}\n`;
}

const VALID_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

function validateSchemaNode(schema: unknown, path: string, issues: string[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    issues.push(`${path}: schema deve ser um objeto.`);
    return;
  }
  const s = schema as Record<string, unknown>;
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== "string" || !s.$ref.startsWith("#/")) {
      issues.push(`${path}.$ref: referência inválida.`);
    }
    return;
  }

  if (s.type !== undefined) {
    if (typeof s.type === "string") {
      if (!VALID_JSON_SCHEMA_TYPES.has(s.type)) {
        issues.push(`${path}.type: tipo inválido "${s.type}".`);
      }
    } else if (Array.isArray(s.type)) {
      if (
        s.type.length === 0 ||
        !s.type.every((t) => typeof t === "string" && VALID_JSON_SCHEMA_TYPES.has(t))
      ) {
        issues.push(`${path}.type: array de tipos inválido.`);
      }
    } else {
      issues.push(`${path}.type: deve ser string ou array de strings.`);
    }
  }

  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > MAX_ENUM_VALUES) {
      issues.push(
        `${path}.enum: deve ser array não vazio com no máximo ${MAX_ENUM_VALUES} valores.`,
      );
    }
  }

  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
      issues.push(`${path}.properties: deve ser objeto.`);
    } else {
      const props = s.properties as Record<string, unknown>;
      for (const [k, propSchema] of Object.entries(props)) {
        validateSchemaNode(propSchema, `${path}.properties.${k}`, issues);
      }
      if (s.required !== undefined) {
        if (
          !Array.isArray(s.required) ||
          !s.required.every((r) => typeof r === "string" && r in props)
        ) {
          issues.push(`${path}.required: deve listar apenas propriedades existentes.`);
        }
      }
    }
  }

  if (s.items !== undefined) {
    validateSchemaNode(s.items, `${path}.items`, issues);
  }
}

/**
 * Valida estruturalmente um documento OpenAPI 3.1.0 gerado pelo `harToOpenApi`.
 */
export function validateOpenApiDocument(doc: unknown): OpenApiValidationResult {
  const issues: string[] = [];

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { valid: false, issues: ["Documento raiz deve ser um objeto."] };
  }

  const root = doc as Record<string, unknown>;
  if (root.openapi !== "3.1.0") {
    issues.push(`Versão openapi inválida: esperado "3.1.0", recebido "${String(root.openapi)}".`);
  }

  if (typeof root.info !== "object" || root.info === null) {
    issues.push("Campo obrigatório 'info' ausente.");
  } else {
    const info = root.info as Record<string, unknown>;
    if (typeof info.title !== "string" || info.title.trim().length === 0) {
      issues.push("info.title deve ser uma string não vazia.");
    }
    if (typeof info.version !== "string" || info.version.trim().length === 0) {
      issues.push("info.version deve ser uma string não vazia.");
    }
  }

  if (typeof root.paths !== "object" || root.paths === null || Array.isArray(root.paths)) {
    issues.push("Campo obrigatório 'paths' deve ser um objeto.");
  } else {
    const paths = root.paths as Record<string, unknown>;
    const operationIds = new Set<string>();

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!pathKey.startsWith("/")) {
        issues.push(`Path "${pathKey}" deve começar com "/".`);
      }
      if (typeof pathItem !== "object" || pathItem === null || Array.isArray(pathItem)) {
        issues.push(`PathItem "${pathKey}" deve ser um objeto.`);
        continue;
      }

      const templateParams = Array.from(pathKey.matchAll(/\{([a-zA-Z0-9_]+)\}/g)).map(
        (m) => m[1] ?? "",
      );

      const itemObj = pathItem as Record<string, unknown>;
      for (const method of HTTP_METHODS_ORDER) {
        const opRaw = itemObj[method];
        if (opRaw === undefined) {
          continue;
        }
        const opLoc = `paths.${pathKey}.${method}`;
        if (typeof opRaw !== "object" || opRaw === null || Array.isArray(opRaw)) {
          issues.push(`${opLoc} deve ser um objeto.`);
          continue;
        }
        const op = opRaw as Record<string, unknown>;
        if (typeof op.operationId !== "string" || op.operationId.length === 0) {
          issues.push(`${opLoc}.operationId ausente.`);
        } else if (operationIds.has(op.operationId)) {
          issues.push(`${opLoc}.operationId duplicado: "${op.operationId}".`);
        } else {
          operationIds.add(op.operationId);
        }

        const evidences = op["x-cleanroom-evidence"];
        if (
          !Array.isArray(evidences) ||
          evidences.length === 0 ||
          !evidences.every((e) => typeof e === "string" && e.trim().length > 0)
        ) {
          issues.push(
            `${opLoc}["x-cleanroom-evidence"] deve conter pelo menos um evidenceId válido.`,
          );
        }

        const params = Array.isArray(op.parameters)
          ? (op.parameters as Array<Record<string, unknown>>)
          : [];
        for (const tplParam of templateParams) {
          const foundPathParam = params.some(
            (p) => p.name === tplParam && p.in === "path" && p.required === true,
          );
          if (!foundPathParam) {
            issues.push(
              `${opLoc}.parameters deve declarar o parâmetro de path "{${tplParam}}" com required=true.`,
            );
          }
        }

        if (
          typeof op.responses !== "object" ||
          op.responses === null ||
          Array.isArray(op.responses)
        ) {
          issues.push(`${opLoc}.responses deve ser um objeto não vazio.`);
        } else {
          const responses = op.responses as Record<string, unknown>;
          if (Object.keys(responses).length === 0) {
            issues.push(`${opLoc}.responses deve ter pelo menos um status code.`);
          }
          for (const [statusCode, resRaw] of Object.entries(responses)) {
            if (!/^[1-5]\d\d$/.test(statusCode) && statusCode !== "default") {
              issues.push(`${opLoc}.responses["${statusCode}"]: status code inválido.`);
            }
            if (typeof resRaw !== "object" || resRaw === null) {
              issues.push(`${opLoc}.responses["${statusCode}"] deve ser um objeto.`);
              continue;
            }
            const resObj = resRaw as Record<string, unknown>;
            if (typeof resObj.description !== "string" || resObj.description.length === 0) {
              issues.push(`${opLoc}.responses["${statusCode}"].description obrigatório.`);
            }
            if (resObj.content && typeof resObj.content === "object") {
              for (const [mime, mediaObj] of Object.entries(
                resObj.content as Record<string, unknown>,
              )) {
                if (typeof mediaObj === "object" && mediaObj !== null && "schema" in mediaObj) {
                  validateSchemaNode(
                    (mediaObj as Record<string, unknown>).schema,
                    `${opLoc}.responses["${statusCode}"].content["${mime}"].schema`,
                    issues,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Core OpenAPI Builder from Normalized Samples
// ---------------------------------------------------------------------------

interface OperationGroup {
  method: OpenApiHttpMethod;
  pathTemplate: string;
  resourceFamily: string;
  pathParams: string[];
  queryParams: Map<string, Set<string>>;
  reqAcc: SchemaAccumulator;
  hasReqBody: boolean;
  resAccByStatus: Map<number, { statusText?: string; acc: SchemaAccumulator; hasBody: boolean }>;
  evidenceIds: Set<string>;
  authSchemes: Set<DetectedAuthScheme>;
}

function buildOpenApiFromNormalizedSamples(params: {
  samples: NormalizedApiSample[];
  authInfo: DetectedAuthInfo;
  title: string;
  version: string;
  defaultServerUrl?: string;
}): {
  document: OpenApiDocument;
  enumsInferred: number;
  paginatedOperations: number;
  securitySchemes: string[];
  paginationParams: string[];
  hasStandardErrorSchema: boolean;
} {
  const { samples, authInfo, title, version, defaultServerUrl } = params;

  const origins = new Set<string>();
  if (defaultServerUrl) {
    try {
      origins.add(new URL(defaultServerUrl).origin);
    } catch {
      origins.add(defaultServerUrl);
    }
  }

  // Pool de enums seguros por (resourceFamily -> fieldKeyLower -> Set<values>)
  const resourceFamilyEnumPools = new Map<string, Map<string, Set<string>>>();
  const getResourceEnumPool = (resourceFamily: string): Map<string, Set<string>> => {
    let pool = resourceFamilyEnumPools.get(resourceFamily);
    if (!pool) {
      pool = new Map<string, Set<string>>();
      resourceFamilyEnumPools.set(resourceFamily, pool);
    }
    return pool;
  };

  const operationGroups = new Map<string, OperationGroup>();
  const errorSchemaAcc = createSchemaAccumulator();
  let standardErrorDetected = false;

  for (const sample of samples) {
    if (sample.origin) {
      origins.add(sample.origin);
    }
    const resourceFamily = resolveResourceFamily(sample.pathTemplate);
    const resourcePool = getResourceEnumPool(resourceFamily);

    const groupKey = `${sample.pathTemplate}::${sample.method}`;
    let group = operationGroups.get(groupKey);
    if (!group) {
      group = {
        method: sample.method,
        pathTemplate: sample.pathTemplate,
        resourceFamily,
        pathParams: [...sample.pathParams],
        queryParams: new Map(),
        reqAcc: createSchemaAccumulator(),
        hasReqBody: false,
        resAccByStatus: new Map(),
        evidenceIds: new Set(),
        authSchemes: new Set(),
      };
      operationGroups.set(groupKey, group);
    }

    for (const p of sample.pathParams) {
      if (!group.pathParams.includes(p)) {
        group.pathParams.push(p);
      }
    }

    for (const [qName, qVals] of sample.queryParams.entries()) {
      let existingVals = group.queryParams.get(qName);
      if (!existingVals) {
        existingVals = new Set<string>();
        group.queryParams.set(qName, existingVals);
      }
      for (const v of qVals) {
        existingVals.add(v);
      }
    }

    group.evidenceIds.add(sample.evidenceId);
    for (const scheme of sample.authSchemes) {
      group.authSchemes.add(scheme);
      authInfo.schemes.add(scheme);
    }

    // Request body / shape
    if (sample.reqJson !== undefined) {
      group.hasReqBody = true;
      addJsonValueToAccumulator(group.reqAcc, sample.reqJson, undefined, resourcePool, true);
    } else if (sample.reqShape !== undefined) {
      group.hasReqBody = true;
      addShapeSkeletonToAccumulator(
        group.reqAcc,
        sample.reqShape,
        undefined,
        sample.safeEnumSamples,
        "",
        resourcePool,
        true,
      );
    }

    // Response body / shape
    const isSuccessStatus = sample.status >= 200 && sample.status < 300;
    const isErrorStatus = sample.status >= 400;

    let statusBucket = group.resAccByStatus.get(sample.status);
    if (!statusBucket) {
      statusBucket = {
        ...(sample.statusText ? { statusText: sample.statusText } : {}),
        acc: createSchemaAccumulator(),
        hasBody: false,
      };
      group.resAccByStatus.set(sample.status, statusBucket);
    }

    if (sample.resJson !== undefined) {
      statusBucket.hasBody = true;
      addJsonValueToAccumulator(
        statusBucket.acc,
        sample.resJson,
        undefined,
        resourcePool,
        isSuccessStatus,
      );
      if (isErrorStatus && isStandardErrorShape(sample.resJson)) {
        standardErrorDetected = true;
        addJsonValueToAccumulator(errorSchemaAcc, sample.resJson, undefined, undefined, false);
      }
    } else if (sample.resShape !== undefined) {
      statusBucket.hasBody = true;
      addShapeSkeletonToAccumulator(
        statusBucket.acc,
        sample.resShape,
        undefined,
        sample.safeEnumSamples,
        "",
        resourcePool,
        isSuccessStatus,
      );
      if (isErrorStatus && isStandardErrorShape(sample.resShape)) {
        standardErrorDetected = true;
        addShapeSkeletonToAccumulator(
          errorSchemaAcc,
          sample.resShape,
          undefined,
          sample.safeEnumSamples,
          "",
          undefined,
          false,
        );
      }
    }

    // Também incorpora safeEnumSamples explícitos no pool do recurso quando 2xx
    if (isSuccessStatus && sample.safeEnumSamples) {
      for (const [rawKey, vals] of Object.entries(sample.safeEnumSamples)) {
        const lastSegment = rawKey.split(".").pop()?.replace(/\[\]$/, "") ?? rawKey;
        if (SAFE_ENUM_KEY_REGEX.test(lastSegment)) {
          const lowerKey = lastSegment.toLowerCase();
          let set = resourcePool.get(lowerKey);
          if (!set) {
            set = new Set<string>();
            resourcePool.set(lowerKey, set);
          }
          for (const v of vals) {
            if (SAFE_ENUM_VALUE_REGEX.test(v)) {
              set.add(v);
            }
          }
        }
      }
    }
  }

  // Monta paths ordenados
  const paths: Record<string, OpenApiPathItemObject> = {};
  const allPaginationParams = new Set<string>();
  let enumsInferredCount = 0;
  let paginatedOperationsCount = 0;

  const sortedGroupKeys = Array.from(operationGroups.keys()).sort((a, b) => {
    const [pathA = "", methodA = ""] = a.split("::");
    const [pathB = "", methodB = ""] = b.split("::");
    if (pathA !== pathB) {
      return pathA.localeCompare(pathB);
    }
    return (
      HTTP_METHODS_ORDER.indexOf(methodA as OpenApiHttpMethod) -
      HTTP_METHODS_ORDER.indexOf(methodB as OpenApiHttpMethod)
    );
  });

  const usedOperationIds = new Set<string>();

  for (const key of sortedGroupKeys) {
    const group = operationGroups.get(key);
    if (!group) {
      continue;
    }

    const resourcePool = getResourceEnumPool(group.resourceFamily);
    const collectedOpEnums: Record<string, string[]> = {};

    let opId = buildOperationId(group.method, group.pathTemplate);
    if (usedOperationIds.has(opId)) {
      let suffix = 2;
      while (usedOperationIds.has(`${opId}${suffix}`)) {
        suffix += 1;
      }
      opId = `${opId}${suffix}`;
    }
    usedOperationIds.add(opId);

    // Respostas por status code
    const responses: Record<string, OpenApiResponseObject> = {};
    const sortedStatuses = Array.from(group.resAccByStatus.keys()).sort((a, b) => a - b);

    let successResponseSchema: OpenApiSchemaObject | undefined;

    for (const status of sortedStatuses) {
      const bucket = group.resAccByStatus.get(status);
      if (!bucket) {
        continue;
      }
      const isSuccess = status >= 200 && status < 300;
      const resObj: OpenApiResponseObject = {
        description: defaultStatusDescription(status, bucket.statusText),
      };

      if (bucket.hasBody && bucket.acc.sampleCount > 0) {
        const builtSchema = buildSchemaFromAccumulator(
          bucket.acc,
          resourcePool,
          collectedOpEnums,
          isSuccess,
        );
        resObj.content = {
          "application/json": {
            schema: builtSchema,
          },
        };
        if (isSuccess && !successResponseSchema) {
          successResponseSchema = builtSchema;
        }
      }

      responses[String(status)] = resObj;
    }

    if (Object.keys(responses).length === 0) {
      responses["200"] = { description: "OK" };
    }

    // Parâmetros de Path e Query (+ inferência de paginação)
    const parameters: OpenApiParameterObject[] = [];
    for (const pathParam of group.pathParams) {
      parameters.push({
        name: pathParam,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }

    // Verifica se o envelope de resposta 2xx sugere paginação mesmo se alguma chamada omitiu ?page=
    if (group.method === "get" && successResponseSchema) {
      const envelopeCheck = hasPaginatedEnvelopeShape(successResponseSchema);
      if (envelopeCheck.paginated) {
        for (const inferredParam of envelopeCheck.inferredParams) {
          if (!group.queryParams.has(inferredParam)) {
            group.queryParams.set(inferredParam, new Set());
          }
        }
      }
    }

    const opPaginationParams: string[] = [];
    const sortedQueryNames = Array.from(group.queryParams.keys()).sort();
    for (const qName of sortedQueryNames) {
      const qVals = Array.from(group.queryParams.get(qName) ?? []);
      const isPag = isPaginationParam(qName);
      if (isPag) {
        opPaginationParams.push(qName);
        allPaginationParams.add(qName);
      }
      parameters.push({
        name: qName,
        in: "query",
        required: false,
        schema: inferQueryParamSchema(qName, qVals),
        ...(isPag ? { "x-cleanroom-pagination": true } : {}),
      });
    }

    // RequestBody
    let requestBody: OpenApiRequestBodyObject | undefined;
    if (group.hasReqBody && group.reqAcc.sampleCount > 0) {
      const reqSchema = buildSchemaFromAccumulator(
        group.reqAcc,
        resourcePool,
        collectedOpEnums,
        true,
      );
      requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: reqSchema,
          },
        },
      };
    }

    const enumKeysCount = Object.keys(collectedOpEnums).length;
    enumsInferredCount += enumKeysCount;

    if (opPaginationParams.length > 0) {
      paginatedOperationsCount += 1;
    }

    const opSecurity: Array<Record<string, string[]>> = [];
    if (group.authSchemes.has("bearer")) {
      opSecurity.push({ bearerAuth: [] });
    }
    if (group.authSchemes.has("cookie")) {
      opSecurity.push({ cookieAuth: [] });
    }
    if (group.authSchemes.has("apiKey")) {
      opSecurity.push({ apiKeyAuth: [] });
    }

    const paginationStyle: OpenApiPaginationExtension["style"] = opPaginationParams.some(
      (p) => p.toLowerCase() === "cursor",
    )
      ? "cursor"
      : opPaginationParams.some((p) => p.toLowerCase() === "offset")
        ? "offset"
        : "page";

    const operation: OpenApiOperationObject = {
      operationId: opId,
      summary: `${group.method.toUpperCase()} ${group.pathTemplate}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...(opSecurity.length > 0 ? { security: opSecurity } : {}),
      "x-cleanroom-evidence": Array.from(group.evidenceIds),
      ...(opPaginationParams.length > 0
        ? {
            "x-cleanroom-pagination": {
              style: paginationStyle,
              parameters: opPaginationParams,
            },
          }
        : {}),
      ...(enumKeysCount > 0 ? { "x-cleanroom-enums": collectedOpEnums } : {}),
    };

    const pathItem = paths[group.pathTemplate] ?? {};
    pathItem[group.method] = operation;
    paths[group.pathTemplate] = pathItem;
  }

  // Components: securitySchemes & StandardError
  const securitySchemes: Record<string, OpenApiSecuritySchemeObject> = {};
  const rootSecurity: Array<Record<string, string[]>> = [];

  if (authInfo.schemes.has("bearer")) {
    securitySchemes.bearerAuth = {
      type: "http",
      scheme: "bearer",
    };
    rootSecurity.push({ bearerAuth: [] });
  }
  if (authInfo.schemes.has("cookie")) {
    const firstCookieName = Array.from(authInfo.cookieNames)[0] ?? "session";
    securitySchemes.cookieAuth = {
      type: "apiKey",
      in: "cookie",
      name: firstCookieName,
    };
    rootSecurity.push({ cookieAuth: [] });
  }
  if (authInfo.schemes.has("apiKey")) {
    const firstHeaderName = Array.from(authInfo.apiKeyHeaderNames)[0] ?? "X-API-Key";
    securitySchemes.apiKeyAuth = {
      type: "apiKey",
      in: "header",
      name: firstHeaderName,
    };
    rootSecurity.push({ apiKeyAuth: [] });
  }

  const schemas: Record<string, OpenApiSchemaObject> = {};
  if (standardErrorDetected && errorSchemaAcc.sampleCount > 0) {
    const builtErrSchema = buildSchemaFromAccumulator(errorSchemaAcc, undefined, undefined, false);
    const errProps = builtErrSchema.properties ?? {};
    if (!("error" in errProps)) {
      errProps.error = { type: "string" };
    }
    if (!("message" in errProps)) {
      errProps.message = { type: "string" };
    }
    if (!("code" in errProps)) {
      errProps.code = { type: "string" };
    }
    builtErrSchema.properties = errProps;
    schemas.StandardError = builtErrSchema;
  }

  const hasSecuritySchemes = Object.keys(securitySchemes).length > 0;
  const hasSchemas = Object.keys(schemas).length > 0;

  const serversList = Array.from(origins).map((url) => ({ url }));

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title,
      version,
      description:
        "Contrato OpenAPI 3.1.0 inferido em sala limpa (clean room) a partir de tráfego e evidências de rede.",
    },
    ...(serversList.length > 0 ? { servers: serversList } : {}),
    ...(rootSecurity.length > 0 ? { security: rootSecurity } : {}),
    paths,
    ...(hasSecuritySchemes || hasSchemas
      ? {
          components: {
            ...(hasSecuritySchemes ? { securitySchemes } : {}),
            ...(hasSchemas ? { schemas } : {}),
          },
        }
      : {}),
  };

  return {
    document,
    enumsInferred: enumsInferredCount,
    paginatedOperations: paginatedOperationsCount,
    securitySchemes: Object.keys(securitySchemes),
    paginationParams: Array.from(allPaginationParams),
    hasStandardErrorSchema: standardErrorDetected,
  };
}

// ---------------------------------------------------------------------------
// Evidence & HAR Collection from PhaseContext / Options
// ---------------------------------------------------------------------------

function listAllJobEvidencesByKind(
  ctx: PhaseContext,
  kind: "network_call" | "form_schema" | "form_probe",
): Evidence[] {
  const all: Evidence[] = [];
  let cursor: string | undefined;
  do {
    const page = ctx.evidence.list(ctx.job.id, {
      kind,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function isPhaseContext(input: unknown): input is PhaseContext {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.job === "object" &&
    candidate.job !== null &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null &&
    typeof candidate.guard === "object" &&
    candidate.guard !== null &&
    typeof candidate.evidence === "object" &&
    candidate.evidence !== null
  );
}

function isHarLog(input: unknown): input is HarLog {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const obj = input as Record<string, unknown>;
  return (
    typeof obj.log === "object" &&
    obj.log !== null &&
    Array.isArray((obj.log as Record<string, unknown>).entries)
  );
}

function resolveHarFromContextOrOptions(
  ctx: PhaseContext | undefined,
  options?: HarToOpenApiOptions,
): HarLog | undefined {
  if (options?.har) {
    if (typeof options.har === "string") {
      return JSON.parse(options.har) as HarLog;
    }
    return options.har;
  }

  const candidatePaths: string[] = [];
  if (options?.harPath) {
    candidatePaths.push(options.harPath);
  }
  if (ctx) {
    const jobDir = ctx.evidence.resolveJobDir(ctx.job.id);
    candidatePaths.push(
      join(jobDir, "evidence", "har", "har.json"),
      join(jobDir, "raw", "network.har"),
      join(jobDir, "evidence", "har", "raw.har"),
    );
  }

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as HarLog;
      } catch {
        // tenta próximo caminho
      }
    }
  }

  return undefined;
}

/**
 * Executa o analisador `harToOpenApi` (`docs/04` §4.1):
 * - Agrupa chamadas (`network_call` / HAR sanitizado) por método HTTP + template de path (`{id}`).
 * - Mescla shapes de request/response por operação, inferindo primitivos, objetos, arrays,
 *   campos opcionais e enums curtos seguros (<= 8 valores para `status|state|type|kind|role|plan`).
 * - Detecta esquema de autenticação (`bearer`/`cookie`/`apiKey`), parâmetros de paginação
 *   (`page`, `cursor`, `offset`, `limit`) e formato padrão de erro (`{ error, message, code }`).
 * - Gera `jobs/<jobId>/analysis/openapi.yaml` (OpenAPI 3.1.0) com `x-cleanroom-evidence` em cada operação.
 */
export async function harToOpenApi(
  ctxOrHar: PhaseContext | HarLog,
  options?: HarToOpenApiOptions,
): Promise<HarToOpenApiResult> {
  const ctx = isPhaseContext(ctxOrHar) ? ctxOrHar : undefined;
  const directHar = isHarLog(ctxOrHar) ? ctxOrHar : undefined;
  const phaseId: PhaseId = options?.phaseId ?? "analyze";

  if (ctx) {
    try {
      ctx.guard.assertMethod("networkHar");
    } catch (err) {
      if (err instanceof MethodNotAllowedError) {
        if (options?.throwOnMethodDisabled === true) {
          throw err;
        }
        ctx.log.info({ phase: phaseId }, "harToOpenApi ignorado: methods.networkHar=false");
        const emptyDoc: OpenApiDocument = {
          openapi: "3.1.0",
          info: {
            title: options?.title ?? ctx.manifest.job.name,
            version: options?.version ?? "0.1.0",
          },
          paths: {},
        };
        return {
          skipped: true,
          document: emptyDoc,
          yaml: serializeOpenApiYaml(emptyDoc),
          operationsCount: 0,
          pathsCount: 0,
          securitySchemes: [],
          paginationParams: [],
          hasStandardErrorSchema: false,
          stats: {
            skipped: 1,
            callsAnalyzed: 0,
            pathsCount: 0,
            operationsCount: 0,
            enumsInferred: 0,
            paginatedOperations: 0,
            securitySchemesCount: 0,
            standardErrorDetected: 0,
          },
        };
      }
      throw err;
    }
  }

  const harLog = directHar ?? resolveHarFromContextOrOptions(ctx, options);
  const storedNetworkEvidences =
    options?.evidences !== undefined
      ? [...options.evidences]
      : ctx
        ? listAllJobEvidencesByKind(ctx, "network_call")
        : [];

  // Indexa evidências network_call existentes por harEntryIndex e por chave (method|url|status)
  const evidenceByHarIndex = new Map<number, Evidence>();
  const evidenceBySignature = new Map<string, Evidence[]>();
  const matchedEvidenceIds = new Set<string>();

  for (const ev of storedNetworkEvidences) {
    const data = ev.data as Partial<NetworkCallEvidenceData>;
    if (typeof data.harEntryIndex === "number") {
      evidenceByHarIndex.set(data.harEntryIndex, ev);
    }
    const method = typeof data.method === "string" ? data.method.toUpperCase() : "GET";
    const url = typeof data.url === "string" ? data.url : (ev.url ?? "");
    const status = typeof data.status === "number" ? data.status : 200;
    const sig = `${method}|${url}|${status}`;
    const list = evidenceBySignature.get(sig) ?? [];
    list.push(ev);
    evidenceBySignature.set(sig, list);
  }

  const authInfo: DetectedAuthInfo = {
    schemes: new Set<DetectedAuthScheme>(),
    cookieNames: new Set<string>(),
    apiKeyHeaderNames: new Set<string>(),
  };

  const samples: NormalizedApiSample[] = [];
  const defaultOrigin = ctx?.manifest.target.url;

  const canIncludeUrl = (rawUrl: string): boolean => {
    if (!ctx) {
      return true;
    }
    try {
      const resolved = defaultOrigin ? new URL(rawUrl, defaultOrigin).toString() : rawUrl;
      return ctx.guard.canNavigate(resolved);
    } catch {
      return true;
    }
  };

  // 1. Processa entradas do HAR (quando disponível)
  if (harLog?.log?.entries) {
    for (let i = 0; i < harLog.log.entries.length; i++) {
      const entry = harLog.log.entries[i];
      if (!entry || !isEligibleApiHarEntry(entry)) {
        continue;
      }

      if (!canIncludeUrl(entry.request.url)) {
        continue;
      }

      const method = toOpenApiHttpMethod(entry.request.method);
      if (!method) {
        continue;
      }

      const entryAuth = detectAuthFromHarEntry(entry, authInfo);
      const { origin, pathTemplate, pathParams } = normalizeOpenApiPathTemplate(entry.request.url);
      const queryParams = extractQueryParamsMap(entry.request.url, entry.request.queryString);
      const reqJson = tryParseJsonBody(entry.request.postData?.text);
      const resJson = tryParseJsonBody(entry.response.content?.text);
      const safeEnums: Record<string, string[]> = {};
      if (reqJson !== undefined) {
        extractSafeEnumsFromJson(reqJson, safeEnums);
      }
      if (resJson !== undefined) {
        extractSafeEnumsFromJson(resJson, safeEnums);
      }

      // Vincula à evidência network_call existente ou registra no EvidenceStore
      const sig = `${method.toUpperCase()}|${entry.request.url}|${entry.response.status}`;
      let linkedEv = evidenceByHarIndex.get(i) ?? evidenceBySignature.get(sig)?.[0];

      if (!linkedEv && ctx) {
        const callSha256 = createHash("sha256")
          .update(
            JSON.stringify({
              method: method.toUpperCase(),
              url: entry.request.url,
              status: entry.response.status,
              harEntryIndex: i,
            }),
          )
          .digest("hex");

        const summary =
          `network_call ${method.toUpperCase()} ${pathTemplate} -> ${entry.response.status}`.slice(
            0,
            300,
          );
        linkedEv = ctx.evidence.put({
          jobId: ctx.job.id,
          kind: "network_call",
          phase: phaseId,
          url: entry.request.url,
          sha256: callSha256,
          summary,
          data: {
            method: method.toUpperCase(),
            url: entry.request.url,
            urlTemplate: origin ? `${origin}${pathTemplate}` : pathTemplate,
            pathTemplate,
            status: entry.response.status,
            ...(entry.response.statusText ? { statusText: entry.response.statusText } : {}),
            ...(Object.keys(safeEnums).length > 0 ? { safeEnumSamples: safeEnums } : {}),
            ...(entryAuth.length > 0 ? { authSchemes: entryAuth } : {}),
            harEntryIndex: i,
          },
        });
      }

      if (linkedEv) {
        matchedEvidenceIds.add(linkedEv.id);
        const linkedData = linkedEv.data as Partial<NetworkCallEvidenceData>;
        if (Array.isArray(linkedData.authSchemes)) {
          for (const s of linkedData.authSchemes) {
            if (!entryAuth.includes(s)) {
              entryAuth.push(s);
            }
            authInfo.schemes.add(s);
          }
        }
        if (Array.isArray(linkedData.queryParams)) {
          for (const q of linkedData.queryParams) {
            if (!queryParams.has(q) && !SENSITIVE_QUERY_PARAM_REGEX.test(q)) {
              queryParams.set(q, []);
            }
          }
        }
        if (linkedData.safeEnumSamples && typeof linkedData.safeEnumSamples === "object") {
          for (const [k, vals] of Object.entries(linkedData.safeEnumSamples)) {
            if (Array.isArray(vals)) {
              const targetList = safeEnums[k] ?? [];
              for (const v of vals) {
                if (typeof v === "string" && !targetList.includes(v)) {
                  targetList.push(v);
                }
              }
              safeEnums[k] = targetList;
            }
          }
        }
      }

      const fallbackEvId =
        linkedEv?.id ??
        `ev_${createHash("sha256").update(`${sig}|${i}`).digest("hex").slice(0, 26)}`;

      samples.push({
        method,
        url: entry.request.url,
        ...(origin ? { origin } : {}),
        pathTemplate,
        pathParams,
        status: entry.response.status,
        ...(entry.response.statusText ? { statusText: entry.response.statusText } : {}),
        queryParams,
        ...(reqJson !== undefined ? { reqJson } : {}),
        ...(resJson !== undefined ? { resJson } : {}),
        ...(Object.keys(safeEnums).length > 0 ? { safeEnumSamples: safeEnums } : {}),
        authSchemes: entryAuth,
        evidenceId: fallbackEvId,
      });
    }
  }

  // 2. Processa evidências network_call não cobertas pelo HAR (ou quando apenas evidências foram fornecidas)
  for (const ev of storedNetworkEvidences) {
    if (matchedEvidenceIds.has(ev.id)) {
      continue;
    }
    const data = ev.data as Partial<NetworkCallEvidenceData> & Record<string, unknown>;
    const rawUrl = typeof data.url === "string" ? data.url : (ev.url ?? data.pathTemplate ?? "");
    if (!rawUrl || !canIncludeUrl(rawUrl)) {
      continue;
    }

    const method = toOpenApiHttpMethod(typeof data.method === "string" ? data.method : "GET");
    if (!method) {
      continue;
    }

    const normalized = normalizeOpenApiPathTemplate(
      typeof data.pathTemplate === "string" && data.pathTemplate.startsWith("/")
        ? data.pathTemplate
        : rawUrl,
    );
    const urlOrigin = normalizeOpenApiPathTemplate(rawUrl).origin;
    const status = typeof data.status === "number" ? data.status : 200;
    const statusText = typeof data.statusText === "string" ? data.statusText : undefined;

    const queryParams = extractQueryParamsMap(
      rawUrl,
      undefined,
      Array.isArray(data.queryParams)
        ? data.queryParams.filter((x): x is string => typeof x === "string")
        : undefined,
    );

    const authSchemes: DetectedAuthScheme[] = Array.isArray(data.authSchemes)
      ? data.authSchemes.filter(
          (x): x is DetectedAuthScheme => x === "bearer" || x === "cookie" || x === "apiKey",
        )
      : [];
    for (const s of authSchemes) {
      authInfo.schemes.add(s);
    }

    const safeEnumSamples =
      typeof data.safeEnumSamples === "object" && data.safeEnumSamples !== null
        ? (data.safeEnumSamples as Record<string, string[]>)
        : undefined;

    samples.push({
      method,
      url: rawUrl,
      ...(urlOrigin ? { origin: urlOrigin } : {}),
      pathTemplate: normalized.pathTemplate,
      pathParams: normalized.pathParams,
      status,
      ...(statusText ? { statusText } : {}),
      queryParams,
      ...(data.reqBody !== undefined ? { reqJson: data.reqBody } : {}),
      ...(data.resBody !== undefined ? { resJson: data.resBody } : {}),
      ...(data.reqShape !== undefined ? { reqShape: data.reqShape } : {}),
      ...(data.resShape !== undefined ? { resShape: data.resShape } : {}),
      ...(safeEnumSamples ? { safeEnumSamples } : {}),
      authSchemes,
      evidenceId: ev.id,
    });
  }

  // 3. Processa options.networkCalls diretos se fornecidos
  if (options?.networkCalls) {
    for (let idx = 0; idx < options.networkCalls.length; idx++) {
      const call = options.networkCalls[idx];
      if (!call || !canIncludeUrl(call.url)) {
        continue;
      }
      const method = toOpenApiHttpMethod(call.method);
      if (!method) {
        continue;
      }
      const normalized = normalizeOpenApiPathTemplate(call.pathTemplate || call.url);
      const urlOrigin = normalizeOpenApiPathTemplate(call.url).origin;
      const queryParams = extractQueryParamsMap(call.url, undefined, call.queryParams);
      const authSchemes = call.authSchemes ?? [];
      for (const s of authSchemes) {
        authInfo.schemes.add(s);
      }

      let evId = `ev_${createHash("sha256").update(`${call.method}|${call.url}|${call.status}|${idx}`).digest("hex").slice(0, 26)}`;
      if (ctx) {
        const stored = ctx.evidence.put({
          jobId: ctx.job.id,
          kind: "network_call",
          phase: phaseId,
          url: call.url,
          sha256: createHash("sha256")
            .update(canonicalJson({ method: call.method, url: call.url, status: call.status, idx }))
            .digest("hex"),
          summary: `network_call ${call.method} ${normalized.pathTemplate} -> ${call.status}`,
          data: call as unknown as Record<string, unknown>,
        });
        evId = stored.id;
      }

      samples.push({
        method,
        url: call.url,
        ...(urlOrigin ? { origin: urlOrigin } : {}),
        pathTemplate: normalized.pathTemplate,
        pathParams: normalized.pathParams,
        status: call.status,
        ...(call.statusText ? { statusText: call.statusText } : {}),
        queryParams,
        ...(call.reqShape !== undefined ? { reqShape: call.reqShape } : {}),
        ...(call.resShape !== undefined ? { resShape: call.resShape } : {}),
        ...(call.safeEnumSamples ? { safeEnumSamples: call.safeEnumSamples } : {}),
        authSchemes: [...authSchemes],
        evidenceId: evId,
      });
    }
  }

  // 4. Enriquece com form_schema para endpoints /api/* caso existam no EvidenceStore
  if (ctx) {
    const formSchemas = listAllJobEvidencesByKind(ctx, "form_schema");
    for (const formEv of formSchemas) {
      const form = formEv.data as unknown as Partial<FormSchema>;
      if (!form.action || typeof form.action !== "string") {
        continue;
      }
      const normalized = normalizeOpenApiPathTemplate(form.action);
      if (!normalized.pathTemplate.startsWith("/api/")) {
        continue;
      }
      const method = toOpenApiHttpMethod(typeof form.method === "string" ? form.method : "POST");
      if (!method || method === "get") {
        continue;
      }
      const reqShape: Record<string, string> = {};
      if (Array.isArray(form.fields)) {
        for (const f of form.fields) {
          if (f && typeof f.name === "string" && f.name.length > 0) {
            reqShape[f.name] = f.type === "number" ? "number" : "string";
          }
        }
      }
      if (Object.keys(reqShape).length > 0) {
        samples.push({
          method,
          url: form.action,
          pathTemplate: normalized.pathTemplate,
          pathParams: normalized.pathParams,
          status: 201,
          queryParams: new Map(),
          reqShape,
          authSchemes: [],
          evidenceId: formEv.id,
        });
      }
    }
  }

  const built = buildOpenApiFromNormalizedSamples({
    samples,
    authInfo,
    title: options?.title ?? ctx?.manifest.job.name ?? "Cleanroom Inferred API",
    version: options?.version ?? "0.1.0",
    ...(defaultOrigin ? { defaultServerUrl: defaultOrigin } : {}),
  });

  const yamlText = serializeOpenApiYaml(built.document);

  let outputPath: string | undefined = options?.outputPath;
  if (!outputPath && ctx) {
    const jobDir = ctx.evidence.resolveJobDir(ctx.job.id);
    outputPath = join(jobDir, "analysis", "openapi.yaml");
  }

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, yamlText, "utf8");
  }

  const pathsCount = Object.keys(built.document.paths).length;
  let operationsCount = 0;
  for (const item of Object.values(built.document.paths)) {
    for (const m of HTTP_METHODS_ORDER) {
      if (item[m] !== undefined) {
        operationsCount += 1;
      }
    }
  }

  const stats: HarToOpenApiStats = {
    skipped: 0,
    callsAnalyzed: samples.length,
    pathsCount,
    operationsCount,
    enumsInferred: built.enumsInferred,
    paginatedOperations: built.paginatedOperations,
    securitySchemesCount: built.securitySchemes.length,
    standardErrorDetected: built.hasStandardErrorSchema ? 1 : 0,
  };

  if (ctx) {
    const checkpoint: HarToOpenApiCheckpoint = {
      outputPath: outputPath ?? "analysis/openapi.yaml",
      operationsCount,
      pathsCount,
      updatedAt: new Date().toISOString(),
    };
    ctx.saveCheckpoint(checkpoint);
    ctx.emit({
      type: "har_to_openapi_completed",
      phase: phaseId,
      data: stats,
    });
  }

  return {
    skipped: false,
    document: built.document,
    yaml: yamlText,
    ...(outputPath ? { outputPath } : {}),
    operationsCount,
    pathsCount,
    securitySchemes: built.securitySchemes,
    paginationParams: built.paginationParams,
    hasStandardErrorSchema: built.hasStandardErrorSchema,
    stats,
  };
}

export const runHarToOpenApi = harToOpenApi;

export function createHarToOpenApiPhase(options?: HarToOpenApiOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  return {
    id: phaseId,
    isEnabled(manifest): boolean {
      return manifest.target.type !== "repo" && manifest.methods.networkHar === true;
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await harToOpenApi(ctx, options);
      return {
        status: "ok",
        stats: result.stats,
      };
    },
  };
}

export const harToOpenApiPhase: Phase = createHarToOpenApiPhase();
