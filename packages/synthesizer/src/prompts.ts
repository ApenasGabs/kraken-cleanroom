import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Evidence, Manifest } from "@cleanroom/core";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "./schemas.js";

export const DEFAULT_MAX_BATCH_TOKENS = 30_000;
const MAX_DATA_STRING_CHARS = 300;
const MAX_DATA_ARRAY_ITEMS = 12;
const MAX_DATA_KEYS = 16;

export interface CompactEvidenceEntry {
  id: string;
  kind: Evidence["kind"];
  phase: Evidence["phase"];
  url?: string;
  stateId?: string;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Localiza `packages/synthesizer/prompts/system.md` tanto em execução de código-fonte (`src/`)
 * quanto após build (`dist/`).
 */
export function resolveSystemPromptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../prompts/system.md"),
    resolve(currentDir, "../../prompts/system.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? resolve(currentDir, "../prompts/system.md");
}

export function loadSystemPromptTemplate(promptPath?: string | undefined): string {
  const targetPath = promptPath ?? resolveSystemPromptPath();
  return readFileSync(targetPath, "utf8");
}

/**
 * Monta o contexto do manifesto injetado no prompt de sistema (`docs/03` §5, `docs/05` §5).
 */
export function formatManifestContext(manifest: Manifest): string {
  const enabledMethods = Object.entries(manifest.methods)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);

  const lines = [
    `- Job: ${manifest.job.name}`,
    ...(manifest.job.description ? [`- Descrição: ${manifest.job.description}`] : []),
    `- Alvo: ${manifest.target.url ?? manifest.target.repo ?? "(não informado)"} (${manifest.target.type})`,
    `- Ownership: ${manifest.ownership}`,
    `- Base de autorização: ${manifest.authorization.basis}`,
    `- Métodos ativos: ${enabledMethods.join(", ") || "nenhum"}`,
    `- Idioma do relatório: ${manifest.report.language}`,
    ...(manifest.job.goals.length > 0
      ? ["- Objetivos do estudo:", ...manifest.job.goals.map((g) => `  - ${g}`)]
      : ["- Objetivos do estudo: mapear módulos, regras de negócio, domínio e fluxos principais."]),
  ];

  return lines.join("\n");
}

export function buildSynthesizerSystemPrompt(
  manifest: Manifest,
  schema: ZodTypeAny,
  templateOverride?: string | undefined,
): string {
  const template = templateOverride ?? loadSystemPromptTemplate();
  const manifestContext = formatManifestContext(manifest);
  const jsonSchema = JSON.stringify(zodToJsonSchema(schema), null, 2);
  return template
    .replace("{{MANIFEST_CONTEXT}}", manifestContext)
    .replace("{{JSON_SCHEMA}}", jsonSchema);
}

/**
 * Monta o prompt de sistema para a etapa narrativa curta da Fase 7 (`report`), mantendo as
 * regras estritas de clean room e rastreabilidade (`docs/04` Fase 7, `docs/05` §5-§6).
 */
export function buildReportNarrativeSystemPrompt(
  manifest: Manifest,
  schema: ZodTypeAny,
  templateOverride?: string | undefined,
): string {
  const basePrompt = buildSynthesizerSystemPrompt(manifest, schema, templateOverride);
  return [
    basePrompt,
    "",
    "## 6. Instruções Específicas da Fase 7 (Narrativa do Relatório)",
    "- Escreva apenas trechos narrativos curtos, objetivos e parafraseados a partir dos dados estruturados fornecidos.",
    "- NUNCA copie trechos literais longos (>= 120 caracteres) de documentação, DOM ou strings de bundle.",
    "- Em `executiveNarrative`, produza um resumo executivo conciso (3 a 5 linhas) explicando o que o produto faz, principais achados e cobertura.",
    "- Em `permissionsMatrixMarkdown`, gere uma tabela Markdown válida (`| Papel / Contexto | Permissões observadas | Restrições | Evidência |`).",
  ].join("\n");
}

function compactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= MAX_DATA_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_DATA_STRING_CHARS - 3)}...`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DATA_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const compacted: Record<string, unknown> = {};
    const keys = Object.keys(record).slice(0, MAX_DATA_KEYS);
    for (const key of keys) {
      if (key === "blob" || key === "html" || key === "rawBody" || key === "source") {
        continue;
      }
      compacted[key] = compactValue(record[key], depth + 1);
    }
    return compacted;
  }
  return String(value);
}

/**
 * Serializa uma evidência para prompt de LLM usando apenas `summary` e campos-chave de `data`,
 * nunca blobs (`docs/05` §5).
 */
export function serializeEvidenceForPrompt(evidence: Evidence): CompactEvidenceEntry {
  const compactedData = compactValue(evidence.data, 0);
  const safeData =
    compactedData !== null && typeof compactedData === "object" && !Array.isArray(compactedData)
      ? (compactedData as Record<string, unknown>)
      : {};

  return {
    id: evidence.id,
    kind: evidence.kind,
    phase: evidence.phase,
    ...(evidence.url !== undefined ? { url: evidence.url } : {}),
    ...(evidence.stateId !== undefined ? { stateId: evidence.stateId } : {}),
    summary: evidence.summary,
    data: safeData,
  };
}

/** Estimativa conservadora (~4 chars/token) para controle de orçamento de contexto. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Pagina evidências serializadas em lotes de até `maxTokensPerBatch` (~30k tokens por chamada,
 * `docs/04` Fase 5 §2).
 */
export function paginateEvidenceBatches(
  evidences: readonly Evidence[],
  maxTokensPerBatch: number = DEFAULT_MAX_BATCH_TOKENS,
): CompactEvidenceEntry[][] {
  const budget = Math.max(500, Math.trunc(maxTokensPerBatch));
  const serialized = evidences.map(serializeEvidenceForPrompt);
  if (serialized.length === 0) {
    return [];
  }

  const batches: CompactEvidenceEntry[][] = [];
  let currentBatch: CompactEvidenceEntry[] = [];
  let currentTokens = 2; // colchetes JSON

  for (const item of serialized) {
    const itemTokens = estimateTokens(JSON.stringify(item)) + 2;
    if (currentBatch.length > 0 && currentTokens + itemTokens > budget) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 2;
    }
    currentBatch.push(item);
    currentTokens += itemTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
