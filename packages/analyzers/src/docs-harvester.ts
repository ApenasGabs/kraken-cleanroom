import {
  type Evidence,
  MethodNotAllowedError,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
  canonicalJson,
} from "@cleanroom/core";

export const DEFAULT_DOC_PATHS = ["/help", "/docs", "/pricing", "/terms", "/changelog"] as const;

export type BillingPeriod = "month" | "year" | "one-time" | "unknown";

export interface DocSectionData extends Record<string, unknown> {
  url: string;
  pageTitle: string;
  heading: string;
  level: number;
  sectionId?: string;
  sectionIndex: number;
  wordCount: number;
  charCount: number;
  bulletCount: number;
  codeTerms: string[];
  highlights: string[];
}

export interface PricingPlanData extends Record<string, unknown> {
  url: string;
  planId: string;
  name: string;
  displayName: string;
  price: string;
  priceAmount: number | null;
  currency: string | null;
  billingPeriod: BillingPeriod;
  projectLimit: number | "unlimited" | null;
  unlimitedProjects: boolean;
  limits: string[];
  features: string[];
  tableAttributes: Record<string, string>;
}

export interface ExtractedDocSection {
  heading: string;
  level: number;
  sectionId?: string;
  sectionIndex: number;
  pageTitle: string;
  markdown: string;
  wordCount: number;
  charCount: number;
  bulletCount: number;
  codeTerms: string[];
  highlights: string[];
}

export interface DocsHarvesterCheckpoint {
  completedUrls: string[];
}

export interface DocsHarvesterOptions {
  fetch?: typeof globalThis.fetch | undefined;
  discoveredUrls?: readonly string[] | undefined;
  includeDefaultPaths?: boolean | undefined;
  phaseId?: PhaseId | undefined;
  throwOnMethodDisabled?: boolean | undefined;
}

export interface DocsHarvesterStats extends Record<string, number> {
  skipped: number;
  pagesVisited: number;
  urlsSkipped: number;
  docSections: number;
  pricingPlans: number;
}

export interface DocsHarvesterResult {
  skipped: boolean;
  visitedUrls: string[];
  skippedUrls: string[];
  docSections: Evidence[];
  pricingPlans: Evidence[];
  stats: DocsHarvesterStats;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rarr: "→",
  larr: "←",
};

const PRICE_TEXT_REGEX =
  /(?:R\$|US\$|\$|€|£)\s*\d+(?:[.,]\d{1,2})?(?:\s*\/\s*[a-zA-ZÀ-ÿ]+)?|\b(?:gr[aá]tis|gratuito|free)\b/i;

const LIMIT_TEXT_REGEX =
  /\b(?:limite|limit|at[eé]|up\s+to|ilimitad[oa]s?|unlimited|m[aá]ximo|max|usu[aá]rios?|users?|membros?|members?|projetos?|projects?|cota|quota)\b/i;

const PRICING_PATH_REGEX = /(?:^|\/)(?:pricing|planos|plans|precos|preços)(?:\/|$)/i;

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    const mapped = NAMED_ENTITIES[entity.toLowerCase()];
    return mapped ?? full;
  });
}

function stripTagsToText(html: string): string {
  const withoutTags = html.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function stripNoiseElements(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

export function extractMainContent(html: string): { pageTitle: string; mainHtml: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const rawDocTitle = titleMatch?.[1] ? stripTagsToText(titleMatch[1]) : "";
  const cleanedDocTitle = rawDocTitle.split(/\s+[—–|-]\s+/)[0]?.trim() ?? rawDocTitle;

  const stripped = stripNoiseElements(html);
  const mainMatch = stripped.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const bodyMatch = stripped.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const mainHtml = (mainMatch?.[1] ?? bodyMatch?.[1] ?? stripped).trim();

  const h1Match = mainHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Title = h1Match?.[1] ? stripTagsToText(h1Match[1]) : "";
  const pageTitle = h1Title || cleanedDocTitle || "Documentação";

  return { pageTitle, mainHtml };
}

function convertTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  const rowMatches = tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const rowInner = rowMatch[1] ?? "";
    const cells: string[] = [];
    const cellMatches = rowInner.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi);
    for (const cellMatch of cellMatches) {
      cells.push(stripTagsToText(cellMatch[2] ?? ""));
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  if (rows.length === 0) {
    return "";
  }
  const header = rows[0] ?? [];
  const divider = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

export function htmlToMarkdown(html: string): string {
  let out = stripNoiseElements(html);

  out = out.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => convertTableToMarkdown(table));

  out = out.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return `\n\n\`\`\`\n${decodeHtmlEntities(String(code)).trim()}\n\`\`\`\n\n`;
  });

  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    const text = stripTagsToText(String(code));
    return text ? `\`${text}\`` : "";
  });

  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
    const text = stripTagsToText(String(inner));
    return text ? `**${text}**` : "";
  });

  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
    const text = stripTagsToText(String(inner));
    return text ? `*${text}*` : "";
  });

  out = out.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const text = stripTagsToText(inner);
      return text ? `[${text}](${href.trim()})` : "";
    },
  );

  out = out.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, levelStr: string, inner: string) => {
      const level = Number.parseInt(levelStr, 10);
      const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
      const text = stripTagsToText(inner);
      return text ? `\n\n${hashes} ${text}\n\n` : "";
    },
  );

  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
    const cleaned = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const decoded = decodeHtmlEntities(cleaned);
    return decoded ? `\n- ${decoded}` : "";
  });

  out = out.replace(/<\/(p|div|section|article|ul|ol|dl|blockquote)>/gi, "\n\n");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(out)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePlanSlug(rawName: string): string {
  return rawName
    .toLowerCase()
    .replace(/^(?:plano|plan|tier)\s+/i, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeCanonicalPlanName(rawName: string): string {
  const stripped = rawName.replace(/^(?:plano|plan|tier)\s+/i, "").trim();
  if (!stripped) {
    return rawName.trim();
  }
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function parsePriceDetails(priceText: string): {
  priceAmount: number | null;
  currency: string | null;
  billingPeriod: BillingPeriod;
} {
  const normalized = priceText.trim();
  let currency: string | null = null;
  if (/R\$/i.test(normalized)) {
    currency = "BRL";
  } else if (/US\$|\$/.test(normalized)) {
    currency = "USD";
  } else if (/€/.test(normalized)) {
    currency = "EUR";
  } else if (/£/.test(normalized)) {
    currency = "GBP";
  }

  let priceAmount: number | null = null;
  const amountMatch = normalized.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (amountMatch?.[1] !== undefined) {
    priceAmount = Number.parseFloat(amountMatch[1].replace(",", "."));
  } else if (/\b(?:gr[aá]tis|gratuito|free)\b/i.test(normalized)) {
    priceAmount = 0;
  }

  let billingPeriod: BillingPeriod = "unknown";
  if (/(?:\/\s*m[eê]s|\bmensal\b|\/\s*mo(?:nth)?\b|\bmonthly\b)/i.test(normalized)) {
    billingPeriod = "month";
  } else if (/(?:\/\s*ano|\banual\b|\/\s*yr\b|\/\s*year\b|\byearly\b)/i.test(normalized)) {
    billingPeriod = "year";
  }

  return { priceAmount, currency, billingPeriod };
}

function parseProjectLimit(texts: readonly string[]): {
  projectLimit: number | "unlimited" | null;
  unlimitedProjects: boolean;
} {
  for (const text of texts) {
    if (
      /\b(?:projetos?\s+ilimitados?|ilimitados?\s+projetos?|sem\s+limites?\s+de\s+projetos?|^ilimitado$|^unlimited$)\b/i.test(
        text.trim(),
      )
    ) {
      return { projectLimit: "unlimited", unlimitedProjects: true };
    }
    const numericMatch = text.match(
      /\b(?:at[eé]|up\s+to|m[aá]x(?:imo)?(?:\s+de)?|limite\s*:?\s*(?:at[eé]\s*)?)?\s*(\d+)\s+(?:projetos?|projects?)\b/i,
    );
    if (numericMatch?.[1] !== undefined) {
      const value = Number.parseInt(numericMatch[1], 10);
      if (!Number.isNaN(value)) {
        return { projectLimit: value, unlimitedProjects: false };
      }
    }
  }
  return { projectLimit: null, unlimitedProjects: false };
}

export function extractPricingPlans(html: string, pageUrl: string): PricingPlanData[] {
  const { mainHtml } = extractMainContent(html);
  const plansById = new Map<string, PricingPlanData>();

  const ensurePlan = (rawId: string, rawHeading: string): PricingPlanData => {
    const planId = normalizePlanSlug(rawId || rawHeading) || `plan-${plansById.size + 1}`;
    const existing = plansById.get(planId);
    if (existing !== undefined) {
      return existing;
    }
    const displayName = rawHeading.trim() || normalizeCanonicalPlanName(planId);
    const name = normalizeCanonicalPlanName(displayName);
    const created: PricingPlanData = {
      url: pageUrl,
      planId,
      name,
      displayName,
      price: "",
      priceAmount: null,
      currency: null,
      billingPeriod: "unknown",
      projectLimit: null,
      unlimitedProjects: false,
      limits: [],
      features: [],
      tableAttributes: {},
    };
    plansById.set(planId, created);
    return created;
  };

  // 1. Extract from explicit [data-plan] elements or pricing cards on pricing pages
  const dataPlanBlocks = [
    ...mainHtml.matchAll(
      /<(article|div|section)\b[^>]*\bdata-plan=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi,
    ),
  ];

  const cardBlocks: Array<{ explicitPlanId?: string; innerHtml: string }> = dataPlanBlocks.map(
    (m) => ({
      explicitPlanId: m[2] ?? "",
      innerHtml: m[3] ?? "",
    }),
  );

  if (cardBlocks.length === 0 && PRICING_PATH_REGEX.test(pageUrl)) {
    const genericCards = mainHtml.matchAll(
      /<(article|div)\b[^>]*\bclass=["'][^"']*\bcard\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
    );
    for (const match of genericCards) {
      const inner = match[2] ?? "";
      if (/<h[23]\b/i.test(inner) && PRICE_TEXT_REGEX.test(stripTagsToText(inner))) {
        cardBlocks.push({ innerHtml: inner });
      }
    }
  }

  for (const card of cardBlocks) {
    const headingMatch = card.innerHtml.match(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i);
    const headingText = headingMatch?.[1] ? stripTagsToText(headingMatch[1]) : "";
    const planIdSeed = card.explicitPlanId || headingText;
    if (!planIdSeed) {
      continue;
    }
    const plan = ensurePlan(planIdSeed, headingText || planIdSeed);

    const paragraphs = [...card.innerHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
      stripTagsToText(m[1] ?? ""),
    );
    const priceParagraph = paragraphs.find((p) => PRICE_TEXT_REGEX.test(p));
    if (priceParagraph) {
      plan.price = priceParagraph;
    }

    const listItems = [...card.innerHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => stripTagsToText(m[1] ?? ""))
      .filter((item) => item.length > 0);

    for (const item of listItems) {
      if (!plan.features.includes(item)) {
        plan.features.push(item);
      }
      if (LIMIT_TEXT_REGEX.test(item) && !plan.limits.includes(item)) {
        plan.limits.push(item);
      }
    }
  }

  // 2. Extract from comparison tables
  const tableMatches = mainHtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi);
  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[1] ?? "";
    const trMatches = [...tableHtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
    if (trMatches.length < 2) {
      continue;
    }

    const headerCells = [
      ...(trMatches[0]?.[2] ?? "").matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi),
    ].map((m) => stripTagsToText(m[2] ?? ""));

    const isPricingTable =
      PRICING_PATH_REGEX.test(pageUrl) ||
      headerCells.some((h) => /\b(?:plano|plan|pre[cç]o|price|mensal|limite|limit)\b/i.test(h));
    if (!isPricingTable || headerCells.length === 0) {
      continue;
    }

    for (const rowMatch of trMatches.slice(1)) {
      const trAttrs = rowMatch[1] ?? "";
      const trInner = rowMatch[2] ?? "";
      const cells = [...trInner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        stripTagsToText(m[1] ?? ""),
      );
      if (cells.length === 0) {
        continue;
      }

      const rowPlanAttr = trAttrs.match(/\bdata-plan(?:-row)?=["']([^"']+)["']/i)?.[1];
      const firstCell = cells[0] ?? "";
      const planKey = rowPlanAttr || firstCell;
      if (!planKey) {
        continue;
      }

      const plan = ensurePlan(planKey, firstCell || planKey);

      for (let i = 0; i < cells.length; i += 1) {
        const colName = headerCells[i] ?? `col_${i + 1}`;
        const cellValue = cells[i] ?? "";
        if (!cellValue) {
          continue;
        }
        plan.tableAttributes[colName] = cellValue;

        if (/\b(?:pre[cç]o|price|mensal|valor)\b/i.test(colName)) {
          if (!plan.price) {
            plan.price = cellValue;
          }
          if (/mensal|month/i.test(colName) && plan.billingPeriod === "unknown") {
            plan.billingPeriod = "month";
          }
        } else if (/\b(?:limite|limit|projetos|projects|cota|quota)\b/i.test(colName)) {
          if (!plan.limits.includes(cellValue)) {
            plan.limits.push(cellValue);
          }
        } else if (i > 0) {
          const formatted = `${colName}: ${cellValue}`;
          if (!plan.features.includes(formatted)) {
            plan.features.push(formatted);
          }
        }
      }
    }
  }

  // 3. Finalize parsed price and projectLimit for each plan
  const results: PricingPlanData[] = [];
  for (const plan of plansById.values()) {
    const priceInfo = parsePriceDetails(plan.price);
    plan.priceAmount = priceInfo.priceAmount;
    plan.currency = priceInfo.currency;
    if (priceInfo.billingPeriod !== "unknown") {
      plan.billingPeriod = priceInfo.billingPeriod;
    }

    const candidateLimitTexts = [
      ...plan.limits,
      ...Object.entries(plan.tableAttributes)
        .filter(([k]) => /\b(?:limite|limit|projeto|project)\b/i.test(k))
        .map(([, v]) => v),
      ...plan.features,
    ];
    const limitInfo = parseProjectLimit(candidateLimitTexts);
    plan.projectLimit = limitInfo.projectLimit;
    plan.unlimitedProjects = limitInfo.unlimitedProjects;

    results.push(plan);
  }

  return results;
}

function extractCodeTerms(htmlFragment: string): string[] {
  const terms: string[] = [];
  for (const match of htmlFragment.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
    const term = stripTagsToText(match[1] ?? "");
    if (term.length > 0 && term.length <= 80 && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
}

function extractShortHighlights(htmlFragment: string): string[] {
  const highlights: string[] = [];
  for (const match of htmlFragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const liHtml = match[1] ?? "";
    const strongMatch = liHtml.match(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/i);
    const rawLabel = strongMatch?.[2]
      ? stripTagsToText(strongMatch[2]).replace(/:$/, "")
      : stripTagsToText(liHtml).split(/\s+/).slice(0, 8).join(" ");
    const cleaned = rawLabel.slice(0, 80).trim();
    if (cleaned.length > 0 && !highlights.includes(cleaned)) {
      highlights.push(cleaned);
    }
  }
  return highlights;
}

function countWords(text: string): number {
  const stripped = text.replace(/[#*`_\-[\]()|]/g, " ").trim();
  if (!stripped) {
    return 0;
  }
  return stripped.split(/\s+/).length;
}

export function extractDocSections(
  html: string,
  _pageUrl: string,
  options?: { hasPricingPlans?: boolean | undefined },
): ExtractedDocSection[] {
  const { pageTitle, mainHtml } = extractMainContent(html);
  const hasPricingPlans = options?.hasPricingPlans ?? false;

  let contentHtml = mainHtml;
  if (hasPricingPlans) {
    contentHtml = contentHtml
      .replace(/<(article|div|section)\b[^>]*\bdata-plan=["'][^"']+["'][^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, "");
  }

  // Determine segmentation level: prefer h2 (when present), then h3, then h1 (only when not a pricing-only page)
  const hasH2 = /<h2\b[^>]*>/i.test(contentHtml);
  const hasH3 = /<h3\b[^>]*>/i.test(contentHtml);
  const targetLevel = hasH2 ? 2 : hasH3 ? 3 : hasPricingPlans ? null : 1;
  if (targetLevel === null) {
    return [];
  }

  const headingRegex = new RegExp(
    `<h${targetLevel}\\b([^>]*)>([\\s\\S]*?)<\\/h${targetLevel}>`,
    "gi",
  );
  const matches = [...contentHtml.matchAll(headingRegex)];
  if (matches.length === 0) {
    return [];
  }

  const sections: ExtractedDocSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    if (current === undefined || current.index === undefined) {
      continue;
    }
    const next = matches[i + 1];
    const startIdx = current.index;
    const endIdx = next?.index ?? contentHtml.length;
    const rawSlice = contentHtml.slice(startIdx, endIdx);

    const headingAttrs = current[1] ?? "";
    const headingText = stripTagsToText(current[2] ?? "");
    if (!headingText) {
      continue;
    }

    // Check if there is an enclosing <section id="..."> just before startIdx
    const precedingSlice = contentHtml.slice(Math.max(0, startIdx - 220), startIdx);
    const parentSectionIds = [
      ...precedingSlice.matchAll(/<section\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi),
    ];
    const parentSectionId = parentSectionIds.at(-1)?.[1];
    const headingId = headingAttrs.match(/\bid=["']([^"']+)["']/i)?.[1];
    const sectionId = headingId ?? parentSectionId;

    const markdown = htmlToMarkdown(rawSlice);
    const bulletCount = [...rawSlice.matchAll(/<li\b[^>]*>/gi)].length;
    const codeTerms = extractCodeTerms(rawSlice);
    const highlights = extractShortHighlights(rawSlice);
    const wordCount = countWords(markdown);
    const charCount = markdown.length;

    const section: ExtractedDocSection = {
      heading: headingText,
      level: targetLevel,
      sectionIndex: sections.length,
      pageTitle,
      markdown,
      wordCount,
      charCount,
      bulletCount,
      codeTerms,
      highlights,
    };
    if (sectionId !== undefined) {
      section.sectionId = sectionId;
    }
    sections.push(section);
  }

  return sections;
}

function normalizeCandidateUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isKnownDocPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return DEFAULT_DOC_PATHS.some(
    (docPath) => normalized === docPath || normalized.startsWith(`${docPath}/`),
  );
}

export function discoverDocCandidateUrls(
  ctx: Pick<PhaseContext, "manifest" | "evidence" | "job">,
  options?: Pick<DocsHarvesterOptions, "discoveredUrls" | "includeDefaultPaths">,
): string[] {
  const baseUrl = ctx.manifest.target.url;
  const includeDefaults = options?.includeDefaultPaths ?? true;
  const seen = new Set<string>();
  const ordered: string[] = [];

  const addCandidate = (raw: string) => {
    const normalized = normalizeCandidateUrl(raw, baseUrl);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      ordered.push(normalized);
    }
  };

  for (const docUrl of ctx.manifest.target.docsUrls) {
    addCandidate(docUrl);
  }

  if (options?.discoveredUrls !== undefined) {
    for (const url of options.discoveredUrls) {
      addCandidate(url);
    }
  }

  // Inspect existing evidences from intake/explore for discovered doc URLs
  const existingEvidences = ctx.evidence.list(ctx.job.id, { limit: 500 }).items;
  for (const ev of existingEvidences) {
    if (ev.url) {
      try {
        const parsed = new URL(ev.url);
        if (isKnownDocPath(parsed.pathname)) {
          addCandidate(ev.url);
        }
      } catch {
        // ignore invalid url
      }
    }
    const sitemapUrls = ev.data.sitemapUrls;
    if (Array.isArray(sitemapUrls)) {
      for (const item of sitemapUrls) {
        if (typeof item === "string") {
          try {
            const parsed = new URL(item, baseUrl);
            if (isKnownDocPath(parsed.pathname)) {
              addCandidate(parsed.toString());
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  if (includeDefaults && baseUrl) {
    for (const defaultPath of DEFAULT_DOC_PATHS) {
      addCandidate(defaultPath);
    }
  }

  return ordered;
}

function parseCheckpoint(raw: unknown): Set<string> {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "completedUrls" in raw &&
    Array.isArray((raw as { completedUrls: unknown }).completedUrls)
  ) {
    const urls = (raw as { completedUrls: unknown[] }).completedUrls.filter(
      (u): u is string => typeof u === "string",
    );
    return new Set(urls);
  }
  return new Set();
}

export async function docsHarvester(
  ctx: PhaseContext,
  options?: DocsHarvesterOptions,
): Promise<DocsHarvesterResult> {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  const fetchFn = options?.fetch ?? globalThis.fetch;

  try {
    ctx.guard.assertMethod("publicDocs");
  } catch (err) {
    if (err instanceof MethodNotAllowedError && options?.throwOnMethodDisabled !== true) {
      ctx.log.info(
        { method: "publicDocs" },
        "publicDocs desabilitado no manifesto; pulando docsHarvester",
      );
      ctx.emit({
        type: "docs_harvester_skipped",
        phase: phaseId,
        data: { reason: "method_public_docs_disabled" },
      });
      return {
        skipped: true,
        visitedUrls: [],
        skippedUrls: [],
        docSections: [],
        pricingPlans: [],
        stats: {
          skipped: 1,
          pagesVisited: 0,
          urlsSkipped: 0,
          docSections: 0,
          pricingPlans: 0,
        },
      };
    }
    throw err;
  }

  const candidates = discoverDocCandidateUrls(ctx, options);
  const completedUrls = parseCheckpoint(ctx.checkpoint);
  const visitedUrls: string[] = [];
  const skippedUrls: string[] = [];
  const docSections: Evidence[] = [];
  const pricingPlans: Evidence[] = [];

  for (const url of candidates) {
    if (ctx.signal.aborted) {
      break;
    }

    if (completedUrls.has(url)) {
      continue;
    }

    if (!ctx.guard.canNavigate(url)) {
      skippedUrls.push(url);
      ctx.log.debug({ url }, "URL de documentação ignorada pelo ScopeGuard");
      continue;
    }

    await ctx.guard.throttle();

    if (ctx.signal.aborted) {
      break;
    }

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.8",
        },
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        break;
      }
      skippedUrls.push(url);
      ctx.log.warn({ url, err }, "Falha ao baixar URL de documentação");
      continue;
    }

    if (!response.ok) {
      skippedUrls.push(url);
      ctx.log.debug(
        { url, status: response.status },
        "URL de documentação retornou status não-2xx",
      );
      completedUrls.add(url);
      ctx.saveCheckpoint({ completedUrls: [...completedUrls] } satisfies DocsHarvesterCheckpoint);
      continue;
    }

    const html = await response.text();
    visitedUrls.push(url);
    const pathname = new URL(url).pathname;

    // 1. Extract pricing plans (if any)
    const extractedPlans = extractPricingPlans(html, url);
    for (const plan of extractedPlans) {
      const limitDesc =
        plan.projectLimit === "unlimited"
          ? "projetos ilimitados"
          : typeof plan.projectLimit === "number"
            ? `até ${plan.projectLimit} projetos`
            : (plan.limits[0] ?? "sem limite explícito");

      const summary = `${plan.displayName}: ${plan.price || "preço não informado"} (${limitDesc})`;
      const evidence = ctx.evidence.put({
        jobId: ctx.job.id,
        kind: "pricing_plan",
        phase: phaseId,
        url,
        blob: canonicalJson(plan),
        summary,
        data: plan,
      });
      pricingPlans.push(evidence);
    }

    // 2. Extract documentation sections segmented by heading
    const sections = extractDocSections(html, url, {
      hasPricingPlans: extractedPlans.length > 0,
    });

    for (const section of sections) {
      const sectionData: DocSectionData = {
        url,
        pageTitle: section.pageTitle,
        heading: section.heading,
        level: section.level,
        sectionIndex: section.sectionIndex,
        wordCount: section.wordCount,
        charCount: section.charCount,
        bulletCount: section.bulletCount,
        codeTerms: section.codeTerms,
        highlights: section.highlights,
      };
      if (section.sectionId !== undefined) {
        sectionData.sectionId = section.sectionId;
      }

      const summary = `Seção de doc [${pathname}] "${section.heading}" (${section.wordCount} palavras, ${section.bulletCount} itens)`;
      const evidence = ctx.evidence.put({
        jobId: ctx.job.id,
        kind: "doc_section",
        phase: phaseId,
        url,
        blob: section.markdown,
        summary,
        data: sectionData,
      });
      docSections.push(evidence);
    }

    completedUrls.add(url);
    ctx.saveCheckpoint({ completedUrls: [...completedUrls] } satisfies DocsHarvesterCheckpoint);
  }

  const stats: DocsHarvesterStats = {
    skipped: 0,
    pagesVisited: visitedUrls.length,
    urlsSkipped: skippedUrls.length,
    docSections: docSections.length,
    pricingPlans: pricingPlans.length,
  };

  ctx.emit({
    type: "docs_harvester_completed",
    phase: phaseId,
    data: stats,
  });

  return {
    skipped: false,
    visitedUrls,
    skippedUrls,
    docSections,
    pricingPlans,
    stats,
  };
}

export const runDocsHarvester = docsHarvester;

export function createDocsHarvesterPhase(options?: DocsHarvesterOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  return {
    id: phaseId,
    isEnabled(manifest) {
      return manifest.methods.publicDocs === true;
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await docsHarvester(ctx, options);
      return {
        status: "ok",
        stats: result.stats,
      };
    },
  };
}
