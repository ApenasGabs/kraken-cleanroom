import {
  type Evidence,
  MethodNotAllowedError,
  OutOfScopeError,
  type Phase,
  type PhaseContext,
  type PhaseResult,
  type RobotsPolicy,
  type TargetType,
  canonicalJson,
  parseRobotsTxt,
} from "@cleanroom/core";

export type RenderingMode = "spa" | "ssr" | "unknown";

export interface TechSignature {
  name: string;
  category: "framework" | "ui-library" | "bundler" | "runtime" | "server" | "styling";
  confidence: "observed" | "inferred";
  signals: string[];
}

export interface RenderingDetectionResult {
  renderingMode: RenderingMode;
  targetType: TargetType;
  spaMountDetected: boolean;
  mountContainerId?: string | undefined;
  visibleTextLength: number;
  semanticElementCount: number;
  scriptCount: number;
  reasons: string[];
}

export interface IntakeCheckpoint {
  entryUrl: string;
  finalUrl: string;
  targetType: TargetType;
  renderingMode: RenderingMode;
  technologies: TechSignature[];
  seedUrls: string[];
  sitemapUrls: string[];
  robotsDisallow: string[];
  robotsAllow: string[];
  robotsSitemaps: string[];
  evidenceIds: {
    httpResponse: string;
    robots: string;
    techSignature: string;
  };
  completedAt: string;
}

export interface IntakeRunResult {
  phaseResult: PhaseResult;
  checkpoint?: IntakeCheckpoint | undefined;
  evidences?:
    | {
        httpResponse: Evidence;
        robots: Evidence;
        techSignature: Evidence;
      }
    | undefined;
}

export interface IntakePhaseOptions {
  /** Função `fetch` customizada para testes (default: `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch | undefined;
  /** Limite máximo de sub-sitemaps a buscar em um `<sitemapindex>` (default: 5). */
  maxChildSitemaps?: number | undefined;
}

const RELEVANT_SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
  "server",
  "x-powered-by",
  "x-generator",
  "x-drupal-cache",
  "x-nextjs-cache",
  "x-nextjs-matched-path",
  "x-nextjs-page",
  "x-vercel-id",
  "x-vercel-cache",
  "cf-ray",
  "cf-cache-status",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "location",
]);

const FORBIDDEN_HEADER_NAME_REGEX =
  /(?:cookie|token|secret|password|session|auth|key|credential|signature)/i;

/**
 * Filtra os headers HTTP mantendo apenas cabeçalhos seguros e relevantes,
 * garantindo que nenhum cookie (`set-cookie`, `cookie`) ou credencial sobreviva.
 */
export function sanitizeResponseHeaders(
  headers: Headers | Iterable<readonly [string, string]> | Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  const entries: [string, string][] = [];
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      entries.push([key, value]);
    });
  } else if (Symbol.iterator in Object(headers)) {
    for (const [key, value] of headers as Iterable<readonly [string, string]>) {
      entries.push([key, value]);
    }
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      if (typeof value === "string") {
        entries.push([key, value]);
      }
    }
  }

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (!key || FORBIDDEN_HEADER_NAME_REGEX.test(key)) {
      continue;
    }
    if (RELEVANT_SAFE_HEADERS.has(key)) {
      sanitized[key] = rawValue.trim();
    }
  }

  return sanitized;
}

export function normalizeSeedUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const parsed = baseUrl ? new URL(rawUrl.trim(), baseUrl) : new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isUrlInAllowedOrigins(url: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function extractSitemapsFromRobots(robotsContent: string, baseOrigin: string): string[] {
  const sitemaps: string[] = [];
  const seen = new Set<string>();
  const lines = robotsContent.split(/\r?\n/);

  for (const rawLine of lines) {
    const withoutComment = rawLine.split("#")[0]?.trim() ?? "";
    if (!withoutComment) {
      continue;
    }
    const colonIdx = withoutComment.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const directive = withoutComment.slice(0, colonIdx).trim().toLowerCase();
    if (directive !== "sitemap") {
      continue;
    }
    const rawValue = withoutComment.slice(colonIdx + 1).trim();
    const normalized = normalizeSeedUrl(rawValue, baseOrigin);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      sitemaps.push(normalized);
    }
  }

  return sitemaps;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'");
}

export interface ParsedSitemapXml {
  urls: string[];
  childSitemaps: string[];
}

/**
 * Extrai URLs de um XML de sitemap (`<urlset>` ou `<sitemapindex>`),
 * filtrando opcionalmente por `allowedOrigins`.
 */
export function parseSitemapXml(
  xmlContent: string,
  options?: {
    baseOrigin?: string | undefined;
    allowedOrigins?: readonly string[] | undefined;
  },
): ParsedSitemapXml {
  const urls: string[] = [];
  const childSitemaps: string[] = [];
  const seenUrls = new Set<string>();
  const seenChildSitemaps = new Set<string>();

  const isAllowed = (candidate: string): boolean => {
    if (!options?.allowedOrigins || options.allowedOrigins.length === 0) {
      return true;
    }
    return isUrlInAllowedOrigins(candidate, options.allowedOrigins);
  };

  // Extrai blocos <sitemap>...<loc>...</loc>...</sitemap>
  const sitemapBlockRegex = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  let blockMatch: RegExpExecArray | null = sitemapBlockRegex.exec(xmlContent);
  while (blockMatch !== null) {
    const block = blockMatch[1] ?? "";
    const locMatch = block.match(
      /<loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/i,
    );
    const rawLoc = (locMatch?.[1] ?? locMatch?.[2] ?? "").trim();
    if (rawLoc) {
      const normalized = normalizeSeedUrl(decodeXmlEntities(rawLoc), options?.baseOrigin);
      if (normalized && isAllowed(normalized) && !seenChildSitemaps.has(normalized)) {
        seenChildSitemaps.add(normalized);
        childSitemaps.push(normalized);
      }
    }
    blockMatch = sitemapBlockRegex.exec(xmlContent);
  }

  // Remove blocos <sitemap> para extrair apenas <loc> de <url> (ou <loc> soltos)
  const withoutSitemapBlocks = xmlContent.replace(sitemapBlockRegex, "");
  const locRegex = /<loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi;
  let locMatch: RegExpExecArray | null = locRegex.exec(withoutSitemapBlocks);
  while (locMatch !== null) {
    const rawLoc = (locMatch[1] ?? locMatch[2] ?? "").trim();
    if (rawLoc) {
      const normalized = normalizeSeedUrl(decodeXmlEntities(rawLoc), options?.baseOrigin);
      if (normalized && isAllowed(normalized) && !seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        urls.push(normalized);
      }
    }
    locMatch = locRegex.exec(withoutSitemapBlocks);
  }

  return { urls, childSitemaps };
}

function extractScriptSrcs(html: string): string[] {
  const srcs: string[] = [];
  const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null = scriptRegex.exec(html);
  while (match !== null) {
    const src = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (src) {
      srcs.push(src);
    }
    match = scriptRegex.exec(html);
  }
  return srcs;
}

function extractMetaGenerator(html: string): string | null {
  const metaRegex = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null = metaRegex.exec(html);
  while (match !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const nameVal = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? "").toLowerCase();
    if (nameVal === "generator") {
      const contentMatch = tag.match(/\bcontent\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
      const contentVal = (contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? "").trim();
      if (contentVal) {
        return contentVal;
      }
    }
    match = metaRegex.exec(html);
  }
  return null;
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return null;
  }
  const text = match[1].replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * Detecta assinaturas de tecnologias (Next.js, Nuxt, React, Vue, Angular, Flutter Web, etc.)
 * a partir do HTML da página de entrada e dos cabeçalhos HTTP sanitizados.
 */
export function detectTechSignatures(
  html: string,
  headers: Record<string, string> = {},
): TechSignature[] {
  const signatures: TechSignature[] = [];
  const scriptSrcs = extractScriptSrcs(html);
  const metaGenerator = extractMetaGenerator(html);
  const poweredBy = (headers["x-powered-by"] ?? "").toLowerCase();
  const serverHeader = (headers.server ?? "").toLowerCase();

  const addSignature = (
    name: string,
    category: TechSignature["category"],
    confidence: TechSignature["confidence"],
    signals: string[],
  ) => {
    if (signals.length === 0) {
      return;
    }
    signatures.push({ name, category, confidence, signals });
  };

  // 1. Next.js
  const nextSignals: string[] = [];
  if (/__NEXT_DATA__/.test(html)) {
    nextSignals.push("html:__NEXT_DATA__");
  }
  if (scriptSrcs.some((s) => s.includes("/_next/static/") || s.includes("/_next/"))) {
    nextSignals.push("script:/_next/static/");
  }
  if (
    headers["x-nextjs-cache"] ||
    headers["x-nextjs-matched-path"] ||
    headers["x-nextjs-page"] ||
    poweredBy.includes("next.js")
  ) {
    nextSignals.push("header:x-nextjs");
  }
  addSignature("Next.js", "framework", "observed", nextSignals);

  // 2. Nuxt
  const nuxtSignals: string[] = [];
  if (/window\.__NUXT__|__NUXT__/.test(html)) {
    nuxtSignals.push("html:__NUXT__");
  }
  if (/id\s*=\s*["']__nuxt["']/i.test(html)) {
    nuxtSignals.push("dom:#__nuxt");
  }
  if (scriptSrcs.some((s) => s.includes("/_nuxt/"))) {
    nuxtSignals.push("script:/_nuxt/");
  }
  addSignature("Nuxt", "framework", "observed", nuxtSignals);

  // 3. React
  const reactSignals: string[] = [];
  if (/data-reactroot|data-reactid|__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(html)) {
    reactSignals.push("html:data-reactroot");
  }
  if (scriptSrcs.some((s) => /react(?:\.production|\.development|-dom)?\b/i.test(s))) {
    reactSignals.push("script:react");
  }
  if (nextSignals.length > 0) {
    reactSignals.push("framework:Next.js");
  }
  addSignature(
    "React",
    "ui-library",
    reactSignals.some((s) => !s.startsWith("framework:")) ? "observed" : "inferred",
    reactSignals,
  );

  // 4. Vue
  const vueSignals: string[] = [];
  if (/\bdata-v-[a-f0-9]{6,}\b/i.test(html) || /__VUE__/.test(html)) {
    vueSignals.push("html:data-v-scoped");
  }
  if (scriptSrcs.some((s) => /\bvue(?:\.runtime|\.global|\.esm)?\b/i.test(s))) {
    vueSignals.push("script:vue");
  }
  if (nuxtSignals.length > 0) {
    vueSignals.push("framework:Nuxt");
  }
  addSignature(
    "Vue",
    "ui-library",
    vueSignals.some((s) => !s.startsWith("framework:")) ? "observed" : "inferred",
    vueSignals,
  );

  // 5. Angular
  const angularSignals: string[] = [];
  if (/\bng-version\s*=\s*["'][^"']+["']/i.test(html)) {
    angularSignals.push("html:ng-version");
  }
  if (/<app-root\b/i.test(html) || /\b_ngcontent-|\b_nghost-/i.test(html)) {
    angularSignals.push("dom:app-root/_ngcontent");
  }
  if (
    scriptSrcs.some((s) => /\bzone\.js|\bmain\.[a-f0-9]+\.js/i.test(s)) &&
    /<app-root\b/i.test(html)
  ) {
    angularSignals.push("script:zone.js");
  }
  addSignature("Angular", "framework", "observed", angularSignals);

  // 6. Flutter Web
  const flutterSignals: string[] = [];
  if (
    /flutter_bootstrap\.js/i.test(html) ||
    scriptSrcs.some((s) => /flutter_bootstrap\.js|flutter\.js|main\.dart\.js/i.test(s))
  ) {
    flutterSignals.push("script:flutter_bootstrap.js");
  }
  if (/<flt-glass-pane\b|flutter-view/i.test(html)) {
    flutterSignals.push("dom:flt-glass-pane");
  }
  addSignature("Flutter Web", "framework", "observed", flutterSignals);

  // 7. Svelte / SvelteKit
  const svelteSignals: string[] = [];
  if (/__sveltekit/i.test(html) || /data-sveltekit-/i.test(html)) {
    svelteSignals.push("html:__sveltekit");
  }
  addSignature("SvelteKit", "framework", "observed", svelteSignals);

  // 8. Remix
  const remixSignals: string[] = [];
  if (/window\.__remixContext|__remixManifest/.test(html)) {
    remixSignals.push("html:__remixContext");
  }
  addSignature("Remix", "framework", "observed", remixSignals);

  // 9. Astro
  const astroSignals: string[] = [];
  if (/<astro-island\b|<astro-slot\b/i.test(html)) {
    astroSignals.push("dom:astro-island");
  }
  if (metaGenerator && /astro/i.test(metaGenerator)) {
    astroSignals.push(`meta:generator=${metaGenerator}`);
  }
  addSignature("Astro", "framework", "observed", astroSignals);

  // 10. Hono / Express / Server / Meta Generator
  if (metaGenerator && /hono/i.test(metaGenerator)) {
    addSignature("Hono", "server", "observed", [`meta:generator=${metaGenerator}`]);
  } else if (poweredBy.includes("hono") || serverHeader.includes("hono")) {
    addSignature("Hono", "server", "observed", ["header:hono"]);
  }

  // 11. Vite
  if (scriptSrcs.some((s) => s.includes("/@vite/") || s.includes("vite/client"))) {
    addSignature("Vite", "bundler", "observed", ["script:/@vite/"]);
  }

  return signatures;
}

/**
 * Heurística de detecção SPA vs SSR (docs/04 Passo 3):
 * HTML com `<div id="root|app|__next|__nuxt">` (ou `<app-root>`) vazio + bundles JS = SPA;
 * HTML rico já renderizado no servidor (elementos semânticos e texto visível) = SSR.
 */
export function detectRenderingMode(
  html: string,
  technologies: readonly TechSignature[] = [],
  fallbackTargetType: TargetType = "web-unknown",
): RenderingDetectionResult {
  const trimmed = html.trim();
  if (!trimmed) {
    return {
      renderingMode: "unknown",
      targetType: fallbackTargetType,
      spaMountDetected: false,
      visibleTextLength: 0,
      semanticElementCount: 0,
      scriptCount: 0,
      reasons: ["empty_html"],
    };
  }

  const bodyMatch = trimmed.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? trimmed;

  const scriptSrcs = extractScriptSrcs(trimmed);
  const inlineScriptCount = (trimmed.match(/<script\b[^>]*>/gi) ?? []).length;
  const scriptCount = Math.max(scriptSrcs.length, inlineScriptCount);

  // Verifica container de mount vazio típico de SPA: <div id="root|app|__next|__nuxt"></div> ou <app-root></app-root>
  const emptyMountRegex =
    /<(?:div|main)\b[^>]*\bid\s*=\s*["'](root|app|__next|__nuxt|spa-root)["'][^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/(?:div|main)>/i;
  const emptyAppRootRegex = /<app-root\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/app-root>/i;

  const emptyMountMatch = bodyHtml.match(emptyMountRegex);
  const hasEmptyAppRoot = emptyAppRootRegex.test(bodyHtml);
  const isFlutterWeb = technologies.some((t) => t.name === "Flutter Web");

  // Texto visível no body (excluindo scripts, styles, noscript e comentários)
  const strippedBody = bodyHtml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const visibleTextLength = strippedBody.length;
  const semanticMatches =
    bodyHtml.match(/<(?:main|article|section|nav|header|footer|form|table|h1|h2|h3)\b/gi) ?? [];
  const semanticElementCount = semanticMatches.length;

  const spaMountDetected = Boolean(emptyMountMatch || hasEmptyAppRoot || isFlutterWeb);
  const mountContainerId = emptyMountMatch?.[1] ?? (hasEmptyAppRoot ? "app-root" : undefined);
  const reasons: string[] = [];

  if (
    spaMountDetected &&
    visibleTextLength < 120 &&
    semanticElementCount <= 1 &&
    scriptCount >= 1
  ) {
    if (mountContainerId) {
      reasons.push(`empty_mount_container:#${mountContainerId}`);
    }
    if (isFlutterWeb) {
      reasons.push("flutter_web_bootstrap");
    }
    reasons.push(`low_visible_text:${visibleTextLength}`);
    reasons.push(`scripts:${scriptCount}`);
    return {
      renderingMode: "spa",
      targetType: "web-spa",
      spaMountDetected: true,
      mountContainerId,
      visibleTextLength,
      semanticElementCount,
      scriptCount,
      reasons,
    };
  }

  const metaGen = extractMetaGenerator(trimmed);
  const hasSsrMarkers =
    /data-server-rendered\s*=\s*["']true["']/i.test(trimmed) ||
    /__NEXT_DATA__|__NUXT__|__remixContext/.test(trimmed) ||
    Boolean(metaGen && /\bssr\b/i.test(metaGen));

  if (semanticElementCount >= 2 || visibleTextLength >= 80 || hasSsrMarkers) {
    if (semanticElementCount >= 2) {
      reasons.push(`semantic_elements:${semanticElementCount}`);
    }
    if (visibleTextLength >= 80) {
      reasons.push(`server_rendered_text:${visibleTextLength}`);
    }
    if (hasSsrMarkers) {
      reasons.push("ssr_hydration_or_generator_marker");
    }
    return {
      renderingMode: "ssr",
      targetType: "web-ssr",
      spaMountDetected,
      mountContainerId,
      visibleTextLength,
      semanticElementCount,
      scriptCount,
      reasons,
    };
  }

  if (spaMountDetected) {
    reasons.push("spa_mount_without_ssr_content");
    return {
      renderingMode: "spa",
      targetType: "web-spa",
      spaMountDetected: true,
      mountContainerId,
      visibleTextLength,
      semanticElementCount,
      scriptCount,
      reasons,
    };
  }

  return {
    renderingMode: "unknown",
    targetType: fallbackTargetType,
    spaMountDetected: false,
    visibleTextLength,
    semanticElementCount,
    scriptCount,
    reasons: ["inconclusive_html"],
  };
}

function detectAntiBotChallenge(
  status: number,
  headers: Record<string, string>,
  html: string,
): string | null {
  const lowerHtml = html.toLowerCase();
  if (
    lowerHtml.includes("cf-turnstile") ||
    lowerHtml.includes("challenges.cloudflare.com") ||
    (status === 403 && headers["cf-ray"] && lowerHtml.includes("just a moment"))
  ) {
    return "Desafio anti-bot Cloudflare / Turnstile detectado na URL de entrada.";
  }
  if (status === 403 && (lowerHtml.includes("g-recaptcha") || lowerHtml.includes("h-captcha"))) {
    return "Desafio CAPTCHA detectado na URL de entrada.";
  }
  return null;
}

function resolveAllowedOrigins(ctx: PhaseContext, entryUrl: string): string[] {
  const origins = new Set<string>(ctx.manifest.target.allowedOrigins ?? []);
  try {
    origins.add(new URL(entryUrl).origin);
  } catch {
    // ignorado
  }
  return Array.from(origins);
}

/**
 * Executa a Fase 1 (`intake` — `docs/04-pipeline-e-fases.md`):
 * 1. `GET` da URL de entrada via `fetch` simples (sem browser), registrando status e headers relevantes sem cookies (`http_response`).
 * 2. Busca e parseia `/robots.txt` (alimentando `ScopeGuard` quando `limits.respectRobotsTxt === true`) e `/sitemap.xml` (filtrando por `allowedOrigins`).
 * 3. Detecta SPA vs SSR (`detectRenderingMode`).
 * 4. Detecta assinaturas de tecnologia (`Next.js`, `Nuxt`, `React`, `Vue`, `Angular`, `Flutter Web`, etc.) e registra evidência `tech_signature`.
 * 5. Monta a fila de URLs semente (`entrada + sitemap + docsUrls`) deduplicada e filtrada pelo `ScopeGuard` e persiste no checkpoint.
 */
export async function runIntakePhase(
  ctx: PhaseContext,
  options?: IntakePhaseOptions,
): Promise<IntakeRunResult> {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const maxChildSitemaps = options?.maxChildSitemaps ?? 5;

  if (
    !ctx.manifest.methods.behavioralUi &&
    !ctx.manifest.methods.publicDocs &&
    !ctx.manifest.methods.networkHar &&
    !ctx.manifest.methods.staticBundles
  ) {
    throw new MethodNotAllowedError(
      "Nenhum método de coleta web está habilitado no manifesto para executar a fase intake.",
    );
  }

  const rawEntryUrl = ctx.manifest.target.url;
  if (!rawEntryUrl) {
    return {
      phaseResult: {
        status: "ok",
        stats: {
          seedUrls: 0,
          sitemapUrls: 0,
          technologies: 0,
          skippedRepoTarget: 1,
        },
      },
    };
  }

  const entryUrl = normalizeSeedUrl(rawEntryUrl) ?? rawEntryUrl;
  ctx.guard.assertCanNavigate(entryUrl);
  const allowedOrigins = resolveAllowedOrigins(ctx, entryUrl);
  const entryOrigin = new URL(entryUrl).origin;

  // Passo 1: GET da URL de entrada (fetch simples, sem browser, sem enviar nem persistir cookies)
  ctx.signal.throwIfAborted?.();
  await ctx.guard.throttle();

  const entryResponse = await fetchFn(entryUrl, {
    method: "GET",
    redirect: "follow",
    signal: ctx.signal,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "kraken-cleanroom/0.1",
    },
  });

  const finalUrl = entryResponse.url
    ? (normalizeSeedUrl(entryResponse.url, entryUrl) ?? entryUrl)
    : entryUrl;
  if (!ctx.guard.canNavigate(finalUrl)) {
    throw new OutOfScopeError(
      `A URL de entrada redirecionou para fora do escopo permitido: "${finalUrl}".`,
      { url: finalUrl },
    );
  }

  const sanitizedHeaders = sanitizeResponseHeaders(entryResponse.headers);
  const entryHtml = await entryResponse.text();
  const challengeReason = detectAntiBotChallenge(entryResponse.status, sanitizedHeaders, entryHtml);

  if (challengeReason) {
    if (ctx.manifest.humanInTheLoop.captcha === "handoff") {
      return {
        phaseResult: {
          status: "awaiting_human",
          handoff: {
            kind: "captcha",
            message: challengeReason,
            timeoutMin: ctx.manifest.humanInTheLoop.handoffTimeoutMin,
          },
        },
      };
    }
    return {
      phaseResult: {
        status: "blocked",
        reason: challengeReason,
      },
    };
  }

  if (entryResponse.status === 403 || entryResponse.status === 429) {
    return {
      phaseResult: {
        status: "blocked",
        reason: `Acesso bloqueado na URL de entrada (${entryUrl}) com status HTTP ${entryResponse.status}.`,
      },
    };
  }

  // Passo 2: Buscar /robots.txt e sitemaps declarados
  const robotsUrl = `${entryOrigin}/robots.txt`;
  let robotsStatus = 0;
  let robotsBody = "";
  let robotsPolicy: RobotsPolicy = { disallow: [], allow: [] };
  let declaredSitemaps: string[] = [];
  let robotsFound = false;

  ctx.signal.throwIfAborted?.();
  await ctx.guard.throttle();
  try {
    const robotsRes = await fetchFn(robotsUrl, {
      method: "GET",
      redirect: "follow",
      signal: ctx.signal,
      headers: {
        Accept: "text/plain,*/*;q=0.8",
        "User-Agent": "kraken-cleanroom/0.1",
      },
    });
    robotsStatus = robotsRes.status;
    if (robotsRes.ok) {
      const contentType = (robotsRes.headers.get("content-type") ?? "").toLowerCase();
      const text = await robotsRes.text();
      if (
        !contentType.includes("text/html") ||
        /^(?:user-agent|allow|disallow|sitemap)\s*:/im.test(text)
      ) {
        robotsFound = true;
        robotsBody = text;
        robotsPolicy = parseRobotsTxt(robotsBody);
        declaredSitemaps = extractSitemapsFromRobots(robotsBody, entryOrigin).filter((u) =>
          isUrlInAllowedOrigins(u, allowedOrigins),
        );
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    ctx.log.warn(
      { err, robotsUrl },
      "falha ao buscar /robots.txt; prosseguindo sem regras de robots",
    );
  }

  // Nota de Refinamento Arquitetural (Pai do Kraken):
  // Alimentar o ScopeGuard com as regras Disallow/Allow lidas do /robots.txt quando limits.respectRobotsTxt for true.
  if (ctx.manifest.limits.respectRobotsTxt && robotsFound) {
    ctx.guard.setRobotsTxt(robotsPolicy);
  }

  const robotsEvidence = ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "robots",
    phase: "intake",
    url: robotsUrl,
    blob: robotsFound ? robotsBody : `# /robots.txt indisponível (HTTP ${robotsStatus})\n`,
    summary: robotsFound
      ? `robots.txt (${robotsPolicy.disallow.length} disallow, ${robotsPolicy.allow.length} allow, ${declaredSitemaps.length} sitemaps)`
      : `robots.txt ausente (HTTP ${robotsStatus})`,
    data: {
      url: robotsUrl,
      status: robotsStatus,
      found: robotsFound,
      respected: ctx.manifest.limits.respectRobotsTxt,
      disallow: robotsPolicy.disallow,
      allow: robotsPolicy.allow,
      sitemaps: declaredSitemaps,
    },
  });

  // Buscar /sitemap.xml + sitemaps declarados no robots.txt (dentro de allowedOrigins)
  const sitemapQueue: string[] = [];
  const defaultSitemapUrl = `${entryOrigin}/sitemap.xml`;
  for (const candidate of [defaultSitemapUrl, ...declaredSitemaps]) {
    const normalized = normalizeSeedUrl(candidate, entryOrigin);
    if (
      normalized &&
      isUrlInAllowedOrigins(normalized, allowedOrigins) &&
      !sitemapQueue.includes(normalized)
    ) {
      sitemapQueue.push(normalized);
    }
  }

  const visitedSitemaps = new Set<string>();
  const discoveredSitemapUrls: string[] = [];
  const seenSitemapUrls = new Set<string>();

  while (sitemapQueue.length > 0 && visitedSitemaps.size < 1 + maxChildSitemaps) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) {
      continue;
    }
    visitedSitemaps.add(sitemapUrl);

    ctx.signal.throwIfAborted?.();
    await ctx.guard.throttle();

    try {
      const sitemapRes = await fetchFn(sitemapUrl, {
        method: "GET",
        redirect: "follow",
        signal: ctx.signal,
        headers: {
          Accept: "application/xml,text/xml,*/*;q=0.8",
          "User-Agent": "kraken-cleanroom/0.1",
        },
      });
      if (!sitemapRes.ok) {
        continue;
      }
      const xmlText = await sitemapRes.text();
      const parsedSitemap = parseSitemapXml(xmlText, {
        baseOrigin: entryOrigin,
        allowedOrigins,
      });

      for (const childSitemap of parsedSitemap.childSitemaps) {
        if (!visitedSitemaps.has(childSitemap) && !sitemapQueue.includes(childSitemap)) {
          sitemapQueue.push(childSitemap);
        }
      }

      for (const locUrl of parsedSitemap.urls) {
        if (ctx.guard.canNavigate(locUrl) && !seenSitemapUrls.has(locUrl)) {
          seenSitemapUrls.add(locUrl);
          discoveredSitemapUrls.push(locUrl);
        }
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        throw err;
      }
      ctx.log.warn({ err, sitemapUrl }, "falha ao buscar sitemap.xml; ignorando");
    }
  }

  // Passo 3 e 4: Detectar tecnologias e SPA vs SSR
  const technologies = detectTechSignatures(entryHtml, sanitizedHeaders);
  const rendering = detectRenderingMode(entryHtml, technologies, ctx.manifest.target.type);
  const refinedTargetType = rendering.targetType;
  const pageTitle = extractHtmlTitle(entryHtml);

  const httpResponsePayload = {
    url: entryUrl,
    finalUrl,
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: sanitizedHeaders,
    contentType: sanitizedHeaders["content-type"] ?? null,
    contentLength: Buffer.byteLength(entryHtml, "utf8"),
    title: pageTitle,
    targetType: refinedTargetType,
  };

  const httpResponseEvidence = ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "http_response",
    phase: "intake",
    url: finalUrl,
    blob: canonicalJson(httpResponsePayload),
    summary: `GET ${finalUrl} -> ${entryResponse.status} (${sanitizedHeaders["content-type"] ?? "unknown"})`,
    data: httpResponsePayload,
  });

  const techSignaturePayload = {
    url: finalUrl,
    targetType: refinedTargetType,
    renderingMode: rendering.renderingMode,
    spaMountDetected: rendering.spaMountDetected,
    ...(rendering.mountContainerId ? { mountContainerId: rendering.mountContainerId } : {}),
    visibleTextLength: rendering.visibleTextLength,
    semanticElementCount: rendering.semanticElementCount,
    scriptCount: rendering.scriptCount,
    reasons: rendering.reasons,
    technologies,
  };

  const techNames = technologies.map((t) => t.name);
  const techSignatureEvidence = ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "tech_signature",
    phase: "intake",
    url: finalUrl,
    blob: canonicalJson(techSignaturePayload),
    summary:
      techNames.length > 0
        ? `Alvo ${refinedTargetType} (${rendering.renderingMode}); tecnologias: ${techNames.join(", ")}`
        : `Alvo ${refinedTargetType} (${rendering.renderingMode}); nenhuma assinatura específica de framework`,
    data: techSignaturePayload,
  });

  // Passo 5: Montar fila de URLs semente (entrada + sitemap + docsUrls), filtrada pelo ScopeGuard
  const seedUrls: string[] = [];
  const seenSeeds = new Set<string>();

  const tryAddSeed = (rawCandidate: string) => {
    const normalized = normalizeSeedUrl(rawCandidate, entryOrigin);
    if (!normalized || seenSeeds.has(normalized)) {
      return;
    }
    if (!isUrlInAllowedOrigins(normalized, allowedOrigins)) {
      return;
    }
    if (!ctx.guard.canNavigate(normalized)) {
      return;
    }
    seenSeeds.add(normalized);
    seedUrls.push(normalized);
  };

  tryAddSeed(finalUrl);
  tryAddSeed(entryUrl);
  for (const sitemapLoc of discoveredSitemapUrls) {
    tryAddSeed(sitemapLoc);
  }
  for (const docUrl of ctx.manifest.target.docsUrls) {
    tryAddSeed(docUrl);
  }

  const checkpoint: IntakeCheckpoint = {
    entryUrl,
    finalUrl,
    targetType: refinedTargetType,
    renderingMode: rendering.renderingMode,
    technologies,
    seedUrls,
    sitemapUrls: discoveredSitemapUrls,
    robotsDisallow: robotsPolicy.disallow,
    robotsAllow: robotsPolicy.allow,
    robotsSitemaps: declaredSitemaps,
    evidenceIds: {
      httpResponse: httpResponseEvidence.id,
      robots: robotsEvidence.id,
      techSignature: techSignatureEvidence.id,
    },
    completedAt: new Date().toISOString(),
  };

  ctx.saveCheckpoint(checkpoint);
  ctx.emit({
    type: "intake_completed",
    phase: "intake",
    data: {
      targetType: refinedTargetType,
      renderingMode: rendering.renderingMode,
      seedUrlsCount: seedUrls.length,
      sitemapUrlsCount: discoveredSitemapUrls.length,
      technologies: techNames,
    },
  });

  return {
    phaseResult: {
      status: "ok",
      stats: {
        status: entryResponse.status,
        seedUrls: seedUrls.length,
        sitemapUrls: discoveredSitemapUrls.length,
        technologies: technologies.length,
        robotsDisallow: robotsPolicy.disallow.length,
      },
    },
    checkpoint,
    evidences: {
      httpResponse: httpResponseEvidence,
      robots: robotsEvidence,
      techSignature: techSignatureEvidence,
    },
  };
}

export function createIntakePhase(options?: IntakePhaseOptions): Phase {
  return {
    id: "intake",
    isEnabled(manifest): boolean {
      return manifest.target.type !== "repo" && Boolean(manifest.target.url);
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await runIntakePhase(ctx, options);
      return result.phaseResult;
    },
  };
}

export const intakePhase: Phase = createIntakePhase();
