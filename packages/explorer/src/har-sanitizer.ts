import { createHash } from "node:crypto";
import type {
  DetectedAuthScheme,
  HarEntry,
  HarHeader,
  HarLog,
  HarPostData,
  HarQueryParam,
  HarRequest,
  HarResponse,
  HarSanitizationStats,
  NetworkCallEvidenceData,
  PublicScriptInfo,
  SanitizedHarResult,
} from "@cleanroom/core";

/**
 * Regex para identificação de campos e chaves sensíveis em query params,
 * form data e corpos JSON/texto (docs/04 Fase 3, docs/10 §5).
 */
export const SENSITIVE_KEY_REGEX = /token|secret|password|session|key|auth/i;

/**
 * Chaves seguras elegíveis para retenção de amostras de enums curtos sem risco de PII
 * (refinamento arquitetural F1-08: status, state, type, kind, role, plan).
 */
export const SAFE_ENUM_KEY_REGEX = /^(?:status|state|type|kind|role|plan)$/i;

/**
 * Padrão estrito para valores seguros de enums curtos (2 a 24 caracteres alfanuméricos/hífen/underscore).
 */
export const SAFE_ENUM_VALUE_REGEX = /^[a-z0-9_-]{2,24}$/i;

/**
 * Headers estritamente proibidos em HAR persistido (case-insensitive).
 */
export const FORBIDDEN_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "x-api-key",
  "x-csrf-token",
  "proxy-authorization",
]);

/**
 * Teto máximo de tamanho de corpo (256 KB = 262.144 bytes).
 * Corpos acima deste limite são truncados de forma segura.
 */
export const MAX_BODY_BYTES = 256 * 1024; // 262144

export const REDACTED_MARKER = "[REDACTED]";
export const TRUNCATED_MARKER = " [TRUNCATED: body exceeded 256KB]";

export interface HarSanitizerOptions {
  /** Se deve purgar todos os cookies das requisições e respostas (default: true). */
  purgeCookies?: boolean | undefined;
  /** Se deve truncar corpos acima de 256 KB (default: true). */
  truncateBodies?: boolean | undefined;
  /** Teto de bytes para truncamento (default: 262144 = 256 KB). */
  maxBodyBytes?: number | undefined;
  /** Se deve omitir corpos binários grandes (imagens, fontes, áudio) (default: true). */
  omitBinaryBodies?: boolean | undefined;
  /** Padrão adicional para chaves sensíveis. */
  additionalSensitivePattern?: RegExp | undefined;
}

/**
 * Infere o esqueleto recursivo de tipos JSON sem quaisquer valores literais (Clean Room).
 * Suporta primitivos, objetos com ordenação canônica de chaves e arrays com mesclagem de shapes.
 */
export function inferJsonShape(value: unknown): unknown {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }

  const type = typeof value;
  if (type === "string") {
    return "string";
  }
  if (type === "number" || type === "bigint") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }

    // Se todos forem primitivos simples
    const firstItem = value[0];
    const isAllSamePrimitive = value.every(
      (item) => typeof item === typeof firstItem && item !== null,
    );
    if (isAllSamePrimitive && typeof firstItem !== "object") {
      return [inferJsonShape(firstItem)];
    }

    // Se forem objetos, mescla chaves de todos os elementos para não perder campos opcionais
    const isAllObjects = value.every(
      (item) => typeof item === "object" && item !== null && !Array.isArray(item),
    );
    if (isAllObjects) {
      const merged: Record<string, unknown> = {};
      const allKeys = new Set<string>();
      for (const obj of value as Record<string, unknown>[]) {
        for (const k of Object.keys(obj)) {
          allKeys.add(k);
        }
      }
      const sortedKeys = Array.from(allKeys).sort();
      for (const k of sortedKeys) {
        // Encontra o primeiro valor não nulo/definido deste campo
        let sampleVal: unknown;
        for (const obj of value as Record<string, unknown>[]) {
          if (obj[k] !== undefined) {
            sampleVal = obj[k];
            break;
          }
        }
        merged[k] = inferJsonShape(sampleVal);
      }
      return [merged];
    }

    // Caso heterogêneo ou genérico: usa o shape do primeiro elemento
    return [inferJsonShape(value[0])];
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const shape: Record<string, unknown> = {};
    const sortedKeys = Object.keys(obj).sort();
    for (const k of sortedKeys) {
      shape[k] = inferJsonShape(obj[k]);
    }
    return shape;
  }

  return "unknown";
}

/**
 * Extrai amostras seguras de valores de enum apenas para chaves permitidas
 * (`status`, `state`, `type`, `kind`, `role`, `plan`) com strings curtas (`^[a-z0-9_-]{2,24}$`).
 */
export function extractSafeEnumSamples(
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
      extractSafeEnumSamples(item, target, nextPath);
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
        const keysToRecord = [propPath, k.toLowerCase()];
        for (const keyName of keysToRecord) {
          const list = target[keyName] ?? [];
          if (!list.includes(v)) {
            list.push(v);
            target[keyName] = list;
          }
        }
      } else if (typeof v === "object" && v !== null) {
        extractSafeEnumSamples(v, target, propPath);
      }
    }
  }

  return target;
}

/**
 * Detecta esquemas de autenticação (`bearer`, `cookie`, `apiKey`) presentes na entrada HAR
 * antes que headers e cookies sensíveis sejam removidos na sanitização.
 */
export function detectEntryAuthSchemes(entry: HarEntry): DetectedAuthScheme[] {
  const schemes = new Set<DetectedAuthScheme>();

  for (const h of entry.request?.headers ?? []) {
    const lowerName = h.name.toLowerCase();
    const lowerVal = h.value.trim().toLowerCase();
    if (lowerName === "authorization" && lowerVal.startsWith("bearer")) {
      schemes.add("bearer");
    } else if (lowerName === "cookie" && lowerVal.length > 0) {
      schemes.add("cookie");
    } else if (lowerName === "x-api-key" || lowerName === "api-key") {
      schemes.add("apiKey");
    }
  }

  for (const h of entry.response?.headers ?? []) {
    if (h.name.toLowerCase() === "set-cookie" && h.value.trim().length > 0) {
      schemes.add("cookie");
    }
  }

  if ((entry.request?.cookies?.length ?? 0) > 0 || (entry.response?.cookies?.length ?? 0) > 0) {
    schemes.add("cookie");
  }

  return Array.from(schemes);
}

/**
 * Normaliza uma URL substituindo identificadores dinâmicos de path por `{id}`
 * (UUIDs, números puros, hashes hexadecimais, slugs com IDs).
 */
export function normalizeUrlTemplate(inputUrl: string | URL): {
  urlTemplate: string;
  pathTemplate: string;
} {
  let parsed: URL;
  try {
    parsed = typeof inputUrl === "string" ? new URL(inputUrl) : new URL(inputUrl.toString());
  } catch {
    // Se for URL relativa ou inválida
    const dummyBase = "https://cleanroom.local";
    try {
      parsed = new URL(String(inputUrl), dummyBase);
    } catch {
      return { urlTemplate: String(inputUrl), pathTemplate: String(inputUrl) };
    }
  }

  const rawPath = parsed.pathname;
  const segments = rawPath.split("/").filter((s) => s.length > 0);

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PURE_NUMERIC_REGEX = /^\d+$/;
  const HEX_HASH_REGEX = /^[0-9a-f]{8,64}$/i;
  const PREFIXED_ID_REGEX =
    /^(?:proj|user|item|order|org|team|st|task|run|job|doc|plan|sub)[-_][a-zA-Z0-9]+$/i;
  const SLUG_ID_REGEX = /-[0-9a-f]{6,}$/i;

  const templatedSegments = segments.map((seg) => {
    if (UUID_REGEX.test(seg)) {
      return "{id}";
    }
    if (PURE_NUMERIC_REGEX.test(seg)) {
      return "{id}";
    }
    if (HEX_HASH_REGEX.test(seg)) {
      return "{id}";
    }
    if (PREFIXED_ID_REGEX.test(seg)) {
      return "{id}";
    }
    if (SLUG_ID_REGEX.test(seg)) {
      return "{id}";
    }
    return seg;
  });

  const pathTemplate = `/${templatedSegments.join("/")}`;
  const urlTemplate = `${parsed.origin}${pathTemplate}`;

  return { urlTemplate, pathTemplate };
}

/**
 * Sanitiza valores de query params na URL original string.
 */
function sanitizeUrlQuery(rawUrl: string, pattern: RegExp): { url: string; redactedCount: number } {
  let redactedCount = 0;
  try {
    const parsed = new URL(rawUrl);

    // Redigir credenciais inline (ex: http://user:pass@host)
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED_MARKER;
      parsed.password = REDACTED_MARKER;
      redactedCount++;
    }

    const params = new URLSearchParams(parsed.search);
    let mutated = false;
    for (const [key, val] of Array.from(params.entries())) {
      if (pattern.test(key)) {
        params.set(key, REDACTED_MARKER);
        mutated = true;
        redactedCount++;
      }
    }
    if (mutated) {
      parsed.search = params.toString();
    }
    return { url: parsed.toString(), redactedCount };
  } catch {
    // Se não for URL parseável, aplica regex de substituição segura
    let url = rawUrl;
    url = url.replace(
      /([?&](?:[a-zA-Z0-9_-]*(?:token|secret|password|session|key|auth)[a-zA-Z0-9_-]*)=)([^&#\s]+)/gi,
      (_match, p1) => {
        redactedCount++;
        return `${p1}${REDACTED_MARKER}`;
      },
    );
    return { url, redactedCount };
  }
}

/**
 * Sanitiza recursivamente objetos e arrays JSON mascarando valores cujas chaves correspondam ao regex.
 */
function sanitizeJsonPayload(
  data: unknown,
  pattern: RegExp,
): { sanitized: unknown; redactedCount: number } {
  let redactedCount = 0;

  function traverse(val: unknown, currentKey?: string): unknown {
    if (val === null || val === undefined) {
      return val;
    }

    if (currentKey && pattern.test(currentKey)) {
      redactedCount++;
      return REDACTED_MARKER;
    }

    if (Array.isArray(val)) {
      return val.map((item) => traverse(item));
    }

    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (pattern.test(k)) {
          result[k] = REDACTED_MARKER;
          redactedCount++;
        } else {
          result[k] = traverse(v, k);
        }
      }
      return result;
    }

    return val;
  }

  return { sanitized: traverse(data), redactedCount };
}

/**
 * Trunca uma string de corpo se exceder `maxBytes`, garantindo segurança e aviso de truncamento.
 */
function truncateBodyString(
  text: string | undefined,
  maxBytes: number,
): { text: string | undefined; truncated: boolean } {
  if (!text) {
    return { text, truncated: false };
  }

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  // Trunca a string para que caiba no limite de bytes
  let truncatedStr = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncatedStr, "utf8") > maxBytes) {
    truncatedStr = truncatedStr.slice(0, truncatedStr.length - 100);
  }

  return {
    text: `${truncatedStr}${TRUNCATED_MARKER}`,
    truncated: true,
  };
}

/**
 * Verifica se uma requisição é de API (fetch, xhr ou endpoint de dados).
 */
export function isApiRequest(entry: HarEntry): boolean {
  const resourceType = entry._resourceType?.toLowerCase();
  if (resourceType === "fetch" || resourceType === "xhr") {
    return true;
  }

  const reqUrl = entry.request.url.toLowerCase();
  const acceptHeader =
    entry.request.headers.find((h) => h.name.toLowerCase() === "accept")?.value.toLowerCase() ?? "";
  const reqContentType =
    entry.request.headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  const resContentType =
    entry.response.content.mimeType?.toLowerCase() ??
    entry.response.headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ??
    "";

  if (
    acceptHeader.includes("application/json") ||
    reqContentType.includes("application/json") ||
    resContentType.includes("application/json") ||
    resContentType.includes("application/ld+json") ||
    resContentType.includes("application/hal+json")
  ) {
    return true;
  }

  const isXhrHeader = entry.request.headers.some(
    (h) =>
      h.name.toLowerCase() === "x-requested-with" && h.value.toLowerCase() === "xmlhttprequest",
  );
  if (isXhrHeader) {
    return true;
  }

  // URL típica de API
  try {
    const parsed = new URL(entry.request.url);
    const path = parsed.pathname.toLowerCase();
    if (
      path.startsWith("/api/") ||
      path.startsWith("/v1/") ||
      path.startsWith("/v2/") ||
      path.startsWith("/v3/") ||
      path.startsWith("/graphql") ||
      path.startsWith("/rest/")
    ) {
      // Ignora assets estáticos mesmo se servidos sob /api/ (raro)
      if (!/\.(?:js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|map)$/i.test(path)) {
        return true;
      }
    }
  } catch {
    // ignora
  }

  return false;
}

/**
 * Sanitiza estritamente um log HAR completo de acordo com os padrões cleanroom
 * (docs/04 Fase 3, docs/10 §5, §6).
 */
export function sanitizeHar(
  rawHarInput: HarLog | string,
  options?: HarSanitizerOptions,
): SanitizedHarResult {
  const purgeCookies = options?.purgeCookies ?? true;
  const truncateBodies = options?.truncateBodies ?? true;
  const maxBodyBytes = options?.maxBodyBytes ?? MAX_BODY_BYTES;
  const omitBinaryBodies = options?.omitBinaryBodies ?? true;
  const pattern = options?.additionalSensitivePattern
    ? new RegExp(`${SENSITIVE_KEY_REGEX.source}|${options.additionalSensitivePattern.source}`, "i")
    : SENSITIVE_KEY_REGEX;

  let harObj: HarLog;
  if (typeof rawHarInput === "string") {
    harObj = JSON.parse(rawHarInput) as HarLog;
  } else {
    // Deep clone para não mutar a entrada original
    harObj = JSON.parse(JSON.stringify(rawHarInput)) as HarLog;
  }

  const stats: HarSanitizationStats = {
    entriesCount: harObj.log?.entries?.length ?? 0,
    headersRemoved: 0,
    cookiesPurged: 0,
    queryParamsRedacted: 0,
    bodyFieldsRedacted: 0,
    bodiesTruncated: 0,
    scriptsIndexed: 0,
  };

  const apiCalls: NetworkCallEvidenceData[] = [];
  const publicScripts: PublicScriptInfo[] = [];

  const entries = harObj.log?.entries ?? [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }

    // 0. Captura metadados seguros de auth e query params antes da remoção de headers/cookies
    const detectedAuthSchemes = detectEntryAuthSchemes(entry);
    const observedQueryParamNames = new Set<string>();
    if (Array.isArray(entry.request.queryString)) {
      for (const q of entry.request.queryString) {
        if (q.name && !pattern.test(q.name)) {
          observedQueryParamNames.add(q.name);
        }
      }
    }
    try {
      const parsedReqUrl = new URL(entry.request.url);
      parsedReqUrl.searchParams.forEach((_v, k) => {
        if (k && !pattern.test(k)) {
          observedQueryParamNames.add(k);
        }
      });
    } catch {
      // ignora URL relativa
    }

    // 1. Sanitização da URL e query params
    const sanitizedUrlResult = sanitizeUrlQuery(entry.request.url, pattern);
    entry.request.url = sanitizedUrlResult.url;
    stats.queryParamsRedacted += sanitizedUrlResult.redactedCount;

    if (Array.isArray(entry.request.queryString)) {
      for (const q of entry.request.queryString) {
        if (pattern.test(q.name)) {
          q.value = REDACTED_MARKER;
          stats.queryParamsRedacted++;
        }
      }
    }

    // 2. Remoção de cookies (request e response)
    if (purgeCookies) {
      if (entry.request.cookies && entry.request.cookies.length > 0) {
        stats.cookiesPurged += entry.request.cookies.length;
        entry.request.cookies = [];
      }
      if (entry.response.cookies && entry.response.cookies.length > 0) {
        stats.cookiesPurged += entry.response.cookies.length;
        entry.response.cookies = [];
      }
    }

    // 3. Remoção de headers sensíveis (request)
    if (Array.isArray(entry.request.headers)) {
      const initialHeaderCount = entry.request.headers.length;
      entry.request.headers = entry.request.headers.filter((h) => {
        const lowerName = h.name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lowerName)) {
          return false;
        }
        if (
          pattern.test(lowerName) &&
          (lowerName.includes("token") || lowerName.includes("auth"))
        ) {
          return false;
        }
        return true;
      });
      stats.headersRemoved += initialHeaderCount - entry.request.headers.length;
    }

    // 4. Remoção de headers sensíveis (response)
    if (Array.isArray(entry.response.headers)) {
      const initialHeaderCount = entry.response.headers.length;
      entry.response.headers = entry.response.headers.filter((h) => {
        const lowerName = h.name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lowerName)) {
          return false;
        }
        if (
          pattern.test(lowerName) &&
          (lowerName.includes("token") || lowerName.includes("auth"))
        ) {
          return false;
        }
        return true;
      });
      stats.headersRemoved += initialHeaderCount - entry.response.headers.length;
    }

    // 5. Sanitização de Request PostData (Body)
    if (entry.request.postData) {
      const postData = entry.request.postData;
      if (Array.isArray(postData.params)) {
        for (const p of postData.params) {
          if (pattern.test(p.name)) {
            p.value = REDACTED_MARKER;
            stats.bodyFieldsRedacted++;
          }
        }
      }

      if (postData.text) {
        const mime = postData.mimeType?.toLowerCase() ?? "";
        let isJson = mime.includes("application/json") || mime.includes("json");
        let parsedJson: unknown;

        if (!isJson && (postData.text.startsWith("{") || postData.text.startsWith("["))) {
          try {
            parsedJson = JSON.parse(postData.text);
            isJson = true;
          } catch {
            isJson = false;
          }
        } else if (isJson) {
          try {
            parsedJson = JSON.parse(postData.text);
          } catch {
            isJson = false;
          }
        }

        if (isJson && parsedJson !== undefined) {
          const jsonRes = sanitizeJsonPayload(parsedJson, pattern);
          postData.text = JSON.stringify(jsonRes.sanitized);
          stats.bodyFieldsRedacted += jsonRes.redactedCount;
        } else if (mime.includes("application/x-www-form-urlencoded")) {
          try {
            const formParams = new URLSearchParams(postData.text);
            let mutated = false;
            for (const [k] of Array.from(formParams.entries())) {
              if (pattern.test(k)) {
                formParams.set(k, REDACTED_MARKER);
                stats.bodyFieldsRedacted++;
                mutated = true;
              }
            }
            if (mutated) {
              postData.text = formParams.toString();
            }
          } catch {
            // ignora
          }
        }

        // Truncamento se exceder o teto
        if (truncateBodies) {
          const truncRes = truncateBodyString(postData.text, maxBodyBytes);
          if (truncRes.truncated && truncRes.text !== undefined) {
            postData.text = truncRes.text;
            stats.bodiesTruncated++;
          }
        }
      }
    }

    // 6. Sanitização de Response Content (Body)
    if (entry.response.content) {
      const content = entry.response.content;
      const mime = content.mimeType?.toLowerCase() ?? "";
      const isBinary =
        mime.startsWith("image/") ||
        mime.startsWith("font/") ||
        mime.startsWith("audio/") ||
        mime.startsWith("video/") ||
        mime.includes("wasm") ||
        mime.includes("octet-stream") ||
        mime.includes("pdf");

      if (isBinary && omitBinaryBodies && content.text) {
        // Omitir corpos binários grandes para não inchar o HAR
        content.text = "";
        content.encoding = "omitted";
      } else if (content.text) {
        let isJson = mime.includes("application/json") || mime.includes("json");
        let parsedJson: unknown;

        if (!isJson && (content.text.startsWith("{") || content.text.startsWith("["))) {
          try {
            parsedJson = JSON.parse(content.text);
            isJson = true;
          } catch {
            isJson = false;
          }
        } else if (isJson) {
          try {
            parsedJson = JSON.parse(content.text);
          } catch {
            isJson = false;
          }
        }

        if (isJson && parsedJson !== undefined) {
          const jsonRes = sanitizeJsonPayload(parsedJson, pattern);
          content.text = JSON.stringify(jsonRes.sanitized);
          stats.bodyFieldsRedacted += jsonRes.redactedCount;
        }

        // Truncamento se exceder o teto
        if (truncateBodies) {
          const truncRes = truncateBodyString(content.text, maxBodyBytes);
          if (truncRes.truncated && truncRes.text !== undefined) {
            content.text = truncRes.text;
            stats.bodiesTruncated++;
          }
        }
      }
    }

    // 7. Extração de metadados de Scripts JS Públicos (docs/04 §4.3 e refinamento do Pai do Kraken)
    const isScript =
      entry._resourceType?.toLowerCase() === "script" ||
      entry.request.url.toLowerCase().endsWith(".js") ||
      entry.response.content?.mimeType?.toLowerCase().includes("javascript");

    if (isScript) {
      stats.scriptsIndexed++;
      const text = entry.response.content?.text ?? "";
      const scriptSha256 = createHash("sha256").update(text).digest("hex");
      const sourceMapMatch = text.match(/\/\/#\s*sourceMappingURL=([^\s]+)/i);
      const hasSourceMap = Boolean(sourceMapMatch);
      let sourceMapUrl: string | undefined;

      if (sourceMapMatch?.[1]) {
        try {
          sourceMapUrl = new URL(sourceMapMatch[1], entry.request.url).toString();
        } catch {
          sourceMapUrl = sourceMapMatch[1];
        }
      }

      publicScripts.push({
        url: entry.request.url,
        sha256: scriptSha256,
        size: entry.response.content?.size ?? Buffer.byteLength(text, "utf8"),
        hasSourceMap,
        ...(sourceMapUrl ? { sourceMapUrl } : {}),
      });
    }

    // 8. Se for requisição de API, indexa como NetworkCallEvidenceData
    if (isApiRequest(entry)) {
      const { urlTemplate, pathTemplate } = normalizeUrlTemplate(entry.request.url);

      // Inferência recursiva de shape do request e coleta de enums seguros
      let reqShape: unknown;
      const safeEnums: Record<string, string[]> = {};
      if (entry.request.postData?.text) {
        try {
          const parsed = JSON.parse(entry.request.postData.text);
          reqShape = inferJsonShape(parsed);
          extractSafeEnumSamples(parsed, safeEnums);
        } catch {
          if (entry.request.postData.params && entry.request.postData.params.length > 0) {
            const formShape: Record<string, string> = {};
            for (const p of entry.request.postData.params) {
              formShape[p.name] = "string";
            }
            reqShape = formShape;
          }
        }
      }

      // Inferência recursiva de shape da response e coleta de enums seguros
      let resShape: unknown;
      if (entry.response.content?.text) {
        try {
          const parsed = JSON.parse(entry.response.content.text);
          resShape = inferJsonShape(parsed);
          extractSafeEnumSamples(parsed, safeEnums);
        } catch {
          // ignora
        }
      }

      const reqContentType =
        entry.request.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ??
        entry.request.postData?.mimeType;
      const resContentType =
        entry.response.content?.mimeType ??
        entry.response.headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
      const queryParamsList = Array.from(observedQueryParamNames);

      apiCalls.push({
        method: entry.request.method.toUpperCase(),
        url: entry.request.url,
        urlTemplate,
        pathTemplate,
        status: entry.response.status,
        ...(entry.response.statusText ? { statusText: entry.response.statusText } : {}),
        resourceType: entry._resourceType ?? "fetch",
        ...(reqContentType ? { reqContentType } : {}),
        ...(resContentType ? { resContentType } : {}),
        ...(reqShape !== undefined ? { reqShape } : {}),
        ...(resShape !== undefined ? { resShape } : {}),
        ...(Object.keys(safeEnums).length > 0 ? { safeEnumSamples: safeEnums } : {}),
        ...(detectedAuthSchemes.length > 0 ? { authSchemes: detectedAuthSchemes } : {}),
        ...(queryParamsList.length > 0 ? { queryParams: queryParamsList } : {}),
        ...(entry.request.bodySize !== undefined && entry.request.bodySize >= 0
          ? { reqSizeBytes: entry.request.bodySize }
          : {}),
        ...(entry.response.content?.size !== undefined
          ? { resSizeBytes: entry.response.content.size }
          : {}),
        ...(entry.time !== undefined ? { durationMs: Math.round(entry.time) } : {}),
        harEntryIndex: i,
        ...(entry.startedDateTime ? { timestamp: entry.startedDateTime } : {}),
      });
    }
  }

  return {
    har: harObj,
    stats,
    apiCalls,
    publicScripts,
  };
}
