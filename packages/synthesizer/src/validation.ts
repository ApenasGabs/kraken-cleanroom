import { createHash } from "node:crypto";
import type { BusinessRule, Confidence, Finding, FindingCategory, JobEvent } from "@cleanroom/core";

const CONFIDENCE_RANK: Record<Confidence, number> = {
  hypothesis: 1,
  inferred: 2,
  observed: 3,
};

export type UnsupportedClaimType =
  | "module"
  | "finding"
  | "rule"
  | "domain_attribute"
  | "domain_relation"
  | "state_machine"
  | "state_transition"
  | "flow"
  | "flow_step";

export const HIGH_DISCARD_RATE_THRESHOLD = 0.2;

export function normalizeTextForFingerprint(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeFindingFingerprint(
  module: string,
  category: FindingCategory,
  statement: string,
): string {
  const canonical = [
    normalizeTextForFingerprint(module),
    category,
    normalizeTextForFingerprint(statement),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function higherConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function uniqueOrderedStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const val of values) {
    if (!seen.has(val)) {
      seen.add(val);
      result.push(val);
    }
  }
  return result;
}

/**
 * Deduplica achados por `fingerprint`, mesclando `evidenceIds` e mantendo a maior confiança.
 */
export function deduplicateFindings(findings: readonly Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const item of findings) {
    const existing = byFingerprint.get(item.fingerprint);
    if (existing === undefined) {
      byFingerprint.set(item.fingerprint, {
        ...item,
        evidenceIds: uniqueOrderedStrings(item.evidenceIds),
      });
      continue;
    }
    byFingerprint.set(item.fingerprint, {
      ...existing,
      confidence: higherConfidence(existing.confidence, item.confidence),
      evidenceIds: uniqueOrderedStrings([...existing.evidenceIds, ...item.evidenceIds]),
    });
  }
  return [...byFingerprint.values()];
}

export function filterSupportedEvidenceIds(
  citedIds: readonly string[],
  validEvidenceIds: ReadonlySet<string>,
): string[] {
  return uniqueOrderedStrings(
    citedIds.map((id) => id.trim()).filter((id) => id.length > 0 && validEvidenceIds.has(id)),
  );
}

/**
 * Ordena regras por módulo (alfabético) e ordem de criação/descoberta, atribuindo IDs
 * estáveis `BR-001`, `BR-002`, ... (`docs/04` Fase 5 §3).
 */
export function assignStableRuleIds(rules: readonly Omit<BusinessRule, "id">[]): BusinessRule[] {
  const indexed = rules.map((rule, index) => ({ rule, index }));
  indexed.sort((a, b) => {
    const modCmp = a.rule.module.toLowerCase().localeCompare(b.rule.module.toLowerCase(), "en");
    if (modCmp !== 0) {
      return modCmp;
    }
    return a.index - b.index;
  });

  return indexed.map(({ rule }, pos) => ({
    ...rule,
    id: `BR-${String(pos + 1).padStart(3, "0")}`,
  }));
}

export class ClaimValidationTracker {
  private readonly validIds: ReadonlySet<string>;
  private readonly emitEvent: (event: JobEvent) => void;
  totalEvaluated = 0;
  discarded = 0;

  constructor(validIds: ReadonlySet<string>, emitEvent: (event: JobEvent) => void) {
    this.validIds = validIds;
    this.emitEvent = emitEvent;
  }

  validateClaim(
    claimType: UnsupportedClaimType,
    label: string,
    citedIds: readonly string[],
  ): { supported: boolean; evidenceIds: string[] } {
    this.totalEvaluated += 1;
    const supportedIds = filterSupportedEvidenceIds(citedIds, this.validIds);
    if (supportedIds.length === 0) {
      this.discarded += 1;
      this.emitEvent({
        type: "synthesis_unsupported_claim",
        phase: "synthesize",
        data: {
          claimType,
          label: label.slice(0, 200),
          citedEvidenceIds: [...citedIds],
        },
      });
      return { supported: false, evidenceIds: [] };
    }
    return { supported: true, evidenceIds: supportedIds };
  }

  getDiscardRate(): number {
    return this.totalEvaluated > 0 ? this.discarded / this.totalEvaluated : 0;
  }

  getDiscardRatePercent(): number {
    return Math.round(this.getDiscardRate() * 1000) / 10;
  }
}
