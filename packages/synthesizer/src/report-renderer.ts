import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportSection } from "@cleanroom/core";

type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "var"; expr: string }
  | { kind: "each"; expr: string; body: TemplateNode[]; elseBody: TemplateNode[] }
  | { kind: "if"; expr: string; body: TemplateNode[]; elseBody: TemplateNode[] };

type TemplateToken =
  | { type: "text"; value: string }
  | { type: "openEach"; expr: string }
  | { type: "openIf"; expr: string }
  | { type: "else" }
  | { type: "closeEach" }
  | { type: "closeIf" }
  | { type: "var"; expr: string };

interface RenderFrame {
  value: unknown;
  index?: number;
  index1?: number;
}

const SECTION_HEADING_BY_KEY: Record<ReportSection, string> = {
  "executive-summary": "## 1. Sumário executivo",
  "product-vision": "## 2. Visão do produto",
  "functional-map": "## 3. Mapa funcional",
  "domain-model": "## 4. Modelo de domínio",
  "business-rules": "## 5. Catálogo de regras de negócio",
  "state-machines": "## 6. Máquinas de estado",
  "main-flows": "## 7. Fluxos principais",
  "api-contract": "## 8. Contrato de API inferido",
  "roles-permissions": "## 9. Papéis e permissões",
  "validations-messages": "## 10. Validações e mensagens",
  "external-integrations": "## 11. Integrações externas detectadas",
  "acceptance-criteria": "## 12. Critérios de aceite",
  "gaps-hypotheses": "## 13. Lacunas, hipóteses e contradições",
  appendix: "## Apêndice A: cobertura e metodologia",
};

const HEADING_TO_SECTION = new Map<string, ReportSection>(
  (Object.entries(SECTION_HEADING_BY_KEY) as Array<[ReportSection, string]>).map(([k, h]) => [
    h,
    k,
  ]),
);

/**
 * Localiza `docs/templates/report-template.md` tanto em execução de código-fonte (`src/`)
 * quanto após build (`dist/`).
 */
export function resolveReportTemplatePath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../docs/templates/report-template.md"),
    resolve(currentDir, "../../../../docs/templates/report-template.md"),
    resolve(process.cwd(), "docs/templates/report-template.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? resolve(currentDir, "../../../docs/templates/report-template.md");
}

export function loadReportTemplate(templatePath?: string | undefined): string {
  const target = templatePath ?? resolveReportTemplatePath();
  return readFileSync(target, "utf8");
}

function stripTemplateHeaderComment(template: string): string {
  return template.replace(/^\s*<!--[\s\S]*?Placeholders:[\s\S]*?-->\s*\r?\n?/i, "");
}

function tokenizeTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const tagRegex = /\{\{([\s\S]*?)\}\}/g;
  let lastIndex = 0;

  for (const match of template.matchAll(tagRegex)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push({ type: "text", value: template.slice(lastIndex, start) });
    }
    const rawTag = (match[1] ?? "").trim();
    if (rawTag.startsWith("#each ")) {
      tokens.push({ type: "openEach", expr: rawTag.slice(6).trim() });
    } else if (rawTag.startsWith("#if ")) {
      tokens.push({ type: "openIf", expr: rawTag.slice(4).trim() });
    } else if (rawTag === "else") {
      tokens.push({ type: "else" });
    } else if (rawTag === "/each") {
      tokens.push({ type: "closeEach" });
    } else if (rawTag === "/if") {
      tokens.push({ type: "closeIf" });
    } else {
      tokens.push({ type: "var", expr: rawTag });
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < template.length) {
    tokens.push({ type: "text", value: template.slice(lastIndex) });
  }

  // Remove quebras de linha de tags de bloco isoladas em uma linha (`{{#each}}`, `{{else}}`, `{{/each}}`, `{{#if}}`, `{{/if}}`)
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined || tok.type === "text" || tok.type === "var") {
      continue;
    }
    const prev = i > 0 ? tokens[i - 1] : undefined;
    const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
    const prevEndsAtLineStart =
      prev === undefined || (prev.type === "text" && /(?:^|\r?\n)[ \t]*$/.test(prev.value));
    const nextStartsWithNewline =
      next !== undefined && next.type === "text" && /^[ \t]*\r?\n/.test(next.value);

    if (prevEndsAtLineStart && nextStartsWithNewline) {
      if (prev !== undefined && prev.type === "text") {
        prev.value = prev.value.replace(/[ \t]+$/, "");
      }
      if (next !== undefined && next.type === "text") {
        next.value = next.value.replace(/^[ \t]*\r?\n/, "");
      }
    }
  }

  return tokens;
}

function parseTemplateAst(
  tokens: readonly TemplateToken[],
  posRef: { index: number },
  stopAt?: "closeEach" | "closeIf",
): { body: TemplateNode[]; elseBody: TemplateNode[] } {
  const body: TemplateNode[] = [];
  let elseBody: TemplateNode[] = [];
  let inElse = false;

  const pushNode = (node: TemplateNode): void => {
    if (inElse) {
      elseBody.push(node);
    } else {
      body.push(node);
    }
  };

  while (posRef.index < tokens.length) {
    const token = tokens[posRef.index];
    if (token === undefined) break;

    if (token.type === "else") {
      if (stopAt === undefined) {
        throw new Error("Tag {{else}} encontrada fora de bloco {{#each}} ou {{#if}}.");
      }
      posRef.index += 1;
      inElse = true;
      elseBody = [];
      continue;
    }

    if (token.type === "closeEach" || token.type === "closeIf") {
      if (token.type !== stopAt) {
        throw new Error(`Tag de fechamento inesperada: ${token.type}`);
      }
      posRef.index += 1;
      return { body, elseBody };
    }

    posRef.index += 1;
    if (token.type === "text") {
      if (token.value.length > 0) {
        pushNode({ kind: "text", value: token.value });
      }
    } else if (token.type === "var") {
      pushNode({ kind: "var", expr: token.expr });
    } else if (token.type === "openEach") {
      const inner = parseTemplateAst(tokens, posRef, "closeEach");
      pushNode({ kind: "each", expr: token.expr, body: inner.body, elseBody: inner.elseBody });
    } else if (token.type === "openIf") {
      const inner = parseTemplateAst(tokens, posRef, "closeIf");
      pushNode({ kind: "if", expr: token.expr, body: inner.body, elseBody: inner.elseBody });
    }
  }

  if (stopAt !== undefined) {
    throw new Error(`Bloco de template não fechado (esperado ${stopAt}).`);
  }
  return { body, elseBody };
}

function lookupInValue(base: unknown, parts: readonly string[]): unknown {
  let current: unknown = base;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveExpression(expr: string, stack: readonly RenderFrame[]): unknown {
  const trimmed = expr.trim();
  const top = stack[stack.length - 1];
  if (trimmed === "@index") {
    return top?.index;
  }
  if (trimmed === "@index1") {
    return top?.index1;
  }
  if (trimmed === "this" || trimmed === ".") {
    return top?.value;
  }
  if (trimmed.startsWith("this.")) {
    return lookupInValue(top?.value, trimmed.slice(5).split("."));
  }

  const parts = trimmed.split(".");
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame === undefined || frame.value === null || typeof frame.value !== "object") {
      continue;
    }
    const found = lookupInValue(frame.value, parts);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "number") {
    return value !== 0 && !Number.isNaN(value);
  }
  return true;
}

function formatScalarValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "sim" : "não";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatScalarValue(item))
      .filter((s) => s.length > 0)
      .join(", ");
  }
  return JSON.stringify(value);
}

function renderNodes(nodes: readonly TemplateNode[], stack: RenderFrame[], out: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      out.push(node.value);
      continue;
    }
    if (node.kind === "var") {
      const val = resolveExpression(node.expr, stack);
      const formatted = formatScalarValue(val);
      const currentOut = out.join("");
      const lastNewlineIdx = currentOut.lastIndexOf("\n");
      const currentLinePrefix =
        lastNewlineIdx === -1 ? currentOut : currentOut.slice(lastNewlineIdx + 1);
      const inTableRow = /^\s*\|/.test(currentLinePrefix);
      if (inTableRow) {
        const sanitizedCell = formatted.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
        out.push(sanitizedCell.length > 0 ? sanitizedCell : "-");
      } else {
        out.push(formatted);
      }
      continue;
    }
    if (node.kind === "if") {
      const val = resolveExpression(node.expr, stack);
      renderNodes(isTruthy(val) ? node.body : node.elseBody, stack, out);
      continue;
    }
    if (node.kind === "each") {
      const list = resolveExpression(node.expr, stack);
      if (!Array.isArray(list) || list.length === 0) {
        renderNodes(node.elseBody, stack, out);
        continue;
      }
      for (let i = 0; i < list.length; i += 1) {
        stack.push({ value: list[i], index: i, index1: i + 1 });
        renderNodes(node.body, stack, out);
        stack.pop();
      }
    }
  }
}

/**
 * Remove seções `## ...` que não constam em `manifest.report.include` (preservando o cabeçalho).
 */
export function filterReportMarkdownSections(
  markdown: string,
  includedSections: readonly ReportSection[],
): string {
  const allowed = new Set<ReportSection>(includedSections);
  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  let skipCurrentSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const matchedSection = HEADING_TO_SECTION.get(trimmed);
    if (matchedSection !== undefined) {
      skipCurrentSection = !allowed.has(matchedSection);
    }
    if (!skipCurrentSection) {
      result.push(line);
    }
  }

  return `${result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/**
 * Renderiza `docs/templates/report-template.md` com dados estruturados do relatório.
 */
export function renderReportTemplate(
  template: string,
  data: Record<string, unknown>,
  options?: { includedSections?: readonly ReportSection[] | undefined },
): string {
  const cleanedTemplate = stripTemplateHeaderComment(template);
  const tokens = tokenizeTemplate(cleanedTemplate);
  const ast = parseTemplateAst(tokens, { index: 0 });
  const out: string[] = [];
  renderNodes(ast.body, [{ value: data }], out);
  const rendered = `${out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;

  if (options?.includedSections !== undefined) {
    return filterReportMarkdownSections(rendered, options.includedSections);
  }
  return rendered;
}
