import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type BusinessRule,
  type Confidence,
  type Evidence,
  type FindingsDocument,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
  type ReportApiOperation,
  type ReportGapEntry,
  type ReportIndexDocument,
  type ReportIntegrationEntry,
  type ReportModuleFeature,
  type ReportModuleSection,
  type ReportPricingPlan,
  type ReportQualityCheckResult,
  ReportQualityError,
  type ReportRuleStatsSummary,
  type ReportValidationEntry,
  type SynthesizedModule,
} from "@cleanroom/core";
import { parse as parseYaml } from "yaml";
import { buildReportNarrativeSystemPrompt } from "./prompts.js";
import {
  generateErMermaid,
  generateFlowSequenceMermaid,
  generateStateMachineMermaid,
} from "./report-mermaid.js";
import { collectAntiCopyCorpus, verifyReportQuality } from "./report-quality.js";
import { loadReportTemplate, renderReportTemplate } from "./report-renderer.js";
import { type ReportNarrativeOutput, ReportNarrativeOutputSchema } from "./schemas.js";

export interface ReportOptions {
  phaseId?: PhaseId | undefined;
  templatePath?: string | undefined;
  templateContent?: string | undefined;
  systemPromptTemplate?: string | undefined;
  reportDir?: string | undefined;
  findingsPath?: string | undefined;
  findingsDocument?: FindingsDocument | undefined;
  useLlmNarrative?: boolean | undefined;
  narrativeOverride?: Partial<ReportNarrativeOutput> | undefined;
  strictQuality?: boolean | undefined;
  minCopyChars?: number | undefined;
  finishedAt?: string | undefined;
  durationMin?: number | undefined;
}

export interface ReportStats extends Record<string, number> {
  modules: number;
  rules: number;
  entities: number;
  stateMachines: number;
  flows: number;
  apiOperations: number;
  validations: number;
  integrations: number;
  assetsCopied: number;
  qualityIssues: number;
}

export interface ReportPhaseResult {
  reportPath: string;
  indexPath: string;
  assetsDir: string;
  markdown: string;
  index: ReportIndexDocument;
  quality: ReportQualityCheckResult;
  stats: ReportStats;
}

interface StateGraphSummary {
  pagesVisited?: number | undefined;
  skippedOutOfScope?: number | undefined;
  skippedDestructive?: number | undefined;
  skippedPaginationLimit?: number | undefined;
  maxDepthReached?: number | undefined;
  rateLimit429Count?: number | undefined;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Execução da fase report abortada.");
  }
}

function deriveProductName(ctx: PhaseContext): string {
  const urlStr = ctx.manifest.target.url;
  if (urlStr) {
    try {
      const parsed = new URL(urlStr);
      if (parsed.hostname && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        return parsed.hostname;
      }
    } catch {
      // fallback abaixo
    }
  }
  return ctx.manifest.job.name;
}

function loadFindingsDocument(
  ctx: PhaseContext,
  jobDir: string,
  options?: ReportOptions,
): FindingsDocument {
  if (options?.findingsDocument !== undefined) {
    return options.findingsDocument;
  }

  const findingsPath = options?.findingsPath ?? join(jobDir, "findings.json");
  if (existsSync(findingsPath)) {
    const parsed = JSON.parse(readFileSync(findingsPath, "utf8")) as FindingsDocument;
    return parsed;
  }

  const findings = ctx.evidence.listFindings(ctx.job.id);
  const rules = ctx.evidence.listRules(ctx.job.id);
  const moduleNames = new Set<string>([
    ...findings.map((f) => f.module),
    ...rules.map((r) => r.module),
  ]);
  const modules: SynthesizedModule[] = [...moduleNames].map((name) => {
    const modEvidenceIds = [
      ...new Set([
        ...findings.filter((f) => f.module === name).flatMap((f) => f.evidenceIds),
        ...rules.filter((r) => r.module === name).flatMap((r) => r.evidenceIds),
      ]),
    ];
    return {
      name,
      description: `Comportamento consolidado do módulo ${name}.`,
      stateIds: [],
      endpoints: [],
      docSections: [],
      evidenceIds: modEvidenceIds,
    };
  });

  return {
    version: 1,
    jobId: ctx.job.id,
    generatedAt: new Date().toISOString(),
    modules,
    findings,
    rules,
    domain: { entities: [] },
    stateMachines: [],
    flows: [],
    features: [],
    stats: {
      modules: modules.length,
      findings: findings.length,
      rules: rules.length,
      entities: 0,
      stateMachines: 0,
      flows: 0,
      unsupportedClaimsDiscarded: 0,
      totalClaimsEvaluated: 0,
      discardRatePercent: 0,
    },
  };
}

function readStateGraphSummary(jobDir: string): StateGraphSummary | null {
  const graphPath = join(jobDir, "graph", "state-graph.json");
  if (!existsSync(graphPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(graphPath, "utf8")) as {
      nodes?: unknown[];
      stats?: StateGraphSummary;
    };
    const derivedPagesVisited =
      parsed.stats?.pagesVisited ?? (Array.isArray(parsed.nodes) ? parsed.nodes.length : undefined);
    return {
      ...(parsed.stats ?? {}),
      ...(derivedPagesVisited !== undefined ? { pagesVisited: derivedPagesVisited } : {}),
    };
  } catch {
    return null;
  }
}

function readExecutedPhases(jobDir: string, evidences: readonly Evidence[]): string[] {
  const jobJsonPath = join(jobDir, "job.json");
  if (existsSync(jobJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jobJsonPath, "utf8")) as {
        phases?: Array<{ phase?: string; status?: string }>;
      };
      if (Array.isArray(parsed.phases)) {
        const donePhases = parsed.phases
          .filter((p) => p.status === "done" || p.phase === "report")
          .map((p) => p.phase)
          .filter((p): p is string => typeof p === "string");
        if (donePhases.length > 0) {
          return donePhases;
        }
      }
    } catch {
      // fallback pelas evidências
    }
  }

  const fromEvidences = new Set<string>(evidences.map((e) => e.phase));
  fromEvidences.add("synthesize");
  fromEvidences.add("report");
  return [...fromEvidences];
}

function extractPricingPlans(evidences: readonly Evidence[]): ReportPricingPlan[] {
  const plans: ReportPricingPlan[] = [];
  const seen = new Set<string>();

  for (const ev of evidences) {
    if (ev.kind !== "pricing_plan") {
      continue;
    }

    const nestedPlans = ev.data.plans;
    if (Array.isArray(nestedPlans)) {
      for (const item of nestedPlans) {
        if (item === null || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const price = typeof rec.price === "string" ? rec.price.trim() : "Sob consulta";
        let limits = "Conforme plano";
        if (Array.isArray(rec.limits) && rec.limits.length > 0) {
          limits = rec.limits.map((l) => String(l)).join("; ");
        } else if (rec.projectLimit !== undefined && rec.projectLimit !== null) {
          limits =
            rec.projectLimit === "unlimited"
              ? "Projetos ilimitados"
              : `Até ${String(rec.projectLimit)} projetos`;
        }
        plans.push({ name, price, limits, evidenceIds: [ev.id] });
      }
      continue;
    }

    const rawName =
      typeof ev.data.displayName === "string"
        ? ev.data.displayName
        : typeof ev.data.name === "string"
          ? ev.data.name
          : "";
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const price = typeof ev.data.price === "string" ? ev.data.price.trim() : "Sob consulta";
    const limitsArr = Array.isArray(ev.data.limits)
      ? ev.data.limits.map((l) => String(l).trim()).filter((l) => l.length > 0)
      : [];
    const limits =
      limitsArr.length > 0
        ? limitsArr.join("; ")
        : ev.data.unlimitedProjects === true
          ? "Projetos ilimitados"
          : typeof ev.data.projectLimit === "number"
            ? `Até ${ev.data.projectLimit} projetos`
            : ev.summary;

    plans.push({ name, price, limits, evidenceIds: [ev.id] });
  }

  return plans;
}

function extractApiOperations(
  jobDir: string,
  evidences: readonly Evidence[],
  purposeLookup: ReadonlyMap<string, string>,
): ReportApiOperation[] {
  const operations: ReportApiOperation[] = [];
  const openApiPath = join(jobDir, "analysis", "openapi.yaml");

  if (existsSync(openApiPath)) {
    try {
      const parsed = parseYaml(readFileSync(openApiPath, "utf8")) as {
        paths?: Record<string, Record<string, unknown>>;
      } | null;
      if (parsed !== null && typeof parsed === "object" && parsed.paths) {
        const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
        for (const [pathKey, pathItem] of Object.entries(parsed.paths)) {
          if (pathItem === null || typeof pathItem !== "object") continue;
          for (const [methodKey, opValue] of Object.entries(pathItem)) {
            if (!httpMethods.has(methodKey.toLowerCase())) continue;
            if (opValue === null || typeof opValue !== "object") continue;
            const op = opValue as Record<string, unknown>;
            const method = methodKey.toUpperCase();
            const overridePurpose = purposeLookup.get(`${method} ${pathKey}`);
            const summary =
              overridePurpose ??
              (typeof op.summary === "string" && op.summary.trim().length > 0
                ? op.summary.trim()
                : `${method} ${pathKey}`);
            const security =
              Array.isArray(op.security) && op.security.length > 0
                ? op.security
                    .flatMap((entry) =>
                      entry !== null && typeof entry === "object" ? Object.keys(entry) : [],
                    )
                    .join(", ") || "autenticado"
                : "público";
            const rawEv = op["x-cleanroom-evidence"];
            const evidenceIds = Array.isArray(rawEv)
              ? rawEv.filter((id): id is string => typeof id === "string")
              : [];
            operations.push({
              method,
              path: pathKey,
              purpose: summary,
              auth: security,
              evidenceIds,
            });
          }
        }
      }
    } catch {
      // fallback pelas evidências network_call
    }
  }

  if (operations.length > 0) {
    return operations;
  }

  const grouped = new Map<
    string,
    { method: string; path: string; auth: Set<string>; evidenceIds: Set<string>; summary: string }
  >();
  for (const ev of evidences) {
    if (ev.kind !== "network_call") continue;
    const method = typeof ev.data.method === "string" ? ev.data.method.toUpperCase() : "GET";
    const pathTemplate =
      typeof ev.data.pathTemplate === "string"
        ? ev.data.pathTemplate
        : ev.url
          ? new URL(ev.url).pathname
          : "/";
    const key = `${method} ${pathTemplate}`;
    const existing = grouped.get(key) ?? {
      method,
      path: pathTemplate,
      auth: new Set<string>(),
      evidenceIds: new Set<string>(),
      summary: purposeLookup.get(key) ?? ev.summary,
    };
    if (Array.isArray(ev.data.authSchemes)) {
      for (const scheme of ev.data.authSchemes) {
        if (typeof scheme === "string" && scheme.length > 0) {
          existing.auth.add(scheme);
        }
      }
    }
    existing.evidenceIds.add(ev.id);
    grouped.set(key, existing);
  }

  for (const item of grouped.values()) {
    operations.push({
      method: item.method,
      path: item.path,
      purpose: item.summary,
      auth: item.auth.size > 0 ? [...item.auth].join(", ") : "público",
      evidenceIds: [...item.evidenceIds],
    });
  }

  return operations;
}

function extractValidations(
  evidences: readonly Evidence[],
  rules: readonly BusinessRule[],
): ReportValidationEntry[] {
  const entries: ReportValidationEntry[] = [];
  const seen = new Set<string>();

  for (const ev of evidences) {
    if (ev.kind === "form_probe") {
      const form =
        typeof ev.data.formId === "string"
          ? ev.data.formId
          : ev.url
            ? (() => {
                try {
                  return new URL(ev.url).pathname;
                } catch {
                  return ev.url;
                }
              })()
            : "formulário";
      const field = typeof ev.data.field === "string" ? ev.data.field : "campo";
      const rule =
        typeof ev.data.code === "string"
          ? ev.data.code
          : typeof ev.data.probeType === "string"
            ? ev.data.probeType
            : "validação de entrada";
      const msg =
        typeof ev.data.observedMessage === "string" && ev.data.observedMessage.trim().length > 0
          ? ev.data.observedMessage.trim()
          : ev.summary;
      const key = `${form}|${field}|${rule}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          form,
          field,
          rule,
          messageSummary: msg.slice(0, 140),
          evidenceIds: [ev.id],
        });
      }
    }
  }

  for (const rule of rules) {
    if (
      !/valid|obrigat|formato|credenciais|orçamento|data|tamanho/i.test(
        `${rule.title} ${rule.condition}`,
      )
    ) {
      continue;
    }
    const key = `rule|${rule.module}|${rule.title}`.toLowerCase();
    if (seen.has(key)) continue;
    if (entries.some((e) => rule.evidenceIds.some((id) => e.evidenceIds.includes(id)))) {
      continue;
    }
    seen.add(key);
    entries.push({
      form: rule.module,
      field: "-",
      rule: rule.title,
      messageSummary: rule.effect.slice(0, 140),
      evidenceIds: [...rule.evidenceIds],
    });
  }

  return entries;
}

function extractIntegrations(
  evidences: readonly Evidence[],
  allowedOrigins: readonly string[],
): ReportIntegrationEntry[] {
  const entries: ReportIntegrationEntry[] = [];
  const seen = new Set<string>();
  const allowedSet = new Set(allowedOrigins);

  for (const ev of evidences) {
    if (ev.kind === "tech_signature") {
      const tech = typeof ev.data.technology === "string" ? ev.data.technology : ev.summary;
      const key = `tech:${tech.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          name: tech,
          category: "stack/framework",
          signal: ev.summary,
          evidenceIds: [ev.id],
        });
      }
      continue;
    }

    if (ev.kind === "feature_flag") {
      const flagName = typeof ev.data.name === "string" ? ev.data.name : ev.summary;
      const key = `flag:${flagName.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          name: flagName,
          category: "feature_flag",
          signal: ev.summary,
          evidenceIds: [ev.id],
        });
      }
      continue;
    }

    if (ev.kind === "network_call" && ev.url) {
      try {
        const origin = new URL(ev.url).origin;
        if (allowedSet.size > 0 && !allowedSet.has(origin)) {
          const key = `origin:${origin}`;
          if (!seen.has(key)) {
            seen.add(key);
            entries.push({
              name: new URL(ev.url).hostname,
              category: "external_origin",
              signal: `Chamada observada para origem externa ${origin}`,
              evidenceIds: [ev.id],
            });
          }
        }
      } catch {
        // ignora URL inválida
      }
    }
  }

  return entries;
}

function buildGaps(
  findingsDoc: FindingsDocument,
  rules: readonly BusinessRule[],
  allEvidences: readonly Evidence[],
): ReportGapEntry[] {
  const gaps: ReportGapEntry[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (rule.validation?.status === "contradicted") {
      const key = `contradiction:${rule.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push({
          kind: "contradiction",
          text: `${rule.id} (${rule.title}): contradição detectada na validação (${rule.effect})`,
          evidenceIds: [...new Set([...rule.evidenceIds, rule.validation.runEvidenceId])],
        });
      }
    } else if (rule.validation?.status === "inconclusive") {
      const key = `inconclusive:${rule.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push({
          kind: "inconclusive",
          text: `${rule.id} (${rule.title}): validação inconclusiva; requer verificação adicional`,
          evidenceIds: [...new Set([...rule.evidenceIds, rule.validation.runEvidenceId])],
        });
      }
    } else if (rule.confidence === "hypothesis") {
      const key = `hypothesis:${rule.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push({
          kind: "hypothesis",
          text: `${rule.id} (${rule.title}): inferida apenas por documentação/bundle, sem confirmação na UI/rede`,
          evidenceIds: [...rule.evidenceIds],
        });
      }
    }
  }

  for (const finding of findingsDoc.findings) {
    if (finding.confidence === "hypothesis") {
      const key = `finding_hyp:${finding.fingerprint}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push({
          kind: "hypothesis",
          text: `${finding.module}: ${finding.statement}`,
          evidenceIds: [...finding.evidenceIds],
        });
      }
    }
  }

  if (findingsDoc.stats.unsupportedClaimsDiscarded > 0) {
    const fallbackEv = allEvidences[0]?.id;
    gaps.push({
      kind: "coverage",
      text: `${findingsDoc.stats.unsupportedClaimsDiscarded} afirmação(ões) sem evidência válida foram descartadas durante a síntese.`,
      evidenceIds: fallbackEv ? [fallbackEv] : [],
    });
  }

  return gaps;
}

function copyModuleScreenshots(
  ctx: PhaseContext,
  modules: readonly SynthesizedModule[],
  allEvidences: readonly Evidence[],
  assetsDir: string,
): { screenshotByModule: Map<string, string>; copiedFiles: string[] } {
  const screenshots = allEvidences.filter(
    (e) => e.kind === "screenshot" && e.blobPath !== undefined,
  );
  const screenshotByModule = new Map<string, string>();
  const copiedFiles = new Set<string>();

  if (screenshots.length === 0) {
    return { screenshotByModule, copiedFiles: [] };
  }

  const pickBestScreenshot = (candidates: readonly Evidence[]): Evidence | undefined => {
    if (candidates.length === 0) return undefined;
    const sorted = [...candidates].sort((a, b) => {
      const wA = typeof a.data.width === "number" ? a.data.width : 0;
      const wB = typeof b.data.width === "number" ? b.data.width : 0;
      return wB - wA;
    });
    return sorted[0];
  };

  for (const mod of modules) {
    const stateSet = new Set(mod.stateIds);
    const evSet = new Set(mod.evidenceIds);
    const matched = screenshots.filter(
      (s) => (s.stateId !== undefined && stateSet.has(s.stateId)) || evSet.has(s.id),
    );
    const chosen = pickBestScreenshot(matched);
    if (chosen === undefined || chosen.blobPath === undefined) {
      continue;
    }

    const srcDiskPath = ctx.evidence.resolveBlobDiskPath(ctx.job.id, chosen.blobPath);
    if (!existsSync(srcDiskPath)) {
      continue;
    }

    const filename = basename(chosen.blobPath);
    const destDiskPath = join(assetsDir, filename);
    mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(destDiskPath)) {
      copyFileSync(srcDiskPath, destDiskPath);
    }
    copiedFiles.add(filename);
    screenshotByModule.set(mod.name.toLowerCase(), filename);
  }

  return { screenshotByModule, copiedFiles: [...copiedFiles] };
}

function buildDeterministicNarrative(
  ctx: PhaseContext,
  findingsDoc: FindingsDocument,
  pricing: readonly ReportPricingPlan[],
): ReportNarrativeOutput {
  const productName = deriveProductName(ctx);
  const moduleNames = findingsDoc.modules.map((m) => m.name);
  const executiveNarrative =
    findingsDoc.rules.length > 0
      ? `Estudo clean room de ${productName} mapeando ${moduleNames.length} módulo(s) funcionais (${moduleNames.join(", ")}) e ${findingsDoc.rules.length} regra(s) de negócio rastreáveis a evidências.`
      : `Estudo clean room de ${productName} executado conforme o manifesto ${ctx.manifest.job.name}.`;

  const highlights = findingsDoc.rules.slice(0, 5).map((r) => ({
    text: `${r.module}: ${r.title}`,
    ruleIds: [r.id],
  }));

  const valueProposition =
    ctx.manifest.job.description ??
    `Aplicação web analisada para especificação funcional de ${moduleNames.join(", ") || "seus fluxos principais"}.`;

  const moduleSummaries = findingsDoc.modules.map((mod) => {
    const modFindings = findingsDoc.findings.filter(
      (f) => f.module.toLowerCase() === mod.name.toLowerCase(),
    );
    const modRules = findingsDoc.rules.filter(
      (r) => r.module.toLowerCase() === mod.name.toLowerCase(),
    );
    const features: ReportModuleFeature[] =
      modFindings.length > 0
        ? modFindings.map((f) => ({
            name: f.category,
            description: f.statement,
            confidence: f.confidence,
            evidenceIds: f.evidenceIds,
          }))
        : modRules.map((r) => ({
            name: r.title,
            description: `${r.trigger} -> ${r.effect}`,
            confidence: r.confidence,
            evidenceIds: r.evidenceIds,
          }));

    return {
      moduleName: mod.name,
      summary: mod.description,
      features,
    };
  });

  const permissionsMatrixMarkdown =
    pricing.length > 0
      ? [
          "| Papel / Plano | Capacidades observadas | Restrições |",
          "|---|---|---|",
          ...pricing.map((p) => `| ${p.name} | ${p.price} | ${p.limits} |`),
        ].join("\n")
      : "| Contexto | Permissões observadas | Restrições |\n|---|---|---|\n| Visitante público | Navegação e uso dos fluxos públicos observados | Rotas administrativas e ações destrutivas fora de escopo |";

  return {
    productName,
    executiveNarrative,
    highlights,
    valueProposition,
    personas: [
      {
        name: "Usuário padrão",
        goal: "Executar os fluxos principais da aplicação dentro dos limites do plano.",
      },
    ],
    moduleSummaries,
    permissionsMatrixMarkdown,
    apiPurposes: [],
  };
}

function buildRuleStats(rules: readonly BusinessRule[]): ReportRuleStatsSummary {
  let observed = 0;
  let inferred = 0;
  let hypothesis = 0;
  for (const rule of rules) {
    if (rule.confidence === "observed") observed += 1;
    else if (rule.confidence === "inferred") inferred += 1;
    else hypothesis += 1;
  }
  return {
    total: rules.length,
    observed,
    inferred,
    hypothesis,
  };
}

function sanitizeFeatureEvidenceIds(
  citedIds: readonly string[],
  validEvidenceIds: ReadonlySet<string>,
  fallbackIds: readonly string[],
): string[] {
  const valid = [...new Set(citedIds.filter((id) => validEvidenceIds.has(id)))];
  if (valid.length > 0) {
    return valid;
  }
  return [...new Set(fallbackIds.filter((id) => validEvidenceIds.has(id)))];
}

function buildModuleSections(
  modules: readonly SynthesizedModule[],
  narrative: ReportNarrativeOutput,
  findingsDoc: FindingsDocument,
  screenshotByModule: ReadonlyMap<string, string>,
  validEvidenceIds: ReadonlySet<string>,
): ReportModuleSection[] {
  const summaryByName = new Map(
    narrative.moduleSummaries.map((m) => [m.moduleName.trim().toLowerCase(), m]),
  );

  return modules.map((mod) => {
    const key = mod.name.trim().toLowerCase();
    const narr = summaryByName.get(key);
    const modFindings = findingsDoc.findings.filter((f) => f.module.trim().toLowerCase() === key);

    let features: ReportModuleFeature[];
    if (narr !== undefined && narr.features.length > 0) {
      features = narr.features.map((feat) => ({
        name: feat.name.trim(),
        description: feat.description.trim(),
        confidence: feat.confidence,
        evidenceIds: sanitizeFeatureEvidenceIds(
          feat.evidenceIds,
          validEvidenceIds,
          mod.evidenceIds,
        ),
      }));
    } else {
      features = modFindings.map((f) => ({
        name: f.category,
        description: f.statement,
        confidence: f.confidence as Confidence,
        evidenceIds: [...f.evidenceIds],
      }));
    }

    const screenshot = screenshotByModule.get(key);
    return {
      name: mod.name,
      summary: narr?.summary.trim() || mod.description,
      features,
      ...(screenshot !== undefined ? { screenshot } : {}),
      evidenceIds: [...mod.evidenceIds],
    };
  });
}

function computeDurationMin(
  createdAtIso: string,
  finishedAtIso: string,
  override?: number,
): number {
  if (override !== undefined) {
    return override;
  }
  const start = Date.parse(createdAtIso);
  const end = Date.parse(finishedAtIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return 0.1;
  }
  return Math.max(0.1, Math.round(((end - start) / 60_000) * 10) / 10);
}

/**
 * Executa a Fase 7 (`report` de `docs/04` e `docs/05` §6-§7):
 * 1. Consolida dados estruturados (`findings.json`/SQLite, `openapi.yaml`, `state-graph.json`, `EvidenceStore`)
 * 2. Gera diagramas Mermaid válidos (`erDiagram`, `stateDiagram-v2`, `sequenceDiagram`)
 * 3. Solicita apenas trechos narrativos curtos ao LLM (ou usa override/fallback em job vazio)
 * 4. Copia screenshots referenciados para `report/assets/`
 * 5. Renderiza `report/report.md` e `report/index.json`
 * 6. Executa o verificador automático de qualidade (`docs/05` §7)
 */
export async function runReportPhase(
  ctx: PhaseContext,
  options?: ReportOptions,
): Promise<ReportPhaseResult> {
  const phaseId: PhaseId = options?.phaseId ?? "report";
  const jobId = ctx.job.id;
  const jobDir = ctx.evidence.resolveJobDir(jobId);
  const reportDir = options?.reportDir ?? join(jobDir, "report");
  const assetsDir = join(reportDir, "assets");
  const reportPath = join(reportDir, "report.md");
  const indexPath = join(reportDir, "index.json");

  assertNotAborted(ctx.signal);

  const findingsDoc = loadFindingsDocument(ctx, jobDir, options);
  const allEvidences = ctx.evidence.listAll(jobId);
  const validEvidenceIds = ctx.evidence.filterExistingIds(
    jobId,
    allEvidences.map((e) => e.id),
  );

  const pricingPlans = extractPricingPlans(allEvidences);
  const graphSummary = readStateGraphSummary(jobDir);
  const executedPhases = readExecutedPhases(jobDir, allEvidences);
  const validations = extractValidations(allEvidences, findingsDoc.rules);
  const integrations = extractIntegrations(allEvidences, ctx.manifest.target.allowedOrigins ?? []);
  const gaps = buildGaps(findingsDoc, findingsDoc.rules, allEvidences);

  const hasContent =
    allEvidences.length > 0 ||
    findingsDoc.modules.length > 0 ||
    findingsDoc.findings.length > 0 ||
    findingsDoc.rules.length > 0;

  let narrative: ReportNarrativeOutput;
  if (options?.narrativeOverride !== undefined) {
    const base = buildDeterministicNarrative(ctx, findingsDoc, pricingPlans);
    narrative = { ...base, ...options.narrativeOverride };
  } else if (options?.useLlmNarrative !== false && hasContent) {
    assertNotAborted(ctx.signal);
    const systemPrompt = buildReportNarrativeSystemPrompt(
      ctx.manifest,
      ReportNarrativeOutputSchema,
      options?.systemPromptTemplate,
    );
    const res = await ctx.llm.generateObject(
      ReportNarrativeOutputSchema,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            task: "Fase 7: Gere apenas os trechos narrativos curtos (visão executiva, proposta de valor, personas, resumos de módulos e matriz de permissões) em metodologia clean room a partir dos dados estruturados.",
            productFallbackName: deriveProductName(ctx),
            targetUrl: ctx.manifest.target.url ?? ctx.manifest.target.repo ?? "",
            goals: ctx.manifest.job.goals,
            modules: findingsDoc.modules,
            findings: findingsDoc.findings.map((f) => ({
              id: f.id,
              module: f.module,
              category: f.category,
              statement: f.statement,
              confidence: f.confidence,
              evidenceIds: f.evidenceIds,
            })),
            rules: findingsDoc.rules.map((r) => ({
              id: r.id,
              module: r.module,
              title: r.title,
              trigger: r.trigger,
              condition: r.condition,
              effect: r.effect,
              confidence: r.confidence,
              evidenceIds: r.evidenceIds,
            })),
            pricing: pricingPlans,
            integrations,
          }),
        },
      ],
      { schemaName: "report_narrative", signal: ctx.signal, jobId },
    );
    narrative = res.data;
  } else {
    narrative = buildDeterministicNarrative(ctx, findingsDoc, pricingPlans);
  }

  const purposeLookup = new Map<string, string>();
  for (const item of narrative.apiPurposes) {
    purposeLookup.set(`${item.method.toUpperCase()} ${item.path}`, item.purpose.trim());
  }
  const apiOperations = extractApiOperations(jobDir, allEvidences, purposeLookup);

  const { screenshotByModule, copiedFiles } = copyModuleScreenshots(
    ctx,
    findingsDoc.modules,
    allEvidences,
    assetsDir,
  );

  const erMermaid = generateErMermaid(findingsDoc.domain.entities);
  const stateMachines = findingsDoc.stateMachines.map((sm) => ({
    ...sm,
    mermaid: generateStateMachineMermaid(sm),
  }));
  const flows = findingsDoc.flows.map((flow) => ({
    ...flow,
    mermaid: generateFlowSequenceMermaid(flow),
  }));

  const finishedAt = options?.finishedAt ?? new Date().toISOString();
  const durationMin = computeDurationMin(ctx.job.createdAt, finishedAt, options?.durationMin);

  const stateCount =
    graphSummary?.pagesVisited ?? allEvidences.filter((e) => e.kind === "state").length;
  const docSectionsCount = allEvidences.filter((e) => e.kind === "doc_section").length;

  const limitNotes: string[] = [];
  if (graphSummary?.skippedOutOfScope) {
    limitNotes.push(`${graphSummary.skippedOutOfScope} fora de escopo`);
  }
  if (graphSummary?.skippedDestructive) {
    limitNotes.push(`${graphSummary.skippedDestructive} destrutiva(s) evitada(s)`);
  }
  if (graphSummary?.rateLimit429Count) {
    limitNotes.push(`${graphSummary.rateLimit429Count} HTTP 429`);
  }
  if (stateCount >= ctx.manifest.limits.maxPages) {
    limitNotes.push(`maxPages (${ctx.manifest.limits.maxPages})`);
  }

  const enabledMethods = Object.entries(ctx.manifest.methods)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);

  const validRuleIds = new Set(findingsDoc.rules.map((r) => r.id));
  const highlights = narrative.highlights.map((h) => ({
    text: h.text.trim(),
    ruleIds: h.ruleIds.filter((id) => validRuleIds.has(id)),
  }));

  const moduleSections = buildModuleSections(
    findingsDoc.modules,
    narrative,
    findingsDoc,
    screenshotByModule,
    validEvidenceIds,
  );

  const initialQuality: ReportQualityCheckResult = {
    ok: true,
    issues: [],
    checkedRules: findingsDoc.rules.length,
    checkedBlobs: 0,
    checkedAssets: copiedFiles.length,
    checkedMermaidBlocks: 0,
  };

  const indexDoc: ReportIndexDocument = {
    version: 1,
    job: {
      id: jobId,
      name: ctx.job.name,
      finishedAt,
      durationMin,
      llmTokensIn: ctx.job.llmTokensIn,
      llmTokensOut: ctx.job.llmTokensOut,
      phases: executedPhases,
    },
    target: {
      url: ctx.manifest.target.url ?? ctx.manifest.target.repo ?? "",
      type: ctx.manifest.target.type,
    },
    manifest: {
      ownership: ctx.manifest.ownership,
      methodsEnabled: enabledMethods,
    },
    product: {
      name: narrative.productName.trim() || deriveProductName(ctx),
      valueProposition: narrative.valueProposition.trim(),
      personas: narrative.personas.map((p) => ({
        name: p.name.trim(),
        goal: p.goal.trim(),
      })),
    },
    summary: {
      narrative: narrative.executiveNarrative.trim(),
      highlights,
    },
    pricing: {
      plans: pricingPlans,
    },
    coverage: {
      pagesVisited: stateCount,
      endpoints: apiOperations.length,
      docSections: docSectionsCount,
      limitsHit: limitNotes.length > 0 ? limitNotes.join(", ") : "nenhum limite atingido",
    },
    stats: {
      rules: buildRuleStats(findingsDoc.rules),
    },
    modules: moduleSections,
    domain: {
      erMermaid,
      entities: findingsDoc.domain.entities,
    },
    rules: findingsDoc.rules,
    stateMachines,
    flows,
    api: {
      openApiPath: "../analysis/openapi.yaml",
      operations: apiOperations,
    },
    permissions: {
      matrixMarkdown: narrative.permissionsMatrixMarkdown.trim(),
    },
    validations,
    integrations,
    features: findingsDoc.features,
    gaps,
    assets: copiedFiles,
    quality: initialQuality,
  };

  const template = options?.templateContent ?? loadReportTemplate(options?.templatePath);
  const markdown = renderReportTemplate(template, indexDoc as unknown as Record<string, unknown>, {
    includedSections: ctx.manifest.report.include,
  });

  const corpusEntries = collectAntiCopyCorpus(ctx.evidence, jobId, allEvidences);
  const quality = verifyReportQuality({
    reportMarkdown: markdown,
    reportIndex: indexDoc,
    assetsDir,
    corpusEntries,
    validEvidenceIds,
    minCopyChars: options?.minCopyChars,
  });
  indexDoc.quality = quality;

  ctx.emit({
    type: "report_quality_checked",
    phase: phaseId,
    data: {
      ok: quality.ok,
      issuesCount: quality.issues.length,
      checkedRules: quality.checkedRules,
      checkedBlobs: quality.checkedBlobs,
      checkedAssets: quality.checkedAssets,
      checkedMermaidBlocks: quality.checkedMermaidBlocks,
    },
  });

  if (!quality.ok && options?.strictQuality !== false) {
    throw new ReportQualityError(
      `Verificação de qualidade do relatório falhou (${quality.issues.length} problema(s)): ${quality.issues.map((i) => i.message).join("; ")}`,
      { issues: quality.issues },
    );
  }

  mkdirSync(reportDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(reportPath, markdown, "utf8");
  writeFileSync(indexPath, `${JSON.stringify(indexDoc, null, 2)}\n`, "utf8");

  const stats: ReportStats = {
    modules: moduleSections.length,
    rules: findingsDoc.rules.length,
    entities: findingsDoc.domain.entities.length,
    stateMachines: stateMachines.length,
    flows: flows.length,
    apiOperations: apiOperations.length,
    validations: validations.length,
    integrations: integrations.length,
    assetsCopied: copiedFiles.length,
    qualityIssues: quality.issues.length,
  };

  ctx.saveCheckpoint({
    stage: "done",
    reportPath,
    indexPath,
    assetsCopied: copiedFiles.length,
    qualityOk: quality.ok,
  });

  ctx.emit({
    type: "report_generated",
    phase: phaseId,
    data: { reportPath, indexPath, ...stats },
  });

  return {
    reportPath,
    indexPath,
    assetsDir,
    markdown,
    index: indexDoc,
    quality,
    stats,
  };
}

export function createReportPhase(options?: ReportOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "report";
  return {
    id: phaseId,
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await runReportPhase(ctx, options);
      return { status: "ok", stats: result.stats };
    },
  };
}

export const reportPhase: Phase = createReportPhase();
