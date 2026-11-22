import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Evidence,
  type HarEntry,
  type HarLog,
  MethodNotAllowedError,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
} from "@cleanroom/core";

// ---------------------------------------------------------------------------
// Constantes (barreira clean room — docs/05 §5/§7, docs/10 §3)
// ---------------------------------------------------------------------------

/** Tamanho máximo (chars) de qualquer literal extraído e persistido. */
export const MAX_EXTRACTED_STRING_LENGTH = 100;
/** Quantidade máxima de palavras de qualquer literal extraído (< 20). */
export const MAX_EXTRACTED_STRING_WORDS = 19;
/** Faixa de tamanho de literais candidatos a strings de UI (`docs/04` §4.3). */
export const MIN_UI_STRING_LENGTH = 3;
export const MAX_UI_STRING_LENGTH = 200;

const DEFAULT_MAX_BUNDLES = 20;
const DEFAULT_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_STRINGS_PER_BUNDLE = 500;
const MAX_SOURCE_MAP_MODULES = 200;

const ERROR_HINT_REGEX =
  /\b(?:erro|error|inv[áa]lid[oa]?|invalid|obrigat[óo]ri[oa]|required|deve|must|m[íi]nimo|m[áa]ximo|minimum|maximum|limite|limit|falh[aou]|fail(?:ed|ure)?|n[ãa]o\s+(?:pode|é|foi)|not\s+allowed|at\s+least|pelo\s+menos|atingido|exceeded)\b/i;

const I18N_KEY_REGEX = /^[a-z][\w-]*(?:\.[\w-]+){1,6}$/;
const FLAG_NAME_REGEX = /^[A-Za-z_][\w.-]{1,63}$/;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type BundleStringCategory = "error" | "ui";
export type BundleRouteType = "ui" | "api";

export interface ExtractedBundleString {
  text: string;
  category: BundleStringCategory;
  i18nKey?: string;
  truncated: boolean;
}

export interface ExtractedFeatureFlag {
  name: string;
  defaultValue?: boolean;
}

export interface BundleSourceAnalysis {
  routes: string[];
  endpoints: string[];
  strings: ExtractedBundleString[];
  i18nKeys: string[];
  featureFlags: ExtractedFeatureFlag[];
  sourceMapUrl?: string;
}

export interface AnalyzeBundleSourceOptions {
  maxStrings?: number;
}

export interface BundleAnalyzerOptions {
  phaseId?: PhaseId;
  /** Implementação de fetch (testes injetam a demo-app). */
  fetch?: typeof globalThis.fetch;
  /** HAR sanitizado (objeto ou JSON). Se ausente, procura no diretório do job. */
  har?: HarLog | string;
  harPath?: string;
  /** URLs de scripts explícitas. */
  scriptUrls?: string[];
  /** Páginas HTML a inspecionar em busca de `<script src>`. Default: `[target.url]`. */
  pageUrls?: string[];
  /** Desliga a descoberta via HTML (`<script src>`). Default: true. */
  discoverFromPages?: boolean;
  /** Segue `sourceMappingURL` público (apenas nomes de módulos). Default: true. */
  followSourceMaps?: boolean;
  maxBundles?: number;
  maxBundleBytes?: number;
  maxStringsPerBundle?: number;
  outputPath?: string;
  throwOnMethodDisabled?: boolean;
}

export interface BundleAnalyzerStats extends Record<string, number> {
  skipped: number;
  bundlesAnalyzed: number;
  bundlesSkipped: number;
  routes: number;
  endpoints: number;
  strings: number;
  errorStrings: number;
  featureFlags: number;
  sourceMapModules: number;
}

export interface BundleSummary {
  url: string;
  sha256: string;
  bytes: number;
  sourceMap?: { url: string; modules: string[] };
}

export interface BundleStringsDocument {
  version: 1;
  generatedAt: string;
  bundles: BundleSummary[];
  routes: Array<{ path: string; type: BundleRouteType; bundleUrls: string[]; evidenceId?: string }>;
  strings: Array<{
    text: string;
    category: BundleStringCategory;
    i18nKey?: string;
    truncated: boolean;
    bundleUrls: string[];
    evidenceId?: string;
  }>;
  i18nKeys: string[];
  featureFlags: Array<{
    name: string;
    defaultValue?: boolean;
    bundleUrls: string[];
    evidenceId?: string;
  }>;
  endpoints: string[];
}

export interface BundleAnalyzerResult {
  skipped: boolean;
  document: BundleStringsDocument;
  outputPath?: string;
  evidence: Evidence[];
  stats: BundleAnalyzerStats;
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/** Trunca literal a <= 100 chars e < 20 palavras (barreira clean room). */
export function truncateExtractedString(input: string): { text: string; truncated: boolean } {
  let text = input.replace(/\s+/g, " ").trim();
  let truncated = false;
  const words = text.split(" ");
  if (words.length > MAX_EXTRACTED_STRING_WORDS) {
    text = words.slice(0, MAX_EXTRACTED_STRING_WORDS).join(" ");
    truncated = true;
  }
  if (text.length > MAX_EXTRACTED_STRING_LENGTH) {
    text = `${text.slice(0, MAX_EXTRACTED_STRING_LENGTH - 1).trimEnd()}…`;
    truncated = true;
  } else if (truncated) {
    text = `${text}…`;
    if (text.length > MAX_EXTRACTED_STRING_LENGTH) {
      text = `${text.slice(0, MAX_EXTRACTED_STRING_LENGTH - 1).trimEnd()}…`;
    }
  }
  return { text, truncated };
}

function decodeJsEscapes(raw: string): string {
  return raw
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/\\(.)/g, "$1");
}

interface StringLiteral {
  value: string;
  start: number;
  end: number;
}

/** Tokeniza literais de string JS (aspas simples/duplas e template sem `${`), ignorando comentários. */
export function extractStringLiterals(source: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endIdx = source.indexOf("*/", i + 2);
      i = endIdx === -1 ? n : endIdx + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let hasInterpolation = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (quote === "`" && c === "$" && source[j + 1] === "{") {
          hasInterpolation = true;
        }
        if (c === quote) {
          break;
        }
        if (c === "\n" && quote !== "`") {
          break;
        }
        j += 1;
      }
      const raw = source.slice(i + 1, j);
      if (!hasInterpolation && raw.length <= 2000) {
        out.push({ value: decodeJsEscapes(raw), start: i, end: j + 1 });
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Heurística de ruído técnico: retorna true se o literal parece texto humano de UI. */
export function isLikelyUiString(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_UI_STRING_LENGTH || t.length > MAX_UI_STRING_LENGTH) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (!/\s/.test(t)) return false;
  if (/[{};<>]|=>|\bfunction\b|\breturn\b|\bconst\b|\bvar\b|\blet\b/.test(t)) return false;
  if (/^(?:https?:|\/|\.|#|\[|@|data:)/i.test(t)) return false;
  if (/^[\w-]+\/[\w.+-]+(?:;|$)/.test(t)) return false; // mime type
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters / t.length < 0.6) return false;
  return true;
}

function classifyString(text: string): BundleStringCategory {
  return ERROR_HINT_REGEX.test(text) ? "error" : "ui";
}

function normalizeRoutePath(p: string): string | undefined {
  const trimmed = p.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  if (trimmed.length > 200 || /\s/.test(trimmed)) return undefined;
  const noQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  const clean = noQuery.length > 1 ? noQuery.replace(/\/+$/, "") : noQuery;
  if (!/^\/[A-Za-z0-9_\-/:.*{}]*$/.test(clean)) return undefined;
  if (/\.(?:js|mjs|css|map|png|jpe?g|svg|gif|ico|woff2?)$/i.test(clean)) return undefined;
  return clean;
}

function isApiPath(p: string): boolean {
  return /^\/api(?:\/|$)/.test(p);
}

function parseFlagBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "true" || v === "!0") return true;
  if (v === "false" || v === "!1") return false;
  return undefined;
}

/**
 * Analisa o código de um bundle JS **em memória** e extrai apenas metadados comportamentais.
 * O código bruto nunca é retornado nem persistido.
 */
export function analyzeBundleSource(
  source: string,
  options?: AnalyzeBundleSourceOptions,
): BundleSourceAnalysis {
  const maxStrings = options?.maxStrings ?? DEFAULT_MAX_STRINGS_PER_BUNDLE;
  const routes = new Set<string>();
  const endpoints = new Set<string>();
  const i18nKeys = new Set<string>();
  const flags = new Map<string, ExtractedFeatureFlag>();
  const strings = new Map<string, ExtractedBundleString>();

  // Rotas: `path: "/..."`, `path = "/..."`, `<Route path="/...">`, createBrowserRouter([...])
  const routePatterns = [
    /\bpath\s*[:=]\s*["'`](\/[^"'`\s]{0,200})["'`]/g,
    /<Route\b[^>]*?\bpath\s*=\s*\{?\s*["'`](\/[^"'`\s]{0,200})["'`]/g,
  ];
  for (const re of routePatterns) {
    for (const m of source.matchAll(re)) {
      const p = m[1] ? normalizeRoutePath(m[1]) : undefined;
      if (!p) continue;
      if (isApiPath(p)) endpoints.add(p);
      else routes.add(p);
    }
  }

  // Feature flags: blocos `FEATURE_FLAGS = {...}` / `featureFlags: {...}` / `flags: {...}`
  const flagBlockRe = /\b(?:feature_?flags?|flags|features|toggles)\s*[:=]\s*\{([^{}]{0,4000})\}/gi;
  for (const m of source.matchAll(flagBlockRe)) {
    const body = m[1] ?? "";
    const entryRe = /["']?([A-Za-z_][\w.-]*)["']?\s*:\s*(true|false|!0|!1)\b/g;
    for (const e of body.matchAll(entryRe)) {
      const name = e[1];
      if (!name || !FLAG_NAME_REGEX.test(name)) continue;
      const defaultValue = parseFlagBool(e[2]);
      flags.set(name, { name, ...(defaultValue !== undefined ? { defaultValue } : {}) });
    }
  }
  // Chamadas: isEnabled("x"), isFeatureEnabled("x"), flag("x"), feature("x"), useFlag("x")
  const flagCallRe =
    /\b(?:isEnabled|isFeatureEnabled|featureEnabled|useFeatureFlag|useFlag|getFlag|flag|feature)\s*\(\s*["'`]([A-Za-z_][\w.-]{1,63})["'`]\s*[,)]/g;
  for (const m of source.matchAll(flagCallRe)) {
    const name = m[1];
    if (name && !flags.has(name)) flags.set(name, { name });
  }

  // Literais: endpoints `/api/...`, pares i18n `"a.b": "texto"` e strings de UI
  const literals = extractStringLiterals(source);
  for (let idx = 0; idx < literals.length; idx += 1) {
    const lit = literals[idx];
    if (!lit) continue;
    const value = lit.value;

    if (isApiPath(value)) {
      const p = normalizeRoutePath(value);
      if (p) endpoints.add(p);
      continue;
    }

    // Par chave i18n -> mensagem
    if (I18N_KEY_REGEX.test(value)) {
      const after = source.slice(lit.end, lit.end + 8);
      const nextLit = literals[idx + 1];
      if (/^\s*:/.test(after) && nextLit && nextLit.start - lit.end < 16) {
        i18nKeys.add(value);
        const msg = nextLit.value.trim();
        if (
          msg.length >= MIN_UI_STRING_LENGTH &&
          msg.length <= MAX_UI_STRING_LENGTH &&
          /\p{L}/u.test(msg) &&
          !/[{};<>]|=>/.test(msg)
        ) {
          const { text, truncated } = truncateExtractedString(msg);
          if (!strings.has(text) && strings.size < maxStrings) {
            strings.set(text, { text, category: classifyString(msg), i18nKey: value, truncated });
          }
        }
        idx += 1;
        continue;
      }
    }

    if (isLikelyUiString(value)) {
      const { text, truncated } = truncateExtractedString(value);
      if (!strings.has(text) && strings.size < maxStrings) {
        strings.set(text, { text, category: classifyString(value), truncated });
      }
    }
  }

  const smMatch = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(source);

  return {
    routes: [...routes].sort(),
    endpoints: [...endpoints].sort(),
    strings: [...strings.values()],
    i18nKeys: [...i18nKeys].sort(),
    featureFlags: [...flags.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...(smMatch?.[1] ? { sourceMapUrl: smMatch[1] } : {}),
  };
}

/** Extrai somente nomes de módulos de um source map (nunca `sourcesContent`). */
export function extractSourceMapModuleNames(mapJson: unknown): string[] {
  if (typeof mapJson !== "object" || mapJson === null) return [];
  const sources = (mapJson as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const names = new Set<string>();
  for (const s of sources) {
    if (typeof s !== "string") continue;
    if (/node_modules|^webpack\/runtime|^\(webpack\)/.test(s)) continue;
    const cleaned = s
      .replace(/^(?:webpack|vite|rollup):\/\/\/?(?:[^/]*\/)?/, "")
      .replace(/^(?:\.\.?\/)+/, "")
      .replace(/\?.*$/, "");
    if (cleaned.length === 0 || cleaned.length > 160) continue;
    names.add(cleaned);
    if (names.size >= MAX_SOURCE_MAP_MODULES) break;
  }
  return [...names].sort();
}

/** Lista URLs de `<script src>` de um HTML. */
export function extractScriptSrcs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (!m[1]) continue;
    try {
      out.push(new URL(m[1], baseUrl).href);
    } catch {
      // ignora src inválido
    }
  }
  return out;
}

function isScriptHarEntry(entry: HarEntry): boolean {
  const type = entry._resourceType?.toLowerCase();
  if (type === "script") return true;
  const mime = entry.response?.content?.mimeType?.toLowerCase() ?? "";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return true;
  try {
    return /\.m?js$/i.test(new URL(entry.request.url).pathname);
  } catch {
    return false;
  }
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function isPhaseContextBundle(input: unknown): input is PhaseContext {
  if (typeof input !== "object" || input === null) return false;
  const c = input as Record<string, unknown>;
  return typeof c.job === "object" && typeof c.guard === "object" && typeof c.evidence === "object";
}

function resolveHar(ctx: PhaseContext, options?: BundleAnalyzerOptions): HarLog | undefined {
  if (options?.har) {
    return typeof options.har === "string" ? (JSON.parse(options.har) as HarLog) : options.har;
  }
  const jobDir = ctx.evidence.resolveJobDir(ctx.job.id);
  const candidates = [
    ...(options?.harPath ? [options.harPath] : []),
    join(jobDir, "evidence", "har", "har.json"),
    join(jobDir, "raw", "network.har"),
    join(jobDir, "evidence", "har", "raw.har"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as HarLog;
      if (Array.isArray(parsed?.log?.entries)) return parsed;
    } catch {
      // tenta o próximo
    }
  }
  return undefined;
}

function emptyStats(skipped: number): BundleAnalyzerStats {
  return {
    skipped,
    bundlesAnalyzed: 0,
    bundlesSkipped: 0,
    routes: 0,
    endpoints: 0,
    strings: 0,
    errorStrings: 0,
    featureFlags: 0,
    sourceMapModules: 0,
  };
}

async function readLimitedText(res: Response, maxBytes: number): Promise<string | undefined> {
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) return undefined;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) return undefined;
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Fase
// ---------------------------------------------------------------------------

/**
 * `bundleAnalyzer` (`docs/04` §4.3): inspeciona scripts JS públicos (dentro de `allowedOrigins`)
 * e persiste apenas metadados comportamentais em `analysis/strings.json` + evidências
 * `bundle_route`, `bundle_string` e `feature_flag`. O bundle bruto **nunca** é persistido.
 */
export async function bundleAnalyzer(
  ctx: PhaseContext,
  options?: BundleAnalyzerOptions,
): Promise<BundleAnalyzerResult> {
  if (!isPhaseContextBundle(ctx)) {
    throw new TypeError("bundleAnalyzer exige um PhaseContext válido");
  }
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const maxBundles = options?.maxBundles ?? DEFAULT_MAX_BUNDLES;
  const maxBundleBytes = options?.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const generatedAt = new Date().toISOString();

  const emptyDoc: BundleStringsDocument = {
    version: 1,
    generatedAt,
    bundles: [],
    routes: [],
    strings: [],
    i18nKeys: [],
    featureFlags: [],
    endpoints: [],
  };

  try {
    ctx.guard.assertMethod("staticBundles");
  } catch (err) {
    if (err instanceof MethodNotAllowedError && options?.throwOnMethodDisabled !== true) {
      ctx.log.info({ phase: phaseId }, "bundleAnalyzer ignorado: methods.staticBundles=false");
      ctx.emit({
        type: "bundle_analyzer_skipped",
        phase: phaseId,
        data: { reason: "method_static_bundles_disabled" },
      });
      return { skipped: true, document: emptyDoc, evidence: [], stats: emptyStats(1) };
    }
    throw err;
  }

  // 1. Descobre bundles: opções explícitas, HAR e `<script src>` das páginas.
  const scriptUrls: string[] = [];
  const inlineSources = new Map<string, string>();
  const addUrl = (u: string): void => {
    try {
      const abs = new URL(u, ctx.manifest.target.url).href;
      if (!scriptUrls.includes(abs)) scriptUrls.push(abs);
    } catch {
      // ignora
    }
  };
  for (const u of options?.scriptUrls ?? []) addUrl(u);

  // Catálogo de scripts públicos gerado pela fase `capture` (F1-07).
  const scriptsIndexPath = join(
    ctx.evidence.resolveJobDir(ctx.job.id),
    "analysis",
    "scripts-index.json",
  );
  if (existsSync(scriptsIndexPath)) {
    try {
      const index = JSON.parse(readFileSync(scriptsIndexPath, "utf8")) as unknown;
      if (Array.isArray(index)) {
        for (const item of index) {
          const u = (item as { url?: unknown } | null)?.url;
          if (typeof u === "string") addUrl(u);
        }
      }
    } catch {
      ctx.log.debug({ path: scriptsIndexPath }, "scripts-index.json inválido; ignorando");
    }
  }

  const har = resolveHar(ctx, options);
  for (const entry of har?.log.entries ?? []) {
    if (!isScriptHarEntry(entry) || entry.response.status >= 400) continue;
    addUrl(entry.request.url);
    const content = entry.response.content;
    if (content?.text && content.encoding !== "base64" && content.text.length <= maxBundleBytes) {
      inlineSources.set(new URL(entry.request.url).href, content.text);
    }
  }

  let bundlesSkipped = 0;
  if (options?.discoverFromPages !== false) {
    const pages = options?.pageUrls ?? (ctx.manifest.target.url ? [ctx.manifest.target.url] : []);
    for (const pageUrl of pages) {
      if (ctx.signal.aborted) break;
      if (!ctx.guard.canNavigate(pageUrl)) continue;
      await ctx.guard.throttle();
      try {
        const res = await fetchFn(pageUrl, { signal: ctx.signal });
        if (!res.ok) continue;
        const html = await readLimitedText(res, maxBundleBytes);
        if (html) for (const src of extractScriptSrcs(html, pageUrl)) addUrl(src);
      } catch (err) {
        ctx.log.debug({ url: pageUrl, err: String(err) }, "falha ao inspecionar página");
      }
    }
  }

  // 2. Analisa cada bundle em memória.
  const bundles: BundleSummary[] = [];
  const routeAgg = new Map<string, { type: BundleRouteType; urls: Set<string> }>();
  const stringAgg = new Map<string, { s: ExtractedBundleString; urls: Set<string> }>();
  const flagAgg = new Map<string, { f: ExtractedFeatureFlag; urls: Set<string> }>();
  const i18nAll = new Set<string>();
  let sourceMapModules = 0;

  for (const url of scriptUrls.slice(0, maxBundles)) {
    if (ctx.signal.aborted) break;
    if (!ctx.guard.canNavigate(url)) {
      bundlesSkipped += 1;
      ctx.log.debug({ url }, "bundle fora de escopo ignorado pelo ScopeGuard");
      continue;
    }

    let source = inlineSources.get(url);
    if (source === undefined) {
      await ctx.guard.throttle();
      try {
        const res = await fetchFn(url, { signal: ctx.signal });
        source = res.ok ? await readLimitedText(res, maxBundleBytes) : undefined;
      } catch (err) {
        ctx.log.debug({ url, err: String(err) }, "falha ao baixar bundle");
      }
    }
    if (source === undefined) {
      bundlesSkipped += 1;
      continue;
    }

    const analysis = analyzeBundleSource(source, {
      maxStrings: options?.maxStringsPerBundle ?? DEFAULT_MAX_STRINGS_PER_BUNDLE,
    });
    const summary: BundleSummary = {
      url,
      sha256: sha256Hex(source),
      bytes: Buffer.byteLength(source, "utf8"),
    };

    if (analysis.sourceMapUrl && options?.followSourceMaps !== false) {
      const modules = await loadSourceMapModules(
        ctx,
        fetchFn,
        analysis.sourceMapUrl,
        url,
        maxBundleBytes,
      );
      if (modules) {
        summary.sourceMap = modules;
        sourceMapModules += modules.modules.length;
      }
    }
    // Libera a referência ao código bruto o quanto antes.
    source = undefined;
    bundles.push(summary);

    for (const r of analysis.routes) {
      const agg = routeAgg.get(r) ?? { type: "ui" as const, urls: new Set<string>() };
      agg.urls.add(url);
      routeAgg.set(r, agg);
    }
    for (const e of analysis.endpoints) {
      const agg = routeAgg.get(e) ?? { type: "api" as const, urls: new Set<string>() };
      agg.urls.add(url);
      routeAgg.set(e, agg);
    }
    for (const s of analysis.strings) {
      const agg = stringAgg.get(s.text) ?? { s, urls: new Set<string>() };
      agg.urls.add(url);
      stringAgg.set(s.text, agg);
    }
    for (const f of analysis.featureFlags) {
      const prev = flagAgg.get(f.name);
      const merged: ExtractedFeatureFlag = prev?.f.defaultValue !== undefined ? prev.f : { ...f };
      const agg = prev ?? { f: merged, urls: new Set<string>() };
      agg.f = merged;
      agg.urls.add(url);
      flagAgg.set(f.name, agg);
    }
    for (const k of analysis.i18nKeys) i18nAll.add(k);
  }

  // 3. Evidências (apenas metadados, sem blob).
  const evidence: Evidence[] = [];
  const doc: BundleStringsDocument = { ...emptyDoc, bundles };

  for (const [path, agg] of [...routeAgg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bundleUrls = [...agg.urls].sort();
    const ev = ctx.evidence.put({
      jobId: ctx.job.id,
      kind: "bundle_route",
      phase: phaseId,
      url: bundleUrls[0],
      summary: `bundle_route ${agg.type} ${path}`,
      data: { path, routeType: agg.type, bundleUrls },
    });
    evidence.push(ev);
    doc.routes.push({ path, type: agg.type, bundleUrls, evidenceId: ev.id });
    if (agg.type === "api") doc.endpoints.push(path);
  }

  for (const { s, urls } of stringAgg.values()) {
    const bundleUrls = [...urls].sort();
    const ev = ctx.evidence.put({
      jobId: ctx.job.id,
      kind: "bundle_string",
      phase: phaseId,
      url: bundleUrls[0],
      summary: `bundle_string ${s.category}: ${s.text}`,
      data: {
        text: s.text,
        category: s.category,
        ...(s.i18nKey ? { i18nKey: s.i18nKey } : {}),
        truncated: s.truncated,
        bundleUrls,
      },
    });
    evidence.push(ev);
    doc.strings.push({ ...s, bundleUrls, evidenceId: ev.id });
  }

  for (const { f, urls } of [...flagAgg.values()].sort((a, b) =>
    a.f.name.localeCompare(b.f.name),
  )) {
    const bundleUrls = [...urls].sort();
    const ev = ctx.evidence.put({
      jobId: ctx.job.id,
      kind: "feature_flag",
      phase: phaseId,
      url: bundleUrls[0],
      summary: `feature_flag ${f.name}${f.defaultValue !== undefined ? ` (default=${f.defaultValue})` : ""}`,
      data: {
        name: f.name,
        ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
        bundleUrls,
      },
    });
    evidence.push(ev);
    doc.featureFlags.push({ ...f, bundleUrls, evidenceId: ev.id });
  }

  doc.i18nKeys = [...i18nAll].sort();
  doc.endpoints.sort();

  // 4. Persiste analysis/strings.json.
  const outputPath =
    options?.outputPath ?? join(ctx.evidence.resolveJobDir(ctx.job.id), "analysis", "strings.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  const stats: BundleAnalyzerStats = {
    skipped: 0,
    bundlesAnalyzed: bundles.length,
    bundlesSkipped,
    routes: doc.routes.filter((r) => r.type === "ui").length,
    endpoints: doc.endpoints.length,
    strings: doc.strings.length,
    errorStrings: doc.strings.filter((s) => s.category === "error").length,
    featureFlags: doc.featureFlags.length,
    sourceMapModules,
  };

  ctx.saveCheckpoint({
    outputPath,
    bundleUrls: bundles.map((b) => b.url),
    updatedAt: new Date().toISOString(),
  });
  ctx.emit({ type: "bundle_analyzer_completed", phase: phaseId, data: stats });

  return { skipped: false, document: doc, outputPath, evidence, stats };
}

async function loadSourceMapModules(
  ctx: PhaseContext,
  fetchFn: typeof globalThis.fetch,
  sourceMapRef: string,
  bundleUrl: string,
  maxBytes: number,
): Promise<{ url: string; modules: string[] } | undefined> {
  try {
    if (sourceMapRef.startsWith("data:")) {
      const comma = sourceMapRef.indexOf(",");
      if (comma === -1) return undefined;
      const meta = sourceMapRef.slice(5, comma);
      const payload = sourceMapRef.slice(comma + 1);
      const text = meta.includes("base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      return { url: "inline", modules: extractSourceMapModuleNames(JSON.parse(text)) };
    }
    const mapUrl = new URL(sourceMapRef, bundleUrl).href;
    if (!ctx.guard.canNavigate(mapUrl)) return undefined;
    await ctx.guard.throttle();
    const res = await fetchFn(mapUrl, { signal: ctx.signal });
    if (!res.ok) return undefined;
    const text = await readLimitedText(res, maxBytes);
    if (!text) return undefined;
    return { url: mapUrl, modules: extractSourceMapModuleNames(JSON.parse(text)) };
  } catch (err) {
    ctx.log.debug({ url: sourceMapRef, err: String(err) }, "source map ignorado");
    return undefined;
  }
}

export const runBundleAnalyzer = bundleAnalyzer;

export function createBundleAnalyzerPhase(options?: BundleAnalyzerOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  return {
    id: phaseId,
    isEnabled(manifest): boolean {
      return manifest.target.type !== "repo" && manifest.methods.staticBundles === true;
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await bundleAnalyzer(ctx, options);
      return { status: "ok", stats: result.stats };
    },
  };
}

export const bundleAnalyzerPhase: Phase = createBundleAnalyzerPhase();
