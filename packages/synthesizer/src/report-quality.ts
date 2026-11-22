import { existsSync, statSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import type {
  BusinessRule,
  Evidence,
  EvidenceKind,
  EvidenceStore,
  ReportIndexDocument,
  ReportQualityCheckResult,
  ReportQualityIssue,
} from "@cleanroom/core";
import { validateMarkdownMermaidBlocks, validateMermaidSyntax } from "./report-mermaid.js";

export const DEFAULT_ANTI_COPY_MIN_CHARS = 120;
export const ANTI_COPY_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "bundle_string",
  "dom_snapshot",
  "doc_section",
] as const;

const ANCHOR_CHUNK_SIZE = 60;
const MIN_ALNUM_CHARS_FOR_COPY = 20;

export interface AntiCopyCorpusEntry {
  evidenceId: string;
  kind: EvidenceKind;
  text: string;
}

export interface VerifyReportQualityInput {
  reportMarkdown: string;
  reportIndex: Pick<
    ReportIndexDocument,
    "rules" | "domain" | "stateMachines" | "flows" | "modules"
  >;
  assetsDir: string;
  corpusEntries: readonly AntiCopyCorpusEntry[];
  validEvidenceIds?: ReadonlySet<string> | undefined;
  minCopyChars?: number | undefined;
}

function collectLongStringsFromUnknown(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length >= ANCHOR_CHUNK_SIZE) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLongStringsFromUnknown(item, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const val of Object.values(value as Record<string, unknown>)) {
      collectLongStringsFromUnknown(val, out);
    }
  }
}

/**
 * Coleta textos de blobs e payloads de `bundle_string`, `dom_snapshot` e `doc_section`
 * para a verificação anti-cópia de `docs/05` §7.
 */
export function collectAntiCopyCorpus(
  evidenceStore: EvidenceStore,
  jobId: string,
  evidences?: readonly Evidence[],
): AntiCopyCorpusEntry[] {
  const sourceEvidences = evidences ?? evidenceStore.listAll(jobId);
  const kindSet = new Set<EvidenceKind>(ANTI_COPY_EVIDENCE_KINDS);
  const entries: AntiCopyCorpusEntry[] = [];

  for (const ev of sourceEvidences) {
    if (!kindSet.has(ev.kind)) {
      continue;
    }

    const parts: string[] = [];
    if (ev.blobPath !== undefined) {
      const blob = evidenceStore.readBlob(jobId, ev.id);
      if (blob !== null) {
        parts.push(blob.toString("utf8"));
      }
    }
    collectLongStringsFromUnknown(ev.data, parts);

    const combined = parts.join("\n").trim();
    if (combined.length >= ANCHOR_CHUNK_SIZE) {
      entries.push({
        evidenceId: ev.id,
        kind: ev.kind,
        text: combined,
      });
    }
  }

  return entries;
}

function countAlnumChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code >= 192
    ) {
      count += 1;
    }
  }
  return count;
}

function findLongestConsecutiveMatch(
  reportText: string,
  sourceText: string,
  minChars: number,
): { length: number; snippet: string } | null {
  if (reportText.length < minChars || sourceText.length < minChars) {
    return null;
  }

  const chunkSize = Math.min(ANCHOR_CHUNK_SIZE, Math.floor(minChars / 2));
  if (chunkSize < 12) {
    return null;
  }

  for (let offset = 0; offset + chunkSize <= reportText.length; offset += chunkSize) {
    const anchor = reportText.slice(offset, offset + chunkSize);
    let sourcePos = sourceText.indexOf(anchor);
    while (sourcePos !== -1) {
      let left = 0;
      while (
        offset - left > 0 &&
        sourcePos - left > 0 &&
        reportText.charCodeAt(offset - left - 1) === sourceText.charCodeAt(sourcePos - left - 1)
      ) {
        left += 1;
      }

      let right = chunkSize;
      while (
        offset + right < reportText.length &&
        sourcePos + right < sourceText.length &&
        reportText.charCodeAt(offset + right) === sourceText.charCodeAt(sourcePos + right)
      ) {
        right += 1;
      }

      const matchLen = left + right;
      if (matchLen >= minChars) {
        const snippet = reportText.slice(offset - left, offset + right);
        if (countAlnumChars(snippet) >= MIN_ALNUM_CHARS_FOR_COPY) {
          return { length: matchLen, snippet };
        }
      }

      sourcePos = sourceText.indexOf(anchor, sourcePos + 1);
    }
  }

  return null;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Detecta trechos consecutivos com `>= minChars` (default 120) idênticos a blobs/textos de
 * `bundle_string`, `dom_snapshot` ou `doc_section` (`docs/05` §7).
 */
export function findLiteralCopyViolations(
  reportMarkdown: string,
  corpusEntries: readonly AntiCopyCorpusEntry[],
  minChars: number = DEFAULT_ANTI_COPY_MIN_CHARS,
): ReportQualityIssue[] {
  const issues: ReportQualityIssue[] = [];
  const rawReport = normalizeNewlines(reportMarkdown);
  const collapsedReport = collapseWhitespace(reportMarkdown);

  for (const entry of corpusEntries) {
    const rawSource = normalizeNewlines(entry.text);
    const rawMatch = findLongestConsecutiveMatch(rawReport, rawSource, minChars);
    if (rawMatch !== null) {
      issues.push({
        kind: "anti_copy_violation",
        evidenceId: entry.evidenceId,
        message: `Trecho literal de ${rawMatch.length} caracteres idêntico à evidência ${entry.evidenceId} (${entry.kind}) detectado no relatório.`,
      });
      continue;
    }

    const collapsedSource = collapseWhitespace(entry.text);
    const collapsedMatch = findLongestConsecutiveMatch(collapsedReport, collapsedSource, minChars);
    if (collapsedMatch !== null) {
      issues.push({
        kind: "anti_copy_violation",
        evidenceId: entry.evidenceId,
        message: `Trecho normalizado de ${collapsedMatch.length} caracteres idêntico à evidência ${entry.evidenceId} (${entry.kind}) detectado no relatório.`,
      });
    }
  }

  return issues;
}

/**
 * Extrai os caminhos de screenshots referenciados em Markdown (`![...](assets/...)`).
 */
export function extractReferencedAssetFilenames(reportMarkdown: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const imageRegex = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of reportMarkdown.matchAll(imageRegex)) {
    const rawTarget = (match[1] ?? "").trim();
    if (rawTarget.length === 0 || /^https?:\/\//i.test(rawTarget)) {
      continue;
    }
    const normalized = rawTarget.replace(/^\.\//, "");
    const assetRel = normalized.startsWith("assets/")
      ? normalized.slice("assets/".length)
      : normalized;
    if (!seen.has(assetRel)) {
      seen.add(assetRel);
      names.push(assetRel);
    }
  }

  return names;
}

function checkRulesEvidence(
  rules: readonly BusinessRule[],
  validEvidenceIds?: ReadonlySet<string>,
): ReportQualityIssue[] {
  const issues: ReportQualityIssue[] = [];
  for (const rule of rules) {
    if (!Array.isArray(rule.evidenceIds) || rule.evidenceIds.length === 0) {
      issues.push({
        kind: "rule_without_evidence",
        ruleId: rule.id,
        message: `Regra ${rule.id} ("${rule.title}") não possui evidenceIds.`,
      });
      continue;
    }
    if (validEvidenceIds !== undefined) {
      const invalidIds = rule.evidenceIds.filter((id) => !validEvidenceIds.has(id));
      if (invalidIds.length === rule.evidenceIds.length) {
        issues.push({
          kind: "rule_without_evidence",
          ruleId: rule.id,
          message: `Regra ${rule.id} ("${rule.title}") referencia apenas evidenceIds inexistentes (${invalidIds.join(", ")}).`,
        });
      }
    }
  }
  return issues;
}

function checkAssetsExistence(
  reportMarkdown: string,
  moduleScreenshots: readonly string[],
  assetsDir: string,
): { issues: ReportQualityIssue[]; checkedAssets: number } {
  const issues: ReportQualityIssue[] = [];
  const referenced = new Set<string>([
    ...extractReferencedAssetFilenames(reportMarkdown),
    ...moduleScreenshots,
  ]);
  const resolvedAssetsRoot = resolve(assetsDir);

  for (const rel of referenced) {
    const normalizedRel = posix.normalize(rel).replace(/^\/+/, "");
    if (
      normalizedRel.length === 0 ||
      normalizedRel === "." ||
      normalizedRel.startsWith("..") ||
      normalizedRel.includes("/")
    ) {
      issues.push({
        kind: "missing_asset",
        assetPath: rel,
        message: `Caminho de asset inválido ou fora de report/assets/: "${rel}".`,
      });
      continue;
    }

    const diskPath = resolve(resolvedAssetsRoot, normalizedRel);
    if (!diskPath.startsWith(`${resolvedAssetsRoot}${sep}`)) {
      issues.push({
        kind: "missing_asset",
        assetPath: rel,
        message: `Caminho de asset fora de report/assets/: "${rel}".`,
      });
      continue;
    }

    if (!existsSync(diskPath) || !statSync(diskPath).isFile() || statSync(diskPath).size === 0) {
      issues.push({
        kind: "missing_asset",
        assetPath: `assets/${normalizedRel}`,
        message: `Screenshot referenciado não encontrado ou vazio em report/assets/: "${normalizedRel}".`,
      });
    }
  }

  return { issues, checkedAssets: referenced.size };
}

function checkMermaidDiagrams(
  reportMarkdown: string,
  reportIndex: Pick<ReportIndexDocument, "domain" | "stateMachines" | "flows">,
): { issues: ReportQualityIssue[]; checkedMermaidBlocks: number } {
  const issues: ReportQualityIssue[] = [];
  const markdownCheck = validateMarkdownMermaidBlocks(reportMarkdown);

  for (const err of markdownCheck.errors) {
    issues.push({
      kind: "invalid_mermaid",
      diagramKind: "markdown",
      message: err,
    });
  }

  let totalBlocks = markdownCheck.blockCount;

  const erResult = validateMermaidSyntax(reportIndex.domain.erMermaid);
  totalBlocks += 1;
  if (!erResult.valid) {
    issues.push({
      kind: "invalid_mermaid",
      diagramKind: "erDiagram",
      message: `Diagrama ER de index.json inválido: ${erResult.errors.join("; ")}`,
    });
  }

  for (const sm of reportIndex.stateMachines) {
    totalBlocks += 1;
    const smResult = validateMermaidSyntax(sm.mermaid);
    if (!smResult.valid) {
      issues.push({
        kind: "invalid_mermaid",
        diagramKind: "stateDiagram-v2",
        message: `Diagrama de estado de "${sm.entity}" inválido: ${smResult.errors.join("; ")}`,
      });
    }
  }

  for (const flow of reportIndex.flows) {
    totalBlocks += 1;
    const flowResult = validateMermaidSyntax(flow.mermaid);
    if (!flowResult.valid) {
      issues.push({
        kind: "invalid_mermaid",
        diagramKind: "sequenceDiagram",
        message: `Diagrama de sequência de "${flow.name}" inválido: ${flowResult.errors.join("; ")}`,
      });
    }
  }

  return { issues, checkedMermaidBlocks: totalBlocks };
}

/**
 * Executa todas as verificações automáticas de qualidade de `docs/05` §7:
 * 1. Zero regra sem `evidenceIds`
 * 2. Heurística anti-cópia (nenhum trecho >= 120 chars de `bundle_string`/`dom_snapshot`/`doc_section`)
 * 3. Existência de todos os screenshots referenciados em `report/assets/`
 * 4. Validação sintática dos blocos `mermaid`
 */
export function verifyReportQuality(input: VerifyReportQualityInput): ReportQualityCheckResult {
  const issues: ReportQualityIssue[] = [];
  const minCopyChars = input.minCopyChars ?? DEFAULT_ANTI_COPY_MIN_CHARS;

  issues.push(...checkRulesEvidence(input.reportIndex.rules, input.validEvidenceIds));
  issues.push(
    ...findLiteralCopyViolations(input.reportMarkdown, input.corpusEntries, minCopyChars),
  );

  const moduleScreenshots = input.reportIndex.modules
    .map((m) => m.screenshot)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const assetsCheck = checkAssetsExistence(
    input.reportMarkdown,
    moduleScreenshots,
    input.assetsDir,
  );
  issues.push(...assetsCheck.issues);

  const mermaidCheck = checkMermaidDiagrams(input.reportMarkdown, input.reportIndex);
  issues.push(...mermaidCheck.issues);

  return {
    ok: issues.length === 0,
    issues,
    checkedRules: input.reportIndex.rules.length,
    checkedBlobs: input.corpusEntries.length,
    checkedAssets: assetsCheck.checkedAssets,
    checkedMermaidBlocks: mermaidCheck.checkedMermaidBlocks,
  };
}
