import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  type Evidence,
  type EvidenceStore,
  MethodNotAllowedError,
  type Phase,
  type PhaseContext,
  type PhaseResult,
  type RobotsPolicy,
  type ScopeGuard,
  canonicalJson,
  computeSha256,
} from "@cleanroom/core";
import type {
  Browser,
  BrowserContext,
  Page as PlaywrightPage,
  Response as PlaywrightResponse,
  Route as PlaywrightRoute,
} from "playwright-core";
import {
  BrowserSession,
  type BrowserSessionOptions,
  type CdpConnector,
} from "./browser-session.js";
import { extractFormSchemasFromHtml, probeForm } from "./form-probing.js";
import { isUrlInAllowedOrigins, normalizeSeedUrl, sanitizeResponseHeaders } from "./intake.js";

export const ACTION_KINDS = [
  "navigate",
  "open-overlay",
  "submit-form",
  "toggle",
  "destructive",
  "external",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_PRIORITY_BUCKETS = [
  "main-nav",
  "tabs-menus",
  "content-links",
  "pagination",
  "non-navigable",
] as const;

export type ActionPriorityBucket = (typeof ACTION_PRIORITY_BUCKETS)[number];

export const DEFAULT_MAX_PAGES_PER_LIST = 2;
export const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 10_000;
export const DEFAULT_STABILIZATION_MS = 500;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

/**
 * Nó estrutural da árvore de elementos interativos visíveis (sem texto)
 * utilizado para o cálculo do fingerprint SHA-256 do estado (`docs/04` Fase 2).
 */
export interface InteractiveTreeNode {
  tag: string;
  role?: string | undefined;
  type?: string | undefined;
  name?: string | undefined;
  method?: string | undefined;
  actionAttr?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  children?: InteractiveTreeNode[] | undefined;
}

export interface CandidateAction {
  kind: ActionKind;
  selector: string;
  label: string;
  priorityBucket: ActionPriorityBucket;
  /** Prioridade numérica (menor = mais prioritário: 1=main-nav, 2=tabs-menus, 3=content-links, 4=pagination, 99=non-navigable). */
  priority: number;
  targetUrl?: string | undefined;
  method?: string | undefined;
  tag: string;
  role?: string | undefined;
  destructiveReason?: string | undefined;
  paginationListKey?: string | undefined;
  paginationPage?: string | undefined;
}

export interface StateGraphAction {
  kind: ActionKind;
  selector: string;
  label: string;
}

export interface StateGraphEdge {
  from: string;
  to: string;
  action: StateGraphAction;
}

export interface StateGraphNode {
  id: string;
  fingerprint: string;
  url: string;
  normalizedUrl: string;
  title: string;
  depth: number;
  status: number;
  interactiveTree: InteractiveTreeNode[];
  actions: CandidateAction[];
  discoveredAt: string;
  evidenceId: string;
  screenshotEvidenceIds?: string[] | undefined;
  domSnapshotEvidenceId?: string | undefined;
  a11ySnapshotEvidenceId?: string | undefined;
}

export interface StateGraphStats {
  pagesVisited: number;
  statesDiscovered: number;
  transitionsRecorded: number;
  skippedOutOfScope: number;
  skippedDestructive: number;
  skippedPaginationLimit: number;
  maxDepthReached: number;
  rateLimit429Count: number;
  screenshotsCaptured?: number | undefined;
  domSnapshotsCaptured?: number | undefined;
  a11ySnapshotsCaptured?: number | undefined;
}

export interface StateGraph {
  jobId: string;
  entryUrl: string;
  generatedAt: string;
  nodes: StateGraphNode[];
  edges: StateGraphEdge[];
  stats: StateGraphStats;
}

export interface QueuedExplorationItem {
  url: string;
  depth: number;
  priority: number;
  sequence: number;
  fromStateId?: string | undefined;
  viaAction?: StateGraphAction | undefined;
  paginationListKey?: string | undefined;
  paginationPage?: string | undefined;
  retryCount429?: number | undefined;
}

export interface ExploreCheckpoint {
  visitedUrls: string[];
  nodes: StateGraphNode[];
  edges: StateGraphEdge[];
  queue: QueuedExplorationItem[];
  listPagesVisited: Record<string, string[]>;
  listFirstPageStateIds: Record<string, string>;
  pagesVisitedCount: number;
  skippedOutOfScope: number;
  skippedDestructive: number;
  skippedPaginationLimit: number;
  rateLimit429Count: number;
  currentRateLimitRps: number;
  sequenceCounter: number;
  discoveredFormIds?: string[];
  formsDiscoveredCount?: number;
  formProbesCount?: number;
  updatedAt: string;
}

export interface ExploreRunResult {
  phaseResult: PhaseResult;
  stateGraph?: StateGraph | undefined;
  stateGraphPath?: string | undefined;
  checkpoint?: ExploreCheckpoint | undefined;
  stateEvidences: Evidence[];
  transitionEvidences: Evidence[];
  screenshotEvidences?: Evidence[] | undefined;
  domSnapshotEvidences?: Evidence[] | undefined;
  a11ySnapshotEvidences?: Evidence[] | undefined;
  formSchemaEvidences: Evidence[];
  formProbeEvidences: Evidence[];
}

export interface ExplorePhaseOptions {
  /** Sessão CDP já aberta (se omitida, `runExplorePhase` abre e fecha uma `BrowserSession` em `finally`). */
  session?: BrowserSession | undefined;
  /** Opções repassadas a `BrowserSession.connect` quando `session` não é fornecida. */
  sessionOptions?: BrowserSessionOptions | undefined;
  /**
   * Função `fetch` opcional para testes sem Browserless remoto (cria conector CDP em memória)
   * ou para proxy de rotas via `context.route` quando combinada com `wsEndpoint`.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * Quando definido em conjunto com uma sessão CDP real, intercepta requisições HTTP(S) do
   * contexto Playwright dentro de `allowedOrigins` e responde via `routeFetch` (útil quando
   * o Browserless roda em outro host da LAN e o servidor de teste `demo-app` é local).
   */
  routeFetch?: typeof globalThis.fetch | undefined;
  /** Sementes iniciais explícitas (adicionais a `target.url`, `intake` e `docsUrls`). */
  seedUrls?: readonly string[] | undefined;
  /** Timeout para aguardar `networkidle` em cada navegação (default: 10000 ms). */
  networkIdleTimeoutMs?: number | undefined;
  /** Tempo de estabilização pós-`networkidle` em ms (default: 500 ms). */
  stabilizationMs?: number | undefined;
  /** Timeout máximo de `page.goto` em ms (default: 15000 ms). */
  navigationTimeoutMs?: number | undefined;
  /** Limite máximo de páginas visitadas por lista paginada (default: 2). */
  maxPagesPerList?: number | undefined;
  /** Sobrescreve o limite de duração máxima em ms (default: `manifest.limits.maxDurationMin * 60_000`). */
  maxDurationMs?: number | undefined;
  /** Se deve capturar screenshots nas viewports configuradas no manifesto para cada estado novo (default: true). */
  captureScreenshots?: boolean | undefined;
  /** Se deve capturar snapshot DOM reduzido para cada estado novo (default: true). */
  captureDomSnapshot?: boolean | undefined;
  /** Se deve capturar snapshot da árvore de acessibilidade para cada estado novo (default: true). */
  captureA11ySnapshot?: boolean | undefined;
  /** Relógio customizado (ms) para testes determinísticos. */
  now?: (() => number) | undefined;
  /** Função de espera customizada (ms) para testes determinísticos. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Hook opcional invocado sempre que um estado novo (fingerprint inédito) é descoberto. */
  onNewState?:
    | ((params: {
        page: PlaywrightPage;
        session: BrowserSession;
        state: StateGraphNode;
        ctx: PhaseContext;
      }) => Promise<void>)
    | undefined;
}

const TRACKING_PARAM_PREFIXES = ["utm_", "hsa_", "pk_", "mtm_", "piwik_", "matomo_"] as const;

const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "ttclid",
  "yclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "_gac",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "mkt_tok",
  "igshid",
  "si",
  "spm",
  "vero_id",
  "vero_conv",
  "rb_clickid",
  "s_kwcid",
  "oly_enc_id",
  "oly_anon_id",
]);

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "option",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "switch",
  "radio",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "option",
]);

const STRUCTURAL_CONTAINER_TAGS = new Set([
  "header",
  "nav",
  "main",
  "aside",
  "footer",
  "section",
  "article",
  "form",
  "fieldset",
  "dialog",
  "details",
  "table",
]);

const STRUCTURAL_CONTAINER_ROLES = new Set([
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "dialog",
  "alertdialog",
  "tablist",
  "menu",
  "menubar",
  "toolbar",
  "table",
  "grid",
]);

const NON_VISIBLE_TAGS = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "path",
  "meta",
  "link",
  "title",
]);

const PAGINATION_QUERY_KEYS = new Set([
  "page",
  "p",
  "pagina",
  "pag",
  "offset",
  "cursor",
  "after",
  "before",
]);

const PAGINATION_LABEL_REGEX =
  /\b(?:p[aá]gina\s+\d+|pr[oó]xima(?:\s+p[aá]gina)?|p[aá]gina\s+anterior|anterior|next(?:\s+page)?|prev(?:ious)?(?:\s+page)?)\b/i;

const PAGINATION_CONTAINER_REGEX = /\b(?:pagina[cç][aã]o|pagination|pager|paginator)\b/i;

const OVERLAY_LABEL_REGEX =
  /\b(?:modal|overlay|dialog|di[aá]logo|abrir|open|filtrar|filter|op[cç][oõ]es|options|configura[cç][oõ]es|settings)\b/i;

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  rarr: "→",
  larr: "←",
  mdash: "—",
  ndash: "–",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function decodeHtmlEntitiesLight(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (NAMING_CHECK(lower)) {
      return NAMED_HTML_ENTITIES[lower] ?? full;
    }
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    return full;
  });
}

function NAMING_CHECK(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, key);
}

/**
 * Verifica se um parâmetro de query string é um parâmetro de rastreamento/analytics
 * (`utm_*`, `fbclid`, `gclid`, `_ga`, etc.) que deve ser descartado no cálculo do fingerprint.
 */
export function isTrackingQueryParam(paramName: string): boolean {
  const normalized = paramName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (TRACKING_PARAM_NAMES.has(normalized)) {
    return true;
  }
  return TRACKING_PARAM_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Normaliza uma URL para cálculo de fingerprint e deduplicação:
 * - Remove fragmento (`#hash`)
 * - Remove barra final redundante no `pathname` (exceto `/`)
 * - Remove query params de tracking (`utm_*`, `fbclid`, `gclid`, etc.)
 * - Ordena os query params funcionais restantes de forma determinística
 */
export function normalizeUrlForFingerprint(rawUrl: string, baseUrl?: string): string {
  const parsed = baseUrl ? new URL(rawUrl.trim(), baseUrl) : new URL(rawUrl.trim());
  parsed.hash = "";

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  const keptEntries: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => {
    if (!isTrackingQueryParam(key)) {
      keptEntries.push([key, value]);
    }
  });

  keptEntries.sort((a, b) => {
    const keyCmp = a[0].localeCompare(b[0]);
    return keyCmp !== 0 ? keyCmp : a[1].localeCompare(b[1]);
  });

  parsed.search = "";
  for (const [k, v] of keptEntries) {
    parsed.searchParams.append(k, v);
  }

  return parsed.toString();
}

export function deriveStateId(fingerprint: string): string {
  return `st_${fingerprint.slice(0, 16)}`;
}

/**
 * Calcula o fingerprint SHA-256 de um estado da UI (`docs/04` Fase 2 passo 2.3):
 * Hash SHA-256 de (URL normalizada sem query params de tracking) +
 * (estrutura da árvore de tags/roles dos elementos interativos visíveis, sem texto).
 */
export function computeStateFingerprint(
  rawUrl: string,
  interactiveTree: readonly InteractiveTreeNode[],
  baseUrl?: string,
): string {
  const normalizedUrl = normalizeUrlForFingerprint(rawUrl, baseUrl);
  const sanitizedTree = sanitizeInteractiveTree(interactiveTree);
  return computeSha256(
    canonicalJson({
      url: normalizedUrl,
      interactiveTree: sanitizedTree,
    }),
  );
}

function sanitizeInteractiveTree(nodes: readonly InteractiveTreeNode[]): InteractiveTreeNode[] {
  return nodes.map((node) => {
    const clean: InteractiveTreeNode = {
      tag: node.tag.toLowerCase(),
    };
    if (node.role) {
      clean.role = node.role.toLowerCase();
    }
    if (node.type) {
      clean.type = node.type.toLowerCase();
    }
    if (node.name) {
      clean.name = node.name;
    }
    if (node.method) {
      clean.method = node.method.toLowerCase();
    }
    if (node.actionAttr) {
      clean.actionAttr = node.actionAttr.toLowerCase();
    }
    if (node.required === true) {
      clean.required = true;
    }
    if (node.disabled === true) {
      clean.disabled = true;
    }
    if (node.children && node.children.length > 0) {
      clean.children = sanitizeInteractiveTree(node.children);
    }
    return clean;
  });
}

// ---------------------------------------------------------------------------
// Lightweight HTML AST parser for deterministic DOM structure & action extraction
// ---------------------------------------------------------------------------

export interface HtmlElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlElementNode | string>;
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function parseAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null = attrRegex.exec(rawAttrs);
  while (match !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (name) {
      const rawVal = match[2] ?? match[3] ?? match[4] ?? "";
      attrs[name] = decodeHtmlEntitiesLight(rawVal);
    }
    match = attrRegex.exec(rawAttrs);
  }
  return attrs;
}

export function parseHtmlTree(html: string): HtmlElementNode {
  const root: HtmlElementNode = { tag: "root", attrs: {}, children: [] };
  const stack: HtmlElementNode[] = [root];

  const cleanedHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  const tokenRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null = tokenRegex.exec(cleanedHtml);

  while (match !== null) {
    const fullToken = match[0];
    const tagName = match[1]?.toLowerCase();
    const rawAttrs = match[2] ?? "";
    const selfClosingSlash = match[3] === "/";
    const textChunk = match[4];

    const currentParent = stack[stack.length - 1] ?? root;

    if (textChunk !== undefined) {
      const decoded = decodeHtmlEntitiesLight(textChunk);
      if (decoded.trim().length > 0) {
        currentParent.children.push(decoded);
      }
    } else if (tagName) {
      const isClosing = fullToken.startsWith("</");
      if (isClosing) {
        for (let i = stack.length - 1; i >= 1; i -= 1) {
          if (stack[i]?.tag === tagName) {
            stack.length = i;
            break;
          }
        }
      } else {
        const node: HtmlElementNode = {
          tag: tagName,
          attrs: parseAttributes(rawAttrs),
          children: [],
        };
        currentParent.children.push(node);
        if (!selfClosingSlash && !VOID_HTML_TAGS.has(tagName)) {
          stack.push(node);
        }
      }
    }

    match = tokenRegex.exec(cleanedHtml);
  }

  return root;
}

function isHiddenHtmlElement(node: HtmlElementNode): boolean {
  if (NON_VISIBLE_TAGS.has(node.tag)) {
    return true;
  }
  if ("hidden" in node.attrs) {
    return true;
  }
  if ((node.attrs["aria-hidden"] ?? "").toLowerCase() === "true") {
    return true;
  }
  if (node.tag === "input" && (node.attrs.type ?? "").toLowerCase() === "hidden") {
    return true;
  }
  const style = (node.attrs.style ?? "").toLowerCase();
  if (/display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style)) {
    return true;
  }
  return false;
}

function getElementText(node: HtmlElementNode): string {
  const parts: string[] = [];
  const walk = (n: HtmlElementNode | string) => {
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (isHiddenHtmlElement(n)) {
      return;
    }
    for (const child of n.children) {
      walk(child);
    }
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function inferImplicitAriaRole(tag: string, attrs: Record<string, string>): string | undefined {
  const explicitRole = attrs.role?.trim().toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }
  switch (tag) {
    case "a":
      return attrs.href !== undefined ? "link" : undefined;
    case "button":
      return "button";
    case "nav":
      return "navigation";
    case "header":
      return "banner";
    case "main":
      return "main";
    case "footer":
      return "contentinfo";
    case "aside":
      return "complementary";
    case "form":
      return "form";
    case "dialog":
      return "dialog";
    case "table":
      return "table";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "summary":
      return "button";
    case "input": {
      const t = (attrs.type ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "number") return "spinbutton";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    default:
      return undefined;
  }
}

function isInteractiveElementNode(tag: string, attrs: Record<string, string>): boolean {
  if (tag === "a") {
    return attrs.href !== undefined;
  }
  if (INTERACTIVE_TAGS.has(tag)) {
    if (tag === "input" && (attrs.type ?? "").toLowerCase() === "hidden") {
      return false;
    }
    return true;
  }
  const role = attrs.role?.trim().toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) {
    return true;
  }
  if ((attrs.contenteditable ?? "").toLowerCase() === "true") {
    return true;
  }
  return false;
}

function isStructuralContainerNode(tag: string, attrs: Record<string, string>): boolean {
  if (STRUCTURAL_CONTAINER_TAGS.has(tag)) {
    return true;
  }
  const role = attrs.role?.trim().toLowerCase();
  return Boolean(role && STRUCTURAL_CONTAINER_ROLES.has(role));
}

/**
 * Extrai a árvore estrutural de elementos interativos visíveis (sem texto)
 * a partir de uma string HTML (`docs/04` Fase 2 passo 2.3).
 */
export function extractInteractiveDomTreeFromHtml(html: string): InteractiveTreeNode[] {
  const root = parseHtmlTree(html);

  const buildNodes = (node: HtmlElementNode): InteractiveTreeNode[] => {
    if (isHiddenHtmlElement(node)) {
      return [];
    }

    const childNodes: InteractiveTreeNode[] = [];
    for (const child of node.children) {
      if (typeof child !== "string") {
        childNodes.push(...buildNodes(child));
      }
    }

    const interactive = isInteractiveElementNode(node.tag, node.attrs);
    const structural = isStructuralContainerNode(node.tag, node.attrs);

    if (!interactive && !(structural && childNodes.length > 0)) {
      return childNodes;
    }

    const role = inferImplicitAriaRole(node.tag, node.attrs);
    const treeNode: InteractiveTreeNode = {
      tag: node.tag,
    };
    if (role) {
      treeNode.role = role;
    }
    if (node.tag === "input" || node.tag === "button") {
      const defaultType = node.tag === "input" ? "text" : "submit";
      treeNode.type = (node.attrs.type ?? defaultType).toLowerCase();
    }
    if (
      (node.tag === "input" || node.tag === "select" || node.tag === "textarea") &&
      node.attrs.name
    ) {
      treeNode.name = node.attrs.name;
    }
    if (node.tag === "form") {
      treeNode.method = (node.attrs.method ?? "get").toLowerCase();
    }
    const actionAttr = node.attrs["data-action"] ?? node.attrs["data-feature"];
    if (actionAttr) {
      treeNode.actionAttr = actionAttr.toLowerCase();
    }
    if ("required" in node.attrs) {
      treeNode.required = true;
    }
    if ("disabled" in node.attrs) {
      treeNode.disabled = true;
    }
    if (childNodes.length > 0 && !INTERACTIVE_TAGS.has(node.tag)) {
      treeNode.children = childNodes;
    }

    return [treeNode];
  };

  return buildNodes(root);
}

// ---------------------------------------------------------------------------
// Candidate Action Extraction & Classification
// ---------------------------------------------------------------------------

export interface RawActionCandidateInput {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  ancestors: Array<{ tag: string; attrs: Record<string, string> }>;
  siblingIndex: number;
}

export interface PaginationInfo {
  listKey: string;
  page: string;
}

/**
 * Detecta se uma URL ou ação corresponde a paginação de uma lista e retorna
 * a chave da lista (`origin + pathname`) e o identificador da página (`"1"`, `"2"`, etc.).
 */
export function detectPaginationInfo(
  targetUrl: string | undefined,
  label: string,
  relAttr: string | undefined,
  inPaginationContainer: boolean,
): PaginationInfo | null {
  if (!targetUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }

  for (const [rawKey, rawValue] of parsed.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (PAGINATION_QUERY_KEYS.has(key) && rawValue.trim().length > 0) {
      const baseListUrl = new URL(parsed.toString());
      baseListUrl.searchParams.delete(rawKey);
      baseListUrl.hash = "";
      if (baseListUrl.pathname.length > 1 && baseListUrl.pathname.endsWith("/")) {
        baseListUrl.pathname = baseListUrl.pathname.replace(/\/+$/, "");
      }
      return {
        listKey: `${baseListUrl.origin}${baseListUrl.pathname}`,
        page: `${key}:${rawValue.trim()}`,
      };
    }
  }

  const pagePathMatch = parsed.pathname.match(/^(.*?)\/page\/(\d+)\/?$/i);
  if (pagePathMatch) {
    const basePath = pagePathMatch[1] || "/";
    const pageNum = pagePathMatch[2] ?? "1";
    return {
      listKey: `${parsed.origin}${basePath}`,
      page: `page:${pageNum}`,
    };
  }

  const isRelPagination = relAttr !== undefined && /\b(?:next|prev|previous)\b/i.test(relAttr);
  if (inPaginationContainer || isRelPagination || PAGINATION_LABEL_REGEX.test(label)) {
    return {
      listKey: `${parsed.origin}${parsed.pathname}`,
      page: parsed.search || label.trim().toLowerCase() || "1",
    };
  }

  return null;
}

function buildSelectorForCandidate(input: RawActionCandidateInput): string {
  const { tag, attrs, ancestors, siblingIndex } = input;

  if (attrs.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(attrs.id)) {
    return `#${attrs.id}`;
  }

  const landmarkPrefix = (() => {
    const hasHeader = ancestors.some((a) => a.tag === "header");
    const navAncestor = ancestors.find((a) => a.tag === "nav");
    if (hasHeader && navAncestor) {
      return "header nav ";
    }
    if (navAncestor) {
      if (navAncestor.attrs["aria-label"]) {
        return `nav[aria-label="${navAncestor.attrs["aria-label"].replaceAll('"', '\\"')}"] `;
      }
      return "nav ";
    }
    if (ancestors.some((a) => a.tag === "footer")) {
      return "footer ";
    }
    const formAncestor = [...ancestors].reverse().find((a) => a.tag === "form");
    if (formAncestor) {
      if (formAncestor.attrs.id) {
        return `form#${formAncestor.attrs.id} `;
      }
      if (formAncestor.attrs.action) {
        return `form[action="${formAncestor.attrs.action.replaceAll('"', '\\"')}"] `;
      }
      return "form ";
    }
    if (ancestors.some((a) => a.tag === "main")) {
      return "main ";
    }
    return "";
  })();

  if (attrs["data-action"]) {
    return `${landmarkPrefix}${tag}[data-action="${attrs["data-action"].replaceAll('"', '\\"')}"]`;
  }

  if (attrs["data-feature"]) {
    return `${landmarkPrefix}${tag}[data-feature="${attrs["data-feature"].replaceAll('"', '\\"')}"]`;
  }

  if (tag === "a" && attrs.href) {
    return `${landmarkPrefix}a[href="${attrs.href.replaceAll('"', '\\"')}"]`;
  }

  if ((tag === "input" || tag === "select" || tag === "textarea") && attrs.name) {
    return `${landmarkPrefix}${tag}[name="${attrs.name.replaceAll('"', '\\"')}"]`;
  }

  if (tag === "button" && attrs.type) {
    return `${landmarkPrefix}button[type="${attrs.type.replaceAll('"', '\\"')}"]`;
  }

  if (attrs.role) {
    return `${landmarkPrefix}${tag}[role="${attrs.role.replaceAll('"', '\\"')}"]`;
  }

  return `${landmarkPrefix}${tag}:nth-of-type(${siblingIndex + 1})`;
}

function extractCandidateLabel(input: RawActionCandidateInput): string {
  const { attrs, text } = input;
  const raw =
    attrs["aria-label"]?.trim() ||
    text.trim() ||
    attrs.title?.trim() ||
    attrs.value?.trim() ||
    attrs.placeholder?.trim() ||
    attrs.name?.trim() ||
    attrs.id?.trim() ||
    attrs.href?.trim() ||
    "";
  return raw.replace(/\s+/g, " ").slice(0, 120).trim();
}

/**
 * Classifica uma ação candidata extraída do DOM em um dos tipos de `docs/04` Fase 2:
 * `navigate`, `open-overlay`, `submit-form`, `toggle`, `destructive`, `external`
 * e calcula sua prioridade de enfileiramento:
 * `main-nav` (1) > `tabs-menus` (2) > `content-links` (3) > `pagination` (4).
 */
export function classifyCandidateAction(
  input: RawActionCandidateInput,
  pageUrl: string,
  guard: ScopeGuard,
  allowedOrigins: readonly string[],
): CandidateAction | null {
  const { tag, attrs, ancestors } = input;

  // Ignora inputs comuns de preenchimento que não são botões/toggles/selects de ação direta
  if (tag === "input") {
    const inputType = (attrs.type ?? "text").toLowerCase();
    if (
      inputType !== "submit" &&
      inputType !== "button" &&
      inputType !== "reset" &&
      inputType !== "checkbox" &&
      inputType !== "radio"
    ) {
      return null;
    }
  }
  if (tag === "textarea" || tag === "option") {
    return null;
  }

  const label = extractCandidateLabel(input);
  const selector = buildSelectorForCandidate(input);
  const role = inferImplicitAriaRole(tag, attrs);
  const enclosingForm = [...ancestors].reverse().find((a) => a.tag === "form");
  const formAction = enclosingForm?.attrs.action;
  const formMethod = (enclosingForm?.attrs.method ?? "get").toLowerCase();

  let resolvedTargetUrl: string | undefined;
  let isNonHttpScheme = false;

  const rawHref = tag === "a" || role === "link" ? attrs.href : undefined;
  if (rawHref !== undefined) {
    const trimmedHref = rawHref.trim();
    if (
      trimmedHref === "" ||
      trimmedHref === "#" ||
      trimmedHref.toLowerCase().startsWith("javascript:")
    ) {
      resolvedTargetUrl = undefined;
    } else {
      try {
        const parsed = new URL(trimmedHref, pageUrl);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          parsed.hash = "";
          resolvedTargetUrl = parsed.toString();
        } else {
          isNonHttpScheme = true;
          resolvedTargetUrl = parsed.toString();
        }
      } catch {
        resolvedTargetUrl = undefined;
      }
    }
  } else if (formAction) {
    try {
      const parsed = new URL(formAction.trim(), pageUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        resolvedTargetUrl = parsed.toString();
      }
    } catch {
      resolvedTargetUrl = undefined;
    }
  }

  // 1. Checagem de ação destrutiva (sempre primeiro — docs/04 e docs/10)
  const classAttr = (attrs.class ?? "").toLowerCase();
  const dataActionAttr = (attrs["data-action"] ?? "").toLowerCase();
  const hasDestructiveClass = /\b(?:destructive|danger|btn-danger|delete)\b/.test(classAttr);
  const signalsToCheck = [
    label,
    dataActionAttr,
    rawHref ?? "",
    formAction ?? "",
    resolvedTargetUrl ? new URL(resolvedTargetUrl).pathname : "",
  ].filter((s) => s.length > 0);

  let destructiveReason: string | undefined;
  if (label.length === 0 && !resolvedTargetUrl) {
    destructiveReason = "empty_label_fallback";
  } else if (hasDestructiveClass) {
    destructiveReason = "destructive_class";
  } else {
    for (const signal of signalsToCheck) {
      if (guard.isDestructive(signal)) {
        destructiveReason = `matched:${signal}`;
        break;
      }
    }
  }

  if (destructiveReason !== undefined) {
    return {
      kind: "destructive",
      selector,
      label: label || "[sem rótulo]",
      priorityBucket: "non-navigable",
      priority: 99,
      ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
      ...(enclosingForm ? { method: formMethod } : {}),
      tag,
      ...(role ? { role } : {}),
      destructiveReason,
    };
  }

  // 2. Checagem de link/ação externa (fora de allowedOrigins ou protocolo mailto/tel)
  if (
    isNonHttpScheme ||
    (resolvedTargetUrl !== undefined && !isUrlInAllowedOrigins(resolvedTargetUrl, allowedOrigins))
  ) {
    return {
      kind: "external",
      selector,
      label,
      priorityBucket: "non-navigable",
      priority: 99,
      ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
      tag,
      ...(role ? { role } : {}),
    };
  }

  // 3. Submissão de formulário (`submit-form`)
  const buttonType = (attrs.type ?? (tag === "button" ? "submit" : "")).toLowerCase();
  if (
    (tag === "button" || tag === "input") &&
    buttonType === "submit" &&
    (enclosingForm !== undefined || formAction !== undefined)
  ) {
    return {
      kind: "submit-form",
      selector,
      label,
      priorityBucket: "non-navigable",
      priority: 99,
      ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
      method: formMethod,
      tag,
      ...(role ? { role } : {}),
    };
  }

  // 4. Determina bucket de prioridade e paginação
  const inPaginationContainer = ancestors.some((a) => {
    const aria = a.attrs["aria-label"] ?? "";
    const cls = a.attrs.class ?? "";
    const id = a.attrs.id ?? "";
    return (
      PAGINATION_CONTAINER_REGEX.test(aria) ||
      PAGINATION_CONTAINER_REGEX.test(cls) ||
      PAGINATION_CONTAINER_REGEX.test(id)
    );
  });

  const paginationInfo = detectPaginationInfo(
    resolvedTargetUrl,
    label,
    attrs.rel,
    inPaginationContainer,
  );

  const inMainNav =
    !paginationInfo &&
    !inPaginationContainer &&
    ancestors.some(
      (a) =>
        a.tag === "header" ||
        a.tag === "nav" ||
        (a.attrs.role ?? "").toLowerCase() === "navigation",
    );

  const inTabsOrMenu =
    role === "tab" ||
    role === "menuitem" ||
    ancestors.some((a) => {
      const r = (a.attrs.role ?? "").toLowerCase();
      return r === "tablist" || r === "menu" || r === "menubar";
    });

  // 5. Classifica entre `navigate`, `open-overlay` e `toggle`
  if (tag === "a" || role === "link") {
    if (!resolvedTargetUrl) {
      return null;
    }
    const priorityBucket: ActionPriorityBucket = paginationInfo
      ? "pagination"
      : inMainNav
        ? "main-nav"
        : inTabsOrMenu
          ? "tabs-menus"
          : "content-links";
    const priority =
      priorityBucket === "main-nav"
        ? 1
        : priorityBucket === "tabs-menus"
          ? 2
          : priorityBucket === "content-links"
            ? 3
            : 4;

    return {
      kind: "navigate",
      selector,
      label,
      priorityBucket,
      priority,
      targetUrl: resolvedTargetUrl,
      tag,
      ...(role ? { role } : {}),
      ...(paginationInfo
        ? {
            paginationListKey: paginationInfo.listKey,
            paginationPage: paginationInfo.page,
          }
        : {}),
    };
  }

  const hasPopupAttr =
    attrs["aria-haspopup"] !== undefined &&
    attrs["aria-haspopup"] !== "false" &&
    attrs["aria-haspopup"] !== "";
  const hasOverlayAttr =
    "data-modal" in attrs ||
    "data-dialog" in attrs ||
    "data-overlay" in attrs ||
    "data-drawer" in attrs;

  if (hasPopupAttr || hasOverlayAttr || OVERLAY_LABEL_REGEX.test(label)) {
    return {
      kind: "open-overlay",
      selector,
      label,
      priorityBucket: inMainNav ? "main-nav" : "tabs-menus",
      priority: inMainNav ? 1 : 2,
      ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
      tag,
      ...(role ? { role } : {}),
    };
  }

  return {
    kind: "toggle",
    selector,
    label,
    priorityBucket: inMainNav ? "main-nav" : "tabs-menus",
    priority: inMainNav ? 1 : 2,
    ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
    tag,
    ...(role ? { role } : {}),
  };
}

/**
 * Extrai e classifica todas as ações candidatas visíveis de um documento HTML,
 * ordenadas por prioridade (`main-nav` > `tabs-menus` > `content-links` > `pagination`).
 */
export function extractCandidateActionsFromHtml(
  html: string,
  pageUrl: string,
  guard: ScopeGuard,
): CandidateAction[] {
  const root = parseHtmlTree(html);
  const allowedOrigins = resolveAllowedOriginsFromManifest(guard, pageUrl);
  const candidates: CandidateAction[] = [];
  const seenKey = new Set<string>();

  const walk = (
    node: HtmlElementNode,
    ancestors: Array<{ tag: string; attrs: Record<string, string> }>,
    siblingIndex: number,
  ) => {
    if (isHiddenHtmlElement(node)) {
      return;
    }

    if (isInteractiveElementNode(node.tag, node.attrs)) {
      const classified = classifyCandidateAction(
        {
          tag: node.tag,
          attrs: node.attrs,
          text: getElementText(node),
          ancestors,
          siblingIndex,
        },
        pageUrl,
        guard,
        allowedOrigins,
      );
      if (classified) {
        const dedupKey = `${classified.kind}|${classified.selector}|${classified.targetUrl ?? ""}|${classified.label}`;
        if (!seenKey.has(dedupKey)) {
          seenKey.add(dedupKey);
          candidates.push(classified);
        }
      }
      return;
    }

    const nextAncestors = [...ancestors, { tag: node.tag, attrs: node.attrs }];
    const tagCounts = new Map<string, number>();
    for (const child of node.children) {
      if (typeof child !== "string") {
        const count = tagCounts.get(child.tag) ?? 0;
        tagCounts.set(child.tag, count + 1);
        walk(child, nextAncestors, count);
      }
    }
  };

  walk(root, [], 0);

  return candidates.sort((a, b) => a.priority - b.priority);
}

function resolveAllowedOriginsFromManifest(guard: ScopeGuard, fallbackUrl: string): string[] {
  const origins = new Set<string>(guard.manifest.target.allowedOrigins ?? []);
  if (guard.manifest.target.url) {
    try {
      origins.add(new URL(guard.manifest.target.url).origin);
    } catch {
      // ignore
    }
  }
  try {
    origins.add(new URL(fallbackUrl).origin);
  } catch {
    // ignore
  }
  return Array.from(origins);
}

// ---------------------------------------------------------------------------
// Browser Live DOM Extraction (checks computed visibility in Chromium via CDP)
// ---------------------------------------------------------------------------

/**
 * Filtra elementos ocultos via CSS computado (`display: none`, `visibility: hidden`)
 * quando executado em uma página real do Playwright/Chromium, retornando o HTML visível.
 */
async function extractVisiblePageHtml(page: PlaywrightPage): Promise<string> {
  if (typeof page.evaluate === "function") {
    try {
      const evaluated = await page.evaluate(`(() => {
        const clone = document.documentElement.cloneNode(true);
        const origEls = document.documentElement.querySelectorAll("*");
        const cloneEls = clone.querySelectorAll("*");
        for (let i = 0; i < origEls.length; i++) {
          const orig = origEls[i];
          const cloned = cloneEls[i];
          if (!orig || !cloned) continue;
          const style = window.getComputedStyle(orig);
          if (style.display === "none" || style.visibility === "hidden") {
            cloned.setAttribute("hidden", "");
          }
        }
        return clone.outerHTML;
      })()`);
      if (typeof evaluated === "string" && evaluated.length > 0) {
        return evaluated;
      }
    } catch {
      // Fallback para page.content()
    }
  }

  if (typeof page.content === "function") {
    return page.content();
  }
  return "";
}

// ---------------------------------------------------------------------------
// HTTP 429 Retry-After & Anti-Bot Challenge Detection (docs/10 §2)
// ---------------------------------------------------------------------------

export function parseRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!retryAfterHeader) {
    return null;
  }
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
}

export function detectExploreChallenge(
  status: number,
  headers: Record<string, string>,
  html: string,
): string | null {
  const lower = html.toLowerCase();
  if (
    lower.includes("cf-turnstile") ||
    lower.includes("challenges.cloudflare.com") ||
    lower.includes("cf-chl-bypass") ||
    ((status === 403 || status === 503) &&
      Boolean(headers["cf-ray"]) &&
      (lower.includes("just a moment") || lower.includes("attention required")))
  ) {
    return "Desafio anti-bot Cloudflare / Turnstile detectado durante a exploração.";
  }
  if (
    lower.includes('class="g-recaptcha"') ||
    lower.includes("class='g-recaptcha'") ||
    lower.includes('class="h-captcha"') ||
    lower.includes("class='h-captcha'") ||
    ((status === 403 || status === 429) &&
      (lower.includes("g-recaptcha") ||
        lower.includes("h-captcha") ||
        lower.includes("verify you are human")))
  ) {
    return "Desafio CAPTCHA detectado durante a exploração.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// State Graph Serialization & Validation (`jobs/<jobId>/graph/state-graph.json`)
// ---------------------------------------------------------------------------

export function resolveStateGraphPath(evidenceStore: EvidenceStore, jobId: string): string {
  return join(evidenceStore.resolveJobDir(jobId), "graph", "state-graph.json");
}

export function validateStateGraph(input: unknown): StateGraph {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("state-graph inválido: esperado objeto raiz.");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
    throw new Error("state-graph inválido: campo 'jobId' obrigatório.");
  }
  if (typeof obj.entryUrl !== "string" || obj.entryUrl.trim().length === 0) {
    throw new Error("state-graph inválido: campo 'entryUrl' obrigatório.");
  }
  if (typeof obj.generatedAt !== "string" || obj.generatedAt.trim().length === 0) {
    throw new Error("state-graph inválido: campo 'generatedAt' obrigatório.");
  }
  if (!Array.isArray(obj.nodes)) {
    throw new Error("state-graph inválido: campo 'nodes' deve ser um array.");
  }
  if (!Array.isArray(obj.edges)) {
    throw new Error("state-graph inválido: campo 'edges' deve ser um array.");
  }

  const nodeIds = new Set<string>();
  for (const rawNode of obj.nodes) {
    if (typeof rawNode !== "object" || rawNode === null) {
      throw new Error("state-graph inválido: nó deve ser um objeto.");
    }
    const n = rawNode as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id.startsWith("st_")) {
      throw new Error(`state-graph inválido: nó com id inválido "${String(n.id)}".`);
    }
    if (typeof n.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(n.fingerprint)) {
      throw new Error(`state-graph inválido: nó "${n.id}" com fingerprint SHA-256 inválido.`);
    }
    if (typeof n.url !== "string" || typeof n.normalizedUrl !== "string") {
      throw new Error(`state-graph inválido: nó "${n.id}" sem url/normalizedUrl.`);
    }
    if (n.screenshotEvidenceIds !== undefined && !Array.isArray(n.screenshotEvidenceIds)) {
      throw new Error(`state-graph inválido: nó "${n.id}" com screenshotEvidenceIds inválido.`);
    }
    if (
      n.domSnapshotEvidenceId !== undefined &&
      (typeof n.domSnapshotEvidenceId !== "string" || !n.domSnapshotEvidenceId.startsWith("ev_"))
    ) {
      throw new Error(`state-graph inválido: nó "${n.id}" com domSnapshotEvidenceId inválido.`);
    }
    if (
      n.a11ySnapshotEvidenceId !== undefined &&
      (typeof n.a11ySnapshotEvidenceId !== "string" || !n.a11ySnapshotEvidenceId.startsWith("ev_"))
    ) {
      throw new Error(`state-graph inválido: nó "${n.id}" com a11ySnapshotEvidenceId inválido.`);
    }
    nodeIds.add(n.id);
  }

  for (const rawEdge of obj.edges) {
    if (typeof rawEdge !== "object" || rawEdge === null) {
      throw new Error("state-graph inválido: aresta deve ser um objeto.");
    }
    const e = rawEdge as Record<string, unknown>;
    if (typeof e.from !== "string" || e.from.trim().length === 0) {
      throw new Error("state-graph inválido: aresta sem 'from'.");
    }
    if (typeof e.to !== "string" || e.to.trim().length === 0) {
      throw new Error("state-graph inválido: aresta sem 'to'.");
    }
    if (typeof e.action !== "object" || e.action === null) {
      throw new Error("state-graph inválido: aresta sem objeto 'action'.");
    }
    const action = e.action as Record<string, unknown>;
    if (
      typeof action.kind !== "string" ||
      !(ACTION_KINDS as readonly string[]).includes(action.kind)
    ) {
      throw new Error(`state-graph inválido: action.kind inválido "${String(action.kind)}".`);
    }
    if (typeof action.selector !== "string" || action.selector.trim().length === 0) {
      throw new Error("state-graph inválido: action.selector obrigatório.");
    }
    if (typeof action.label !== "string") {
      throw new Error("state-graph inválido: action.label deve ser string.");
    }
  }

  return input as StateGraph;
}

function writeStateGraphToDisk(
  evidenceStore: EvidenceStore,
  jobId: string,
  graph: StateGraph,
): string {
  const validated = validateStateGraph(graph);
  const graphPath = resolveStateGraphPath(evidenceStore, jobId);
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return graphPath;
}

// ---------------------------------------------------------------------------
// F1-05: Multi-viewport screenshots, reduced DOM snapshot and A11y snapshot
// ---------------------------------------------------------------------------

const MOCK_PNG_CACHE = new Map<string, Buffer>();

function createPngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crc.writeUInt32BE(crcVal >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Gera um buffer PNG mínimo e 100% válido nas dimensões especificadas (`width` x `height`),
 * com seed determinístico opcional para gerar hashes distintos por URL/conteúdo em mocks/testes.
 */
export function generateMockPng(width: number, height: number, seed?: string): Buffer {
  const safeW = Math.max(1, Math.min(width, 7680));
  const safeH = Math.max(1, Math.min(height, 4320));
  const cacheKey = `${safeW}x${safeH}:${seed ?? ""}`;
  const cached = MOCK_PNG_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(safeW, 0);
  ihdr.writeUInt32BE(safeH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = createPngChunk("IHDR", ihdr);

  const scanlineLength = 1 + safeW * 3;
  const rawData = Buffer.alloc(safeH * scanlineLength);
  if (seed && seed.length > 0) {
    const seedBytes = Buffer.from(seed, "utf8");
    for (let i = 0; i < seedBytes.length; i++) {
      const idx = 1 + (i % (rawData.length - 1));
      rawData[idx] = ((rawData[idx] ?? 0) ^ (seedBytes[i] ?? 0)) & 0xff;
    }
  }
  const compressed = deflateSync(rawData);
  const idatChunk = createPngChunk("IDAT", compressed);
  const iendChunk = createPngChunk("IEND", Buffer.alloc(0));
  const fullPng = Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);

  MOCK_PNG_CACHE.set(cacheKey, fullPng);
  return fullPng;
}

/**
 * Reduz e sanitiza um documento HTML para persistência clean room (`docs/04` Fase 2 passo 2.4 e `docs/10` §3-§4):
 * - Remove todas as tags `<script>` e seus conteúdos (incluindo self-closing e variações).
 * - Remove todas as tags `<style>` e seus conteúdos (incluindo self-closing e variações).
 * - Remove comentários HTML (`<!-- ... -->`).
 * - Remove tags `<noscript>` e seus conteúdos.
 * - Reduz `<svg>` pesados (> 300 caracteres ou com tags internas como `<path>`, `<polygon>`, etc.), preservando a tag `<svg>` e atributos sanitizados.
 * - Trunca atributos `data-*` longos (> 40 caracteres) e URLs base64 longas para `[TRUNCATED]`.
 * - Trunca nós de texto acima de 200 caracteres (proteção clean room / LGPD).
 */
export function reduceDomSnapshot(html: string): string {
  if (!html || typeof html !== "string") {
    return "";
  }

  let cleaned = html
    // 1. Remove comentários HTML
    .replace(/<!--[\s\S]*?-->/g, "");

  // 2. Remove <script> (loop defensivo para evitar tags aninhadas ou malformadas)
  while (/<script\b/i.test(cleaned)) {
    const prev = cleaned;
    cleaned = cleaned
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<script\b[^>]*\/>/gi, "")
      .replace(/<script\b[^>]*>/gi, "");
    if (cleaned === prev) {
      break;
    }
  }

  // 3. Remove <style> (loop defensivo)
  while (/<style\b/i.test(cleaned)) {
    const prev = cleaned;
    cleaned = cleaned
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<style\b[^>]*\/>/gi, "")
      .replace(/<style\b[^>]*>/gi, "");
    if (cleaned === prev) {
      break;
    }
  }

  // 4. Remove <noscript>
  cleaned = cleaned.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // 5. Reduz SVGs pesados
  cleaned = cleaned.replace(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi, (full, attrs, inner) => {
    if (full.length > 300 || /<path|<polygon|<polyline|<g|<rect/i.test(inner)) {
      return `<svg${attrs} data-cleanroom-reduced="svg"></svg>`;
    }
    return full;
  });

  // 6. Trunca atributos data-* longos (> 40 chars) e data: URIs longas
  cleaned = cleaned.replace(/<(?:[a-zA-Z][a-zA-Z0-9-]*)([^>]*?)>/g, (tagMatch) => {
    return tagMatch
      .replace(
        /\b(data-[a-zA-Z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
        (attrMatch, attrName, val1, val2) => {
          const val = val1 !== undefined ? val1 : val2;
          if (val && val.length > 40) {
            return `${attrName}="[TRUNCATED]"`;
          }
          return attrMatch;
        },
      )
      .replace(
        /\b(src|href)\s*=\s*(?:"data:[^"]{40,}"|'data:[^']{40,}')/gi,
        (_match, attr) => `${attr}="data:[TRUNCATED]"`,
      );
  });

  // 7. Trunca nós de texto acima de 200 caracteres (nós entre tags)
  cleaned = cleaned.replace(/>([^<]+)</g, (match, text) => {
    const trimmed = text.trim();
    if (trimmed.length > 200) {
      const leading = text.match(/^\s*/)?.[0] ?? "";
      const trailing = text.match(/\s*$/)?.[0] ?? "";
      return `>${leading}${trimmed.slice(0, 197)}...${trailing}<`;
    }
    return match;
  });

  // Trunca texto inicial (antes da primeira tag) e final (após última tag) se houver
  if (!cleaned.startsWith("<")) {
    cleaned = cleaned.replace(/^([^<]+)/, (m, text) => {
      const trimmed = text.trim();
      if (trimmed.length > 200) {
        return `${trimmed.slice(0, 197)}...`;
      }
      return m;
    });
  }
  if (!cleaned.endsWith(">")) {
    cleaned = cleaned.replace(/([^>]+)$/, (m, text) => {
      const trimmed = text.trim();
      if (trimmed.length > 200) {
        return `${trimmed.slice(0, 197)}...`;
      }
      return m;
    });
  }

  // Remove linhas em branco excessivas
  return cleaned.replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

/**
 * Gera uma árvore de acessibilidade simplificada no formato YAML do `ariaSnapshot` (`docs/04` Fase 2 passo 2.4).
 */
export function extractAriaSnapshotFromHtml(html: string): string {
  if (!html || typeof html !== "string") {
    return "- document";
  }

  const lines: string[] = ["- document:"];

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = decodeHtmlEntitiesLight(titleMatch[1]).replace(/\s+/g, " ").trim();
    if (title) {
      lines.push(`  - heading "${title.slice(0, 100)}" [level=1]`);
    }
  }

  const headingRegex = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hMatch = headingRegex.exec(html);
  while (hMatch !== null) {
    const level = hMatch[1];
    const text = decodeHtmlEntitiesLight(hMatch[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      lines.push(`  - heading "${text.slice(0, 100)}" [level=${level}]`);
    }
    hMatch = headingRegex.exec(html);
  }

  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let aMatch = linkRegex.exec(html);
  let linksCount = 0;
  while (aMatch !== null && linksCount < 30) {
    const text = decodeHtmlEntitiesLight(aMatch[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      lines.push(`  - link "${text.slice(0, 80)}"`);
      linksCount += 1;
    }
    aMatch = linkRegex.exec(html);
  }

  const btnRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bMatch = btnRegex.exec(html);
  let btnCount = 0;
  while (bMatch !== null && btnCount < 30) {
    const text = decodeHtmlEntitiesLight(bMatch[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      lines.push(`  - button "${text.slice(0, 80)}"`);
      btnCount += 1;
    }
    bMatch = btnRegex.exec(html);
  }

  return lines.length > 1 ? lines.join("\n") : "- document";
}

export interface A11ySnapshotResult {
  snapshot: string | Record<string, unknown>;
  format: "ariaSnapshot" | "accessibilityTree" | "empty";
}

/**
 * Captura a árvore de acessibilidade da página atual (`docs/04` Fase 2 passo 2.4):
 * - No Playwright 1.49+, prioriza `page.locator("body").ariaSnapshot()`.
 * - Como fallback para Playwright legado ou mocks, tenta `page.accessibility.snapshot()`.
 * - Se ambos falharem ou indisponíveis, gera representação a partir de `htmlFallback`.
 */
export async function captureA11ySnapshot(
  page: PlaywrightPage,
  htmlFallback?: string,
): Promise<A11ySnapshotResult> {
  // 1. Playwright 1.49+ ariaSnapshot()
  try {
    if (typeof page.locator === "function") {
      const bodyLocator = page.locator("body") as unknown as {
        ariaSnapshot?: () => Promise<unknown>;
      };
      if (typeof bodyLocator.ariaSnapshot === "function") {
        const yaml = await bodyLocator.ariaSnapshot();
        if (typeof yaml === "string" && yaml.trim().length > 0) {
          return {
            snapshot: yaml.trim(),
            format: "ariaSnapshot",
          };
        }
      }
    }
  } catch {
    // continua para o fallback
  }

  // 2. Playwright legado accessibility.snapshot()
  try {
    const pageWithA11y = page as { accessibility?: { snapshot?: () => Promise<unknown> } };
    if (typeof pageWithA11y.accessibility?.snapshot === "function") {
      const tree = await pageWithA11y.accessibility.snapshot();
      if (tree && typeof tree === "object") {
        return {
          snapshot: tree as Record<string, unknown>,
          format: "accessibilityTree",
        };
      }
    }
  } catch {
    // continua para o fallback
  }

  // 3. Fallback estruturado a partir do HTML
  if (htmlFallback && typeof htmlFallback === "string") {
    return {
      snapshot: extractAriaSnapshotFromHtml(htmlFallback),
      format: "ariaSnapshot",
    };
  }

  return {
    snapshot: "- document",
    format: "empty",
  };
}

// ---------------------------------------------------------------------------
// Fetch-backed CDP Connector (for fast deterministic integration tests)
// ---------------------------------------------------------------------------

/**
 * Cria um `CdpConnector` leve apoiado em uma função `fetch` (ex.: `demoApp.fetch`),
 * permitindo executar `BrowserSession` e `runExplorePhase` em testes de integração
 * sem depender de um processo Chrome externo quando o Browserless não está presente.
 */
export function createFetchBackedCdpConnector(fetchFn: typeof globalThis.fetch): CdpConnector {
  return async () => {
    let currentUrl = "about:blank";
    let currentHtml = "";
    let pageClosed = false;
    let viewport = { width: 1440, height: 900 };

    const mockPage: PlaywrightPage = {
      url: () => currentUrl,
      title: async () => {
        const match = currentHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        return match?.[1] ? decodeHtmlEntitiesLight(match[1]).replace(/\s+/g, " ").trim() : "";
      },
      content: async () => currentHtml,
      setViewportSize: async (vp: { width: number; height: number }) => {
        viewport = { ...vp };
      },
      viewportSize: () => ({ ...viewport }),
      isClosed: () => pageClosed,
      close: async () => {
        pageClosed = true;
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      screenshot: async (_opts?: { type?: string }) => {
        return generateMockPng(viewport.width, viewport.height, currentUrl);
      },
      locator: (_selector: string) => {
        return {
          ariaSnapshot: async () => {
            return extractAriaSnapshotFromHtml(currentHtml);
          },
        } as unknown as ReturnType<PlaywrightPage["locator"]>;
      },
      accessibility: {
        snapshot: async () => {
          return { role: "WebArea", name: "MockPage" };
        },
      } as unknown as { snapshot: () => Promise<unknown> },
      goto: async (url: string) => {
        const res = await fetchFn(url, {
          method: "GET",
          redirect: "follow",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "kraken-cleanroom/0.1",
          },
        });
        currentUrl = res.url || url;
        currentHtml = await res.text();
        const headersObj: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headersObj[key.toLowerCase()] = value;
        });

        const playwrightResponse = {
          url: () => currentUrl,
          status: () => res.status,
          statusText: () => res.statusText,
          ok: () => res.ok,
          headers: () => headersObj,
          allHeaders: async () => headersObj,
          text: async () => currentHtml,
        } as unknown as PlaywrightResponse;

        return playwrightResponse;
      },
    } as unknown as PlaywrightPage;

    const openPages: PlaywrightPage[] = [];

    const mockContext: BrowserContext = {
      newPage: async () => {
        openPages.push(mockPage);
        return mockPage;
      },
      pages: () => openPages.filter((p) => !p.isClosed()),
      route: async () => undefined,
      close: async () => {
        pageClosed = true;
      },
    } as unknown as BrowserContext;

    const mockBrowser: Browser = {
      newContext: async () => mockContext,
      close: async () => undefined,
      version: () => "FetchBackedCleanroomBrowser/0.1",
    } as unknown as Browser;

    return mockBrowser;
  };
}

// ---------------------------------------------------------------------------
// Route proxy helper for remote Browserless -> local test servers
// ---------------------------------------------------------------------------

async function attachRouteFetchProxy(
  context: BrowserContext,
  routeFetch: typeof globalThis.fetch,
  allowedOrigins: readonly string[],
): Promise<void> {
  if (typeof context.route !== "function") {
    return;
  }
  await context.route("**/*", async (route: PlaywrightRoute) => {
    const req = route.request();
    const reqUrl = req.url();
    if (!isUrlInAllowedOrigins(reqUrl, allowedOrigins)) {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      const method = req.method();
      const reqHeaders = req.headers();
      const postData = req.postDataBuffer();
      const res = await routeFetch(reqUrl, {
        method,
        headers: reqHeaders,
        ...(postData && method !== "GET" && method !== "HEAD" ? { body: postData } : {}),
        redirect: "follow",
      });
      const bodyBuffer = Buffer.from(await res.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      await route.fulfill({
        status: res.status,
        headers: responseHeaders,
        body: bodyBuffer,
      });
    } catch {
      await route.abort("failed");
    }
  });
}

// ---------------------------------------------------------------------------
// Phase 2: `explore` — Priority BFS Crawler & State Graph Builder
// ---------------------------------------------------------------------------

function restoreRobotsPolicyFromEvidence(ctx: PhaseContext): void {
  if (!ctx.manifest.limits.respectRobotsTxt) {
    return;
  }
  const robotsEvidences = ctx.evidence.list(ctx.job.id, { kind: "robots", limit: 5 }).items;
  const latestRobots = robotsEvidences[robotsEvidences.length - 1];
  if (!latestRobots || latestRobots.data.found !== true) {
    return;
  }
  const disallow = Array.isArray(latestRobots.data.disallow)
    ? latestRobots.data.disallow.filter((x: unknown): x is string => typeof x === "string")
    : [];
  const allow = Array.isArray(latestRobots.data.allow)
    ? latestRobots.data.allow.filter((x: unknown): x is string => typeof x === "string")
    : [];
  const policy: RobotsPolicy = { disallow, allow };
  ctx.guard.setRobotsTxt(policy);
}

function collectSeedUrls(
  ctx: PhaseContext,
  explicitSeeds?: readonly string[],
): { primarySeed: string | null; secondarySeeds: string[] } {
  const rawEntry = ctx.manifest.target.url;
  if (!rawEntry) {
    return { primarySeed: null, secondarySeeds: [] };
  }
  const entryNormalized = normalizeSeedUrl(rawEntry) ?? rawEntry;
  const entryOrigin = new URL(entryNormalized).origin;
  const seen = new Set<string>();
  const secondarySeeds: string[] = [];

  const primarySeed = ctx.guard.canNavigate(entryNormalized) ? entryNormalized : null;
  if (primarySeed) {
    seen.add(normalizeUrlForFingerprint(primarySeed));
  }

  const tryAddSecondary = (candidate: string) => {
    const normalized = normalizeSeedUrl(candidate, entryOrigin);
    if (!normalized) {
      return;
    }
    if (!ctx.guard.canNavigate(normalized)) {
      return;
    }
    const fpUrl = normalizeUrlForFingerprint(normalized);
    if (seen.has(fpUrl)) {
      return;
    }
    seen.add(fpUrl);
    secondarySeeds.push(normalized);
  };

  if (explicitSeeds) {
    for (const s of explicitSeeds) {
      tryAddSecondary(s);
    }
  }

  for (const docUrl of ctx.manifest.target.docsUrls) {
    tryAddSecondary(docUrl);
  }

  // Também aproveita URLs descobertas na fase intake caso estejam salvas nas evidências
  const intakeEvidences = ctx.evidence.list(ctx.job.id, { phase: "intake", limit: 20 }).items;
  for (const ev of intakeEvidences) {
    for (const field of [ev.data.seedUrls, ev.data.sitemapUrls]) {
      if (Array.isArray(field)) {
        for (const u of field) {
          if (typeof u === "string") {
            tryAddSecondary(u);
          }
        }
      }
    }
  }

  return { primarySeed, secondarySeeds };
}

function parseSavedExploreCheckpoint(raw: unknown): ExploreCheckpoint | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges) || !Array.isArray(obj.queue)) {
    return null;
  }
  return obj as unknown as ExploreCheckpoint;
}

/**
 * Executa a Fase 2 (`explore` — `docs/04-pipeline-e-fases.md`):
 * - Algoritmo BFS com fila de prioridade (`main-nav` > `tabs-menus` > `content-links` > `pagination`)
 * - Navegação controlada por `guard.throttle()` e `guard.canNavigate(url)`
 * - Espera de `networkidle` (timeout 10s) + 500ms de estabilização
 * - Cálculo de fingerprint SHA-256 (URL sem tracking + árvore de tags/roles de elementos interativos visíveis sem texto)
 * - Respeito estrito a `maxPages`, `maxDepth`, `maxDurationMin`, `forbiddenPaths`, `robots.txt` e bloqueio de ações `destructive`
 * - Limite de paginação de máx. 2 páginas por lista
 * - Tratamento de HTTP 429 (`Retry-After`, redução de `rateLimitRps` pela metade após 3x, `blocked` após 6x) e HTTP 403 / desafios anti-bot
 * - Persistência de evidências `state` e `transition` e gravação de `jobs/<jobId>/graph/state-graph.json`
 */
export async function runExplorePhase(
  ctx: PhaseContext,
  options?: ExplorePhaseOptions,
): Promise<ExploreRunResult> {
  ctx.guard.assertMethod("behavioralUi");

  const rawEntryUrl = ctx.manifest.target.url;
  if (!rawEntryUrl) {
    return {
      phaseResult: {
        status: "ok",
        stats: {
          pagesVisited: 0,
          statesDiscovered: 0,
          transitionsRecorded: 0,
          formsDiscovered: 0,
          formProbesCount: 0,
          skippedRepoTarget: 1,
        },
      },
      stateEvidences: [],
      transitionEvidences: [],
      formSchemaEvidences: [],
      formProbeEvidences: [],
    };
  }

  restoreRobotsPolicyFromEvidence(ctx);

  const nowFn = options?.now ?? (() => Date.now());
  const sleepFn = options?.sleep ?? defaultSleep;
  const networkIdleTimeoutMs = options?.networkIdleTimeoutMs ?? DEFAULT_NETWORK_IDLE_TIMEOUT_MS;
  const stabilizationMs = options?.stabilizationMs ?? DEFAULT_STABILIZATION_MS;
  const navigationTimeoutMs = options?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const maxPagesPerList = options?.maxPagesPerList ?? DEFAULT_MAX_PAGES_PER_LIST;
  const maxPages = ctx.manifest.limits.maxPages;
  const maxDepth = ctx.manifest.limits.maxDepth;
  const maxDurationMs = options?.maxDurationMs ?? ctx.manifest.limits.maxDurationMin * 60 * 1000;
  const startTimeMs = nowFn();

  const entryUrl = normalizeSeedUrl(rawEntryUrl) ?? rawEntryUrl;
  const allowedOrigins = resolveAllowedOriginsFromManifest(ctx.guard, entryUrl);

  // Restaura estado do checkpoint se estivermos retomando a fase
  const savedCheckpoint = parseSavedExploreCheckpoint(ctx.checkpoint);

  const visitedNormalizedUrls = new Set<string>(savedCheckpoint?.visitedUrls ?? []);
  const nodesByFingerprint = new Map<string, StateGraphNode>();
  const urlToStateId = new Map<string, string>();
  const nodes: StateGraphNode[] = [];
  const edges: StateGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const stateEvidences: Evidence[] = [];
  const transitionEvidences: Evidence[] = [];
  const screenshotEvidences: Evidence[] = [];
  const domSnapshotEvidences: Evidence[] = [];
  const a11ySnapshotEvidences: Evidence[] = [];
  let screenshotsCaptured = 0;
  let domSnapshotsCaptured = 0;
  let a11ySnapshotsCaptured = 0;
  const formSchemaEvidences: Evidence[] = [];
  const formProbeEvidences: Evidence[] = [];
  const discoveredFormIds = new Set<string>(savedCheckpoint?.discoveredFormIds ?? []);

  if (savedCheckpoint) {
    for (const node of savedCheckpoint.nodes) {
      nodes.push(node);
      nodesByFingerprint.set(node.fingerprint, node);
      urlToStateId.set(node.normalizedUrl, node.id);
    }
    for (const edge of savedCheckpoint.edges) {
      const key = `${edge.from}|${edge.to}|${edge.action.kind}|${edge.action.selector}`;
      edgeKeys.add(key);
      edges.push(edge);
    }
  }

  const listPagesVisited = new Map<string, Set<string>>();
  if (savedCheckpoint?.listPagesVisited) {
    for (const [listKey, pages] of Object.entries(savedCheckpoint.listPagesVisited)) {
      listPagesVisited.set(listKey, new Set(pages));
    }
  }
  const listFirstPageStateIds = new Map<string, string>(
    Object.entries(savedCheckpoint?.listFirstPageStateIds ?? {}),
  );

  let pagesVisitedCount = savedCheckpoint?.pagesVisitedCount ?? 0;
  let skippedOutOfScope = savedCheckpoint?.skippedOutOfScope ?? 0;
  let skippedDestructive = savedCheckpoint?.skippedDestructive ?? 0;
  let skippedPaginationLimit = savedCheckpoint?.skippedPaginationLimit ?? 0;
  let rateLimit429Count = savedCheckpoint?.rateLimit429Count ?? 0;
  let currentRateLimitRps =
    savedCheckpoint?.currentRateLimitRps ?? Math.max(0.1, ctx.manifest.limits.rateLimitRps);
  const initialRateLimitRps = Math.max(0.1, ctx.manifest.limits.rateLimitRps);
  let sequenceCounter = savedCheckpoint?.sequenceCounter ?? 0;

  const queue: QueuedExplorationItem[] = savedCheckpoint ? [...savedCheckpoint.queue] : [];

  const enqueueItem = (item: Omit<QueuedExplorationItem, "sequence">) => {
    if (item.depth > maxDepth) {
      return;
    }
    if (!ctx.guard.canNavigate(item.url)) {
      skippedOutOfScope += 1;
      return;
    }
    sequenceCounter += 1;
    queue.push({
      ...item,
      sequence: sequenceCounter,
    });
    queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.sequence - b.sequence;
    });
  };

  if (!savedCheckpoint) {
    const { primarySeed, secondarySeeds } = collectSeedUrls(ctx, options?.seedUrls);
    if (!primarySeed) {
      return {
        phaseResult: {
          status: "blocked",
          reason: `A URL de entrada "${entryUrl}" foi bloqueada pelo ScopeGuard.`,
        },
        stateEvidences: [],
        transitionEvidences: [],
        formSchemaEvidences: [],
        formProbeEvidences: [],
      };
    }

    enqueueItem({
      url: primarySeed,
      depth: 0,
      priority: 0,
    });

    // Sementes secundárias (sitemap / docsUrls) entram com depth=1 e prioridade 3.5 para que links diretos da UI
    // (main-nav=1, tabs=2, content=3) sejam explorados primeiro, gerando arestas de transição ricas.
    for (const seed of secondarySeeds) {
      enqueueItem({
        url: seed,
        depth: 1,
        priority: 3.5,
      });
    }
  }

  const recordTransition = (
    fromStateId: string,
    toStateId: string,
    action: StateGraphAction,
    targetUrl: string,
  ) => {
    const key = `${fromStateId}|${toStateId}|${action.kind}|${action.selector}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);

    const edge: StateGraphEdge = {
      from: fromStateId,
      to: toStateId,
      action: {
        kind: action.kind,
        selector: action.selector,
        label: action.label,
      },
    };
    edges.push(edge);

    const transitionData = {
      from: edge.from,
      to: edge.to,
      action: edge.action,
      targetUrl,
    };
    const ev = ctx.evidence.put({
      jobId: ctx.job.id,
      kind: "transition",
      phase: "explore",
      url: targetUrl,
      stateId: edge.from,
      blob: canonicalJson(transitionData),
      summary: `Transição ${edge.from} -> ${edge.to} via [${edge.action.kind}] "${edge.action.label}" (${edge.action.selector})`,
      data: transitionData,
    });
    transitionEvidences.push(ev);
  };

  const buildCurrentGraph = (): StateGraph => {
    let maxDepthReached = 0;
    for (const node of nodes) {
      if (node.depth > maxDepthReached) {
        maxDepthReached = node.depth;
      }
    }
    return {
      jobId: ctx.job.id,
      entryUrl,
      generatedAt: new Date(nowFn()).toISOString(),
      nodes: [...nodes],
      edges: [...edges],
      stats: {
        pagesVisited: pagesVisitedCount,
        statesDiscovered: nodes.length,
        transitionsRecorded: edges.length,
        skippedOutOfScope,
        skippedDestructive,
        skippedPaginationLimit,
        maxDepthReached,
        rateLimit429Count,
        screenshotsCaptured,
        domSnapshotsCaptured,
        a11ySnapshotsCaptured,
      },
    };
  };

  const persistProgress = (): {
    checkpoint: ExploreCheckpoint;
    graph: StateGraph;
    path: string;
  } => {
    const serializedListPages: Record<string, string[]> = {};
    for (const [k, set] of listPagesVisited.entries()) {
      serializedListPages[k] = Array.from(set);
    }
    const serializedFirstPages: Record<string, string> = {};
    for (const [k, stateId] of listFirstPageStateIds.entries()) {
      serializedFirstPages[k] = stateId;
    }

    const checkpoint: ExploreCheckpoint = {
      visitedUrls: Array.from(visitedNormalizedUrls),
      nodes: [...nodes],
      edges: [...edges],
      queue: [...queue],
      listPagesVisited: serializedListPages,
      listFirstPageStateIds: serializedFirstPages,
      pagesVisitedCount,
      skippedOutOfScope,
      skippedDestructive,
      skippedPaginationLimit,
      rateLimit429Count,
      currentRateLimitRps,
      sequenceCounter,
      discoveredFormIds: Array.from(discoveredFormIds),
      formsDiscoveredCount: formSchemaEvidences.length,
      formProbesCount: formProbeEvidences.length,
      updatedAt: new Date(nowFn()).toISOString(),
    };
    ctx.saveCheckpoint(checkpoint);
    const graph = buildCurrentGraph();
    const path = writeStateGraphToDisk(ctx.evidence, ctx.job.id, graph);
    return { checkpoint, graph, path };
  };

  const executeWithSession = async (session: BrowserSession): Promise<ExploreRunResult> => {
    if (options?.routeFetch) {
      await attachRouteFetchProxy(session.context, options.routeFetch, allowedOrigins);
    }

    const page = await session.getPage();

    while (queue.length > 0) {
      if (ctx.signal.aborted) {
        break;
      }
      if (pagesVisitedCount >= maxPages) {
        ctx.log.info({ maxPages }, "limite maxPages atingido; encerrando exploração");
        break;
      }
      if (nowFn() - startTimeMs >= maxDurationMs) {
        ctx.log.info({ maxDurationMs }, "limite maxDurationMin atingido; encerrando exploração");
        break;
      }

      const item = queue.shift();
      if (!item) {
        break;
      }

      if (item.depth > maxDepth) {
        continue;
      }

      // Guardrail estrito: nunca navegar fora do escopo permitido
      if (!ctx.guard.canNavigate(item.url)) {
        skippedOutOfScope += 1;
        continue;
      }

      // Guardrail estrito: nunca executar ação destrutiva quando destructiveActions === false
      if (item.viaAction) {
        if (
          item.viaAction.kind === "destructive" ||
          (!ctx.manifest.limits.destructiveActions && ctx.guard.isDestructive(item.viaAction.label))
        ) {
          skippedDestructive += 1;
          continue;
        }
      }

      const normalizedCandidateUrl = normalizeUrlForFingerprint(item.url);

      // Checa limite de paginação (máx. 2 páginas por lista)
      if (item.paginationListKey && item.paginationPage) {
        const visitedSet = listPagesVisited.get(item.paginationListKey) ?? new Set<string>();
        if (visitedSet.has(item.paginationPage)) {
          const existingPageOneState =
            urlToStateId.get(normalizedCandidateUrl) ??
            listFirstPageStateIds.get(item.paginationListKey);
          if (item.fromStateId && item.viaAction && existingPageOneState) {
            recordTransition(item.fromStateId, existingPageOneState, item.viaAction, item.url);
          }
          continue;
        }
        if (visitedSet.size >= maxPagesPerList) {
          skippedPaginationLimit += 1;
          ctx.log.debug(
            {
              listKey: item.paginationListKey,
              page: item.paginationPage,
              maxPagesPerList,
            },
            "limite de páginas por lista atingido; ignorando página adicional",
          );
          continue;
        }
      }

      // Se a URL normalizada já foi visitada, registra apenas a aresta de transição para o estado conhecido
      const alreadyKnownStateId = urlToStateId.get(normalizedCandidateUrl);
      if (alreadyKnownStateId !== undefined) {
        if (item.fromStateId && item.viaAction) {
          recordTransition(item.fromStateId, alreadyKnownStateId, item.viaAction, item.url);
        }
        continue;
      }

      // Aplica rate limit do ScopeGuard + backoff adicional se houve redução de RPS após 3x HTTP 429
      ctx.signal.throwIfAborted?.();
      await ctx.guard.throttle();
      if (currentRateLimitRps < initialRateLimitRps) {
        const extraDelayMs = Math.max(
          0,
          Math.ceil(1000 / currentRateLimitRps - 1000 / initialRateLimitRps),
        );
        if (extraDelayMs > 0) {
          await sleepFn(extraDelayMs);
        }
      }

      let response: PlaywrightResponse | null = null;
      try {
        response = await page.goto(item.url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeoutMs,
        });
      } catch (err) {
        if (ctx.signal.aborted) {
          throw err;
        }
        ctx.log.warn({ err, url: item.url }, "falha ao navegar para URL durante explore; pulando");
        continue;
      }

      // Espera networkidle (timeout 10s) + 500ms de estabilização (docs/04 Fase 2 passo 2.2)
      if (typeof page.waitForLoadState === "function") {
        await page
          .waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs })
          .catch(() => undefined);
      }
      if (stabilizationMs > 0) {
        await sleepFn(stabilizationMs);
      }

      const finalUrl = normalizeSeedUrl(page.url(), item.url) ?? item.url;
      if (!ctx.guard.canNavigate(finalUrl)) {
        skippedOutOfScope += 1;
        ctx.log.warn(
          { requestedUrl: item.url, finalUrl },
          "redirecionamento para URL fora do escopo permitido; descartando página",
        );
        continue;
      }

      const status = response?.status() ?? 200;
      const rawHeaders = response?.headers() ?? {};
      const sanitizedHeaders = sanitizeResponseHeaders(rawHeaders);
      const html = await extractVisiblePageHtml(page);

      // 1. Verifica desafios anti-bot / CAPTCHA (docs/10 §2)
      const challengeReason = detectExploreChallenge(status, sanitizedHeaders, html);
      if (challengeReason) {
        const { checkpoint, graph, path } = persistProgress();
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
            stateGraph: graph,
            stateGraphPath: path,
            checkpoint,
            stateEvidences,
            transitionEvidences,
            screenshotEvidences,
            domSnapshotEvidences,
            a11ySnapshotEvidences,
            formSchemaEvidences,
            formProbeEvidences,
          };
        }
        return {
          phaseResult: {
            status: "blocked",
            reason: challengeReason,
          },
          stateGraph: graph,
          stateGraphPath: path,
          checkpoint,
          stateEvidences,
          transitionEvidences,
          screenshotEvidences,
          domSnapshotEvidences,
          a11ySnapshotEvidences,
          formSchemaEvidences,
          formProbeEvidences,
        };
      }

      // 2. Tratamento de HTTP 429 (docs/10 §2 e Nota Arquitetural):
      // Respeitar Retry-After; após 3 ocorrências reduzir rateLimitRps pela metade; após 6, blocked.
      if (status === 429) {
        rateLimit429Count += 1;
        const retryAfterHeader = rawHeaders["retry-after"] ?? sanitizedHeaders["retry-after"];
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowFn()) ?? 1000;

        if (rateLimit429Count === 3) {
          currentRateLimitRps = Math.max(0.05, currentRateLimitRps / 2);
          ctx.emit({
            type: "rate_limit_halved",
            phase: "explore",
            data: {
              rateLimit429Count,
              newRateLimitRps: currentRateLimitRps,
            },
          });
        }

        if (rateLimit429Count >= 6) {
          const { checkpoint, graph, path } = persistProgress();
          return {
            phaseResult: {
              status: "blocked",
              reason: `Alvo retornou HTTP 429 repetidamente (${rateLimit429Count} ocorrências); exploração interrompida conforme política de segurança.`,
            },
            stateGraph: graph,
            stateGraphPath: path,
            checkpoint,
            stateEvidences,
            transitionEvidences,
            screenshotEvidences,
            domSnapshotEvidences,
            a11ySnapshotEvidences,
            formSchemaEvidences,
            formProbeEvidences,
          };
        }

        if (retryAfterMs > 0) {
          await sleepFn(retryAfterMs);
        }

        const retryAttempts = (item.retryCount429 ?? 0) + 1;
        if (retryAttempts <= 6) {
          enqueueItem({
            ...item,
            retryCount429: retryAttempts,
          });
        }
        continue;
      }

      // 3. Tratamento de HTTP 403 em navegação principal (docs/10 §2):
      if (status === 403 && (item.depth === 0 || pagesVisitedCount === 0)) {
        const { checkpoint, graph, path } = persistProgress();
        return {
          phaseResult: {
            status: "blocked",
            reason: `Acesso negado (HTTP 403) na navegação para "${finalUrl}".`,
          },
          stateGraph: graph,
          stateGraphPath: path,
          checkpoint,
          stateEvidences,
          transitionEvidences,
          screenshotEvidences,
          domSnapshotEvidences,
          a11ySnapshotEvidences,
          formSchemaEvidences,
          formProbeEvidences,
        };
      }

      pagesVisitedCount += 1;
      const normalizedFinalUrl = normalizeUrlForFingerprint(finalUrl);
      visitedNormalizedUrls.add(normalizedCandidateUrl);
      visitedNormalizedUrls.add(normalizedFinalUrl);

      if (item.paginationListKey && item.paginationPage) {
        const set = listPagesVisited.get(item.paginationListKey) ?? new Set<string>();
        set.add(item.paginationPage);
        listPagesVisited.set(item.paginationListKey, set);
      }

      // Calcula árvore interativa (sem texto) e fingerprint SHA-256
      const interactiveTree = extractInteractiveDomTreeFromHtml(html);
      const fingerprint = computeStateFingerprint(finalUrl, interactiveTree);
      const existingNode = nodesByFingerprint.get(fingerprint);

      if (existingNode) {
        urlToStateId.set(normalizedFinalUrl, existingNode.id);
        urlToStateId.set(normalizedCandidateUrl, existingNode.id);
        if (item.fromStateId && item.viaAction) {
          recordTransition(item.fromStateId, existingNode.id, item.viaAction, finalUrl);
        }
        persistProgress();
        continue;
      }

      // Novo estado descoberto!
      const stateId = deriveStateId(fingerprint);
      const rawTitle = typeof page.title === "function" ? await page.title() : "";
      const title = rawTitle.replace(/\s+/g, " ").slice(0, 200).trim();
      const candidateActions = extractCandidateActionsFromHtml(html, finalUrl, ctx.guard);
      const discoveredAt = new Date(nowFn()).toISOString();

      // 1. Multi-viewport Screenshots (F1-05)
      const stateScreenshotEvidenceIds: string[] = [];
      if (options?.captureScreenshots !== false && session.viewports.length > 0) {
        for (const vp of session.viewports) {
          try {
            await session.setViewport(vp, page);
            if (
              stabilizationMs > 0 &&
              typeof (page as unknown as { waitForTimeout?: (ms: number) => Promise<void> })
                .waitForTimeout === "function"
            ) {
              await (
                page as unknown as { waitForTimeout: (ms: number) => Promise<void> }
              ).waitForTimeout(Math.min(100, stabilizationMs));
            }
            if (typeof page.screenshot === "function") {
              const buffer = await page.screenshot({ type: "png" });
              const shotSha = computeSha256(buffer);
              const shotEvidence = ctx.evidence.put({
                jobId: ctx.job.id,
                kind: "screenshot",
                phase: "explore",
                sha256: shotSha,
                url: finalUrl,
                stateId,
                blob: buffer,
                summary: `Screenshot ${vp.width}x${vp.height} do estado ${stateId} em ${finalUrl}`,
                data: {
                  width: vp.width,
                  height: vp.height,
                  viewport: `${vp.width}x${vp.height}`,
                  stateId,
                  url: finalUrl,
                },
              });
              screenshotEvidences.push(shotEvidence);
              stateScreenshotEvidenceIds.push(shotEvidence.id);
              screenshotsCaptured += 1;
            }
          } catch (shotErr) {
            ctx.log?.warn?.(
              { err: shotErr, viewport: vp, stateId },
              "falha ao capturar screenshot do viewport",
            );
          }
        }
        // Restaura viewport desktop padrão da sessão
        try {
          await session.setViewport(session.defaultViewport, page);
        } catch {
          // ignore
        }
      }

      // 2. Snapshot DOM Reduzido (F1-05)
      let stateDomSnapshotEvidenceId: string | undefined;
      if (options?.captureDomSnapshot !== false) {
        try {
          const reducedHtml = reduceDomSnapshot(html);
          const domSha = computeSha256(reducedHtml);
          const domEvidence = ctx.evidence.put({
            jobId: ctx.job.id,
            kind: "dom_snapshot",
            phase: "explore",
            sha256: domSha,
            url: finalUrl,
            stateId,
            blob: reducedHtml,
            summary: `Snapshot DOM reduzido do estado ${stateId} em ${finalUrl} (${reducedHtml.length} bytes)`,
            data: {
              stateId,
              url: finalUrl,
              originalLength: html.length,
              reducedLength: reducedHtml.length,
            },
          });
          domSnapshotEvidences.push(domEvidence);
          stateDomSnapshotEvidenceId = domEvidence.id;
          domSnapshotsCaptured += 1;
        } catch (domErr) {
          ctx.log?.warn?.({ err: domErr, stateId }, "falha ao gerar snapshot DOM reduzido");
        }
      }

      // 3. Snapshot de Acessibilidade (F1-05)
      let stateA11ySnapshotEvidenceId: string | undefined;
      if (options?.captureA11ySnapshot !== false) {
        try {
          const a11yResult = await captureA11ySnapshot(page, html);
          const a11yPayload = {
            stateId,
            url: finalUrl,
            format: a11yResult.format,
            snapshot: a11yResult.snapshot,
          };
          const a11ySerialized = canonicalJson(a11yPayload);
          const a11ySha = computeSha256(a11ySerialized);
          const a11yEvidence = ctx.evidence.put({
            jobId: ctx.job.id,
            kind: "a11y_snapshot",
            phase: "explore",
            sha256: a11ySha,
            url: finalUrl,
            stateId,
            blob: a11ySerialized,
            summary: `Snapshot de acessibilidade (${a11yResult.format}) do estado ${stateId} em ${finalUrl}`,
            data: {
              stateId,
              url: finalUrl,
              format: a11yResult.format,
            },
          });
          a11ySnapshotEvidences.push(a11yEvidence);
          stateA11ySnapshotEvidenceId = a11yEvidence.id;
          a11ySnapshotsCaptured += 1;
        } catch (a11yErr) {
          ctx.log?.warn?.(
            { err: a11yErr, stateId },
            "falha ao capturar snapshot de acessibilidade",
          );
        }
      }

      const statePayload = {
        stateId,
        fingerprint,
        url: finalUrl,
        normalizedUrl: normalizedFinalUrl,
        title,
        depth: item.depth,
        status,
        interactiveElementCount: interactiveTree.length,
        actionsCount: candidateActions.length,
        actions: candidateActions.map((a) => ({
          kind: a.kind,
          selector: a.selector,
          label: a.label,
          priorityBucket: a.priorityBucket,
          ...(a.targetUrl ? { targetUrl: a.targetUrl } : {}),
        })),
        ...(stateScreenshotEvidenceIds.length > 0
          ? { screenshotEvidenceIds: stateScreenshotEvidenceIds }
          : {}),
        ...(stateDomSnapshotEvidenceId
          ? { domSnapshotEvidenceId: stateDomSnapshotEvidenceId }
          : {}),
        ...(stateA11ySnapshotEvidenceId
          ? { a11ySnapshotEvidenceId: stateA11ySnapshotEvidenceId }
          : {}),
      };

      const stateEvidence = ctx.evidence.put({
        jobId: ctx.job.id,
        kind: "state",
        phase: "explore",
        sha256: fingerprint,
        url: finalUrl,
        stateId,
        blob: canonicalJson({
          ...statePayload,
          interactiveTree,
        }),
        summary: `Estado ${stateId} em ${finalUrl} (depth=${item.depth}, ${candidateActions.length} ações)`,
        data: statePayload,
      });
      stateEvidences.push(stateEvidence);

      const newNode: StateGraphNode = {
        id: stateId,
        fingerprint,
        url: finalUrl,
        normalizedUrl: normalizedFinalUrl,
        title,
        depth: item.depth,
        status,
        interactiveTree,
        actions: candidateActions,
        discoveredAt,
        evidenceId: stateEvidence.id,
        ...(stateScreenshotEvidenceIds.length > 0
          ? { screenshotEvidenceIds: stateScreenshotEvidenceIds }
          : {}),
        ...(stateDomSnapshotEvidenceId
          ? { domSnapshotEvidenceId: stateDomSnapshotEvidenceId }
          : {}),
        ...(stateA11ySnapshotEvidenceId
          ? { a11ySnapshotEvidenceId: stateA11ySnapshotEvidenceId }
          : {}),
      };

      nodes.push(newNode);
      nodesByFingerprint.set(fingerprint, newNode);
      urlToStateId.set(normalizedFinalUrl, stateId);
      urlToStateId.set(normalizedCandidateUrl, stateId);

      if (item.fromStateId && item.viaAction) {
        recordTransition(item.fromStateId, stateId, item.viaAction, finalUrl);
      }

      if (options?.onNewState) {
        await options.onNewState({
          page,
          session,
          state: newNode,
          ctx,
        });
      }

      // Extração de schemas de formulários e probing validation-only (F1-06)
      const formsOnPage = extractFormSchemasFromHtml(html, finalUrl, stateId);
      for (const form of formsOnPage) {
        if (!discoveredFormIds.has(form.formId)) {
          discoveredFormIds.add(form.formId);
          const formRes = await probeForm({
            form,
            ctx,
            page,
            fetchFn: options?.fetch,
          });
          formSchemaEvidences.push(formRes.formSchemaEvidence);
          formProbeEvidences.push(...formRes.probeEvidences);
        }
      }

      // Se a página atual contém links de paginação para a própria lista base (sem ?page= na URL atual),
      // registra a página atual como a 1ª página ("page:1") dessa lista para respeitar o teto de 2 páginas por lista.
      const baseListKey = `${new URL(finalUrl).origin}${new URL(finalUrl).pathname}`;
      const hasSelfPagination = candidateActions.some(
        (a) => a.priorityBucket === "pagination" && a.paginationListKey === baseListKey,
      );
      if (hasSelfPagination && !item.paginationPage) {
        const set = listPagesVisited.get(baseListKey) ?? new Set<string>();
        set.add("page:1");
        listPagesVisited.set(baseListKey, set);
        if (!listFirstPageStateIds.has(baseListKey)) {
          listFirstPageStateIds.set(baseListKey, stateId);
        }
      }

      // Enfileira ações candidatas elegíveis (não destrutivas e dentro do escopo)
      for (const action of candidateActions) {
        if (action.kind === "destructive") {
          if (!ctx.manifest.limits.destructiveActions) {
            skippedDestructive += 1;
            continue;
          }
        }

        if (action.kind === "external" || action.kind === "submit-form") {
          continue;
        }

        if (!action.targetUrl) {
          continue;
        }

        if (!ctx.guard.canNavigate(action.targetUrl)) {
          skippedOutOfScope += 1;
          continue;
        }

        if (
          !ctx.manifest.limits.destructiveActions &&
          (ctx.guard.isDestructive(action.label) || ctx.guard.isDestructive(action.targetUrl))
        ) {
          skippedDestructive += 1;
          continue;
        }

        const nextDepth = item.depth + 1;
        if (nextDepth > maxDepth) {
          continue;
        }

        const targetNormalized = normalizeUrlForFingerprint(action.targetUrl);
        const existingTargetStateId = urlToStateId.get(targetNormalized);
        if (existingTargetStateId !== undefined) {
          recordTransition(
            stateId,
            existingTargetStateId,
            {
              kind: action.kind,
              selector: action.selector,
              label: action.label,
            },
            action.targetUrl,
          );
          continue;
        }

        enqueueItem({
          url: action.targetUrl,
          depth: nextDepth,
          priority: action.priority,
          fromStateId: stateId,
          viaAction: {
            kind: action.kind,
            selector: action.selector,
            label: action.label,
          },
          ...(action.paginationListKey ? { paginationListKey: action.paginationListKey } : {}),
          ...(action.paginationPage ? { paginationPage: action.paginationPage } : {}),
        });
      }

      persistProgress();
    }

    const { checkpoint, graph, path } = persistProgress();

    ctx.emit({
      type: "explore_completed",
      phase: "explore",
      data: {
        pagesVisited: graph.stats.pagesVisited,
        statesDiscovered: graph.stats.statesDiscovered,
        transitionsRecorded: graph.stats.transitionsRecorded,
        skippedOutOfScope: graph.stats.skippedOutOfScope,
        skippedDestructive: graph.stats.skippedDestructive,
        skippedPaginationLimit: graph.stats.skippedPaginationLimit,
        stateGraphPath: path,
      },
    });

    return {
      phaseResult: {
        status: "ok",
        stats: {
          pagesVisited: graph.stats.pagesVisited,
          statesDiscovered: graph.stats.statesDiscovered,
          transitionsRecorded: graph.stats.transitionsRecorded,
          formsDiscovered: formSchemaEvidences.length,
          formProbesCount: formProbeEvidences.length,
          skippedOutOfScope: graph.stats.skippedOutOfScope,
          skippedDestructive: graph.stats.skippedDestructive,
          skippedPaginationLimit: graph.stats.skippedPaginationLimit,
          maxDepthReached: graph.stats.maxDepthReached,
          rateLimit429Count: graph.stats.rateLimit429Count,
          screenshotsCaptured,
          domSnapshotsCaptured,
          a11ySnapshotsCaptured,
        },
      },
      stateGraph: graph,
      stateGraphPath: path,
      checkpoint,
      stateEvidences,
      transitionEvidences,
      screenshotEvidences,
      domSnapshotEvidences,
      a11ySnapshotEvidences,
      formSchemaEvidences,
      formProbeEvidences,
    };
  };

  if (options?.session) {
    return executeWithSession(options.session);
  }

  const useFetchAdapter =
    options?.fetch !== undefined &&
    options?.sessionOptions?.wsEndpoint === undefined &&
    options?.sessionOptions?.cdpConnector === undefined;

  const sessionOpts: BrowserSessionOptions = {
    ...options?.sessionOptions,
    jobId: ctx.job.id,
    manifest: ctx.manifest,
    log: ctx.log,
    ...(useFetchAdapter && options?.fetch
      ? {
          wsEndpoint: "ws://local-fetch-adapter:9222",
          cdpConnector: createFetchBackedCdpConnector(options.fetch),
        }
      : {}),
  };

  return BrowserSession.withSession(sessionOpts, executeWithSession);
}

export function createExplorePhase(options?: ExplorePhaseOptions): Phase {
  return {
    id: "explore",
    isEnabled(manifest): boolean {
      return (
        manifest.target.type !== "repo" &&
        Boolean(manifest.target.url) &&
        manifest.methods.behavioralUi === true
      );
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await runExplorePhase(ctx, options);
      return result.phaseResult;
    },
  };
}

export const explorePhase: Phase = createExplorePhase();
