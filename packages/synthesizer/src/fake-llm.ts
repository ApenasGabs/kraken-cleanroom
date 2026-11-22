import {
  type BusinessRule,
  type EvidenceKind,
  FakeLlmClient,
  type FakeLlmClientOptions,
  type FakeLlmRequest,
  type FindingCategory,
} from "@cleanroom/core";
import type {
  ClusterModulesOutput,
  ConsolidateRulesOutput,
  ExtractFindingsOutput,
  InferBehaviorOutput,
  InferDomainOutput,
  ReportNarrativeOutput,
} from "./schemas.js";

interface PromptEvidenceEntry {
  id: string;
  kind: EvidenceKind | string;
  url?: string;
  stateId?: string;
  summary: string;
  data?: Record<string, unknown>;
}

interface PromptFindingEntry {
  id: string;
  module: string;
  category: FindingCategory;
  statement: string;
  confidence: "observed" | "inferred" | "hypothesis";
  evidenceIds: string[];
}

interface PromptModuleEntry {
  name: string;
  description: string;
  stateIds?: string[];
  endpoints?: string[];
  docSections?: string[];
  evidenceIds?: string[];
}

function parseLastUserJson(req: FakeLlmRequest): Record<string, unknown> {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const msg = req.messages[i];
    if (msg?.role !== "user") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(msg.content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignora mensagens não JSON
    }
  }
  return {};
}

function readPromptEvidences(payload: Record<string, unknown>): PromptEvidenceEntry[] {
  if (!Array.isArray(payload.evidences)) {
    return [];
  }
  const entries: PromptEvidenceEntry[] = [];
  for (const item of payload.evidences) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.length === 0) {
      continue;
    }
    entries.push({
      id: obj.id,
      kind: typeof obj.kind === "string" ? obj.kind : "http_response",
      ...(typeof obj.url === "string" ? { url: obj.url } : {}),
      ...(typeof obj.stateId === "string" ? { stateId: obj.stateId } : {}),
      summary: typeof obj.summary === "string" ? obj.summary : obj.id,
      ...(obj.data !== null && typeof obj.data === "object" && !Array.isArray(obj.data)
        ? { data: obj.data as Record<string, unknown> }
        : {}),
    });
  }
  return entries;
}

function inferModuleName(ev: PromptEvidenceEntry): string {
  const url = (ev.url ?? "").toLowerCase();
  const pathTemplate = typeof ev.data?.pathTemplate === "string" ? ev.data.pathTemplate : "";
  const combined = `${url} ${pathTemplate} ${ev.summary}`.toLowerCase();

  if (ev.kind === "pricing_plan" || combined.includes("/pricing") || combined.includes("plano")) {
    return "Planos e Assinatura";
  }
  if (combined.includes("/login") || combined.includes("/auth")) {
    return "Autenticação";
  }
  if (
    combined.includes("/projects") ||
    combined.includes("/api/projects") ||
    ev.kind === "form_schema" ||
    ev.kind === "form_probe"
  ) {
    return "Projetos";
  }
  if (ev.kind === "doc_section" || combined.includes("/help") || combined.includes("/docs")) {
    return "Documentação";
  }
  if (ev.kind === "robots" || combined.includes("/admin")) {
    return "Segurança e Escopo";
  }
  return "Geral";
}

function truncateClean(text: string, maxLen = 88): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLen - 3).trim()}...`;
}

function handleSynthesizeModules(payload: Record<string, unknown>): ClusterModulesOutput {
  const evidences = readPromptEvidences(payload);
  if (evidences.length === 0) {
    return { modules: [] };
  }

  const buckets = new Map<
    string,
    {
      stateIds: Set<string>;
      endpoints: Set<string>;
      docSections: Set<string>;
      evidenceIds: Set<string>;
    }
  >();

  for (const ev of evidences) {
    const modName = inferModuleName(ev);
    let bucket = buckets.get(modName);
    if (!bucket) {
      bucket = {
        stateIds: new Set(),
        endpoints: new Set(),
        docSections: new Set(),
        evidenceIds: new Set(),
      };
      buckets.set(modName, bucket);
    }
    bucket.evidenceIds.add(ev.id);
    if (ev.stateId) {
      bucket.stateIds.add(ev.stateId);
    }
    const pathTemplate = ev.data?.pathTemplate;
    if (typeof pathTemplate === "string" && pathTemplate.length > 0) {
      bucket.endpoints.add(pathTemplate);
    }
    if (ev.kind === "doc_section" && typeof ev.data?.heading === "string") {
      bucket.docSections.add(ev.data.heading);
    }
  }

  return {
    modules: [...buckets.entries()].map(([name, b]) => ({
      name,
      description: `Fluxos e comportamentos observados para o módulo ${name}.`,
      stateIds: [...b.stateIds],
      endpoints: [...b.endpoints],
      docSections: [...b.docSections],
      evidenceIds: [...b.evidenceIds],
    })),
  };
}

function summarizeEvidenceAsFinding(
  ev: PromptEvidenceEntry,
  moduleName: string,
): {
  category: FindingCategory;
  statement: string;
  confidence: "observed" | "inferred" | "hypothesis";
} {
  switch (ev.kind) {
    case "form_probe": {
      const field = typeof ev.data?.field === "string" ? ev.data.field : "campo";
      const status =
        typeof ev.data?.httpStatus === "number" ? `HTTP ${ev.data.httpStatus}` : "validação";
      return {
        category: "validation",
        statement: truncateClean(
          `Formulário valida ${field} e rejeita entrada inválida (${status}).`,
        ),
        confidence: "observed",
      };
    }
    case "form_schema": {
      const action = typeof ev.data?.action === "string" ? ev.data.action : "formulário";
      return {
        category: "validation",
        statement: truncateClean(`Formulário estruturado identificado para ${action}.`),
        confidence: "observed",
      };
    }
    case "pricing_plan": {
      const name = typeof ev.data?.displayName === "string" ? ev.data.displayName : "plano";
      const limit = ev.data?.projectLimit;
      const limitText =
        limit === "unlimited"
          ? "projetos ilimitados"
          : typeof limit === "number"
            ? `limite de ${limit} projetos`
            : "regras de capacidade";
      return {
        category: "pricing",
        statement: truncateClean(`Plano ${name} define ${limitText}.`),
        confidence: "observed",
      };
    }
    case "network_call": {
      const method = typeof ev.data?.method === "string" ? ev.data.method : "GET";
      const path = typeof ev.data?.pathTemplate === "string" ? ev.data.pathTemplate : "/api";
      const status = typeof ev.data?.status === "number" ? ev.data.status : 200;
      return {
        category: "feature",
        statement: truncateClean(`Endpoint ${method} ${path} responde com status ${status}.`),
        confidence: "observed",
      };
    }
    case "feature_flag": {
      const flag = typeof ev.data?.name === "string" ? ev.data.name : "feature";
      return {
        category: "permission",
        statement: truncateClean(
          `Feature flag ${flag} controla capacidade condicional na interface.`,
        ),
        confidence: "inferred",
      };
    }
    case "robots": {
      return {
        category: "permission",
        statement: "Política robots.txt delimita rotas públicas e administrativas.",
        confidence: "observed",
      };
    }
    case "doc_section": {
      const heading = typeof ev.data?.heading === "string" ? ev.data.heading : moduleName;
      return {
        category: "feature",
        statement: truncateClean(`Documentação descreve regras operacionais em "${heading}".`),
        confidence: "inferred",
      };
    }
    case "bundle_route": {
      const routePath = typeof ev.data?.path === "string" ? ev.data.path : "/";
      return {
        category: "feature",
        statement: truncateClean(`Bundle público referencia rota ${routePath}.`),
        confidence: "inferred",
      };
    }
    case "bundle_string": {
      const category = ev.data?.category === "error" ? "validation" : "ux";
      return {
        category,
        statement:
          category === "validation"
            ? "Bundle declara mensagem de erro de validação de entrada."
            : "Bundle expõe rótulo funcional da interface pública.",
        confidence: "inferred",
      };
    }
    default: {
      return {
        category: ev.kind === "state" || ev.kind === "transition" ? "state" : "feature",
        statement: truncateClean(`Comportamento observado em ${moduleName} (${ev.kind}).`),
        confidence: "observed",
      };
    }
  }
}

function handleSynthesizeFindings(payload: Record<string, unknown>): ExtractFindingsOutput {
  const mod =
    payload.module !== null && typeof payload.module === "object"
      ? (payload.module as PromptModuleEntry)
      : { name: "Geral", description: "" };
  const evidences = readPromptEvidences(payload);
  const findings: ExtractFindingsOutput["findings"] = [];
  const seenStatements = new Set<string>();

  for (const ev of evidences) {
    const item = summarizeEvidenceAsFinding(ev, mod.name);
    const dedupKey = `${mod.name}:${item.category}:${item.statement}`;
    if (seenStatements.has(dedupKey)) {
      continue;
    }
    seenStatements.add(dedupKey);
    findings.push({
      module: mod.name,
      category: item.category,
      statement: item.statement,
      confidence: item.confidence,
      evidenceIds: [ev.id],
    });
    if (findings.length >= 12) {
      break;
    }
  }

  return { findings };
}

function handleSynthesizeRules(payload: Record<string, unknown>): ConsolidateRulesOutput {
  const rawFindings = Array.isArray(payload.findings)
    ? (payload.findings as PromptFindingEntry[])
    : [];
  const rules: ConsolidateRulesOutput["rules"] = [];

  for (const f of rawFindings) {
    if (
      !f ||
      typeof f.id !== "string" ||
      !Array.isArray(f.evidenceIds) ||
      f.evidenceIds.length === 0
    ) {
      continue;
    }
    rules.push({
      module: f.module || "Geral",
      title: truncateClean(f.statement.replace(/\.$/, ""), 72),
      trigger: `Interação no módulo ${f.module || "Geral"}`,
      condition: `Categoria ${f.category} aplicável ao fluxo`,
      effect: truncateClean(f.statement, 88),
      confidence: f.confidence ?? "observed",
      findingIds: [f.id],
      evidenceIds: [...f.evidenceIds],
    });
  }

  return { rules };
}

function handleSynthesizeDomain(payload: Record<string, unknown>): InferDomainOutput {
  const evidences = readPromptEvidences(payload);
  if (evidences.length === 0) {
    return { entities: [] };
  }

  const attributesByName = new Map<
    string,
    { type: string; required: boolean; evidenceIds: Set<string> }
  >();

  for (const ev of evidences) {
    if (ev.kind === "form_schema" && Array.isArray(ev.data?.fields)) {
      for (const rawField of ev.data.fields) {
        if (rawField && typeof rawField === "object") {
          const f = rawField as Record<string, unknown>;
          if (typeof f.name === "string" && f.name.trim().length > 0) {
            const attrName = f.name.trim();
            const existing = attributesByName.get(attrName) ?? {
              type: typeof f.type === "string" ? f.type : "string",
              required: Boolean(f.required),
              evidenceIds: new Set<string>(),
            };
            existing.evidenceIds.add(ev.id);
            attributesByName.set(attrName, existing);
          }
        }
      }
    }
    if (ev.kind === "network_call" && ev.data?.reqShape && typeof ev.data.reqShape === "object") {
      for (const [k, v] of Object.entries(ev.data.reqShape as Record<string, unknown>)) {
        const existing = attributesByName.get(k) ?? {
          type: typeof v === "string" ? v : "string",
          required: false,
          evidenceIds: new Set<string>(),
        };
        existing.evidenceIds.add(ev.id);
        attributesByName.set(k, existing);
      }
    }
  }

  if (attributesByName.size === 0) {
    const first = evidences[0];
    if (!first) {
      return { entities: [] };
    }
    return {
      entities: [
        {
          name: "Recurso",
          attributes: [
            {
              name: "id",
              type: "string",
              required: true,
              notes: "Identificador inferido em modo fake",
              evidenceIds: [first.id],
            },
          ],
          relations: [],
        },
      ],
    };
  }

  return {
    entities: [
      {
        name: "Projeto",
        attributes: [...attributesByName.entries()].slice(0, 12).map(([name, info]) => ({
          name,
          type: info.type,
          required: info.required,
          evidenceIds: [...info.evidenceIds],
        })),
        relations: [],
      },
    ],
  };
}

function handleSynthesizeBehavior(payload: Record<string, unknown>): InferBehaviorOutput {
  const evidences = readPromptEvidences(payload);
  const firstId = evidences[0]?.id;
  if (!firstId) {
    return { stateMachines: [], flows: [] };
  }

  let statusStates: string[] = [];
  let statusEvidenceId = firstId;
  for (const ev of evidences) {
    const enums = ev.data?.safeEnumSamples;
    if (enums && typeof enums === "object" && !Array.isArray(enums)) {
      const st = (enums as Record<string, unknown>).status;
      if (Array.isArray(st) && st.length > 0) {
        statusStates = st.filter((x): x is string => typeof x === "string");
        statusEvidenceId = ev.id;
        break;
      }
    }
  }

  const stateMachines: InferBehaviorOutput["stateMachines"] =
    statusStates.length >= 2
      ? [
          {
            entity: "Projeto",
            states: statusStates,
            initialState: statusStates[0],
            terminalStates: [statusStates[statusStates.length - 1] ?? statusStates[0] ?? "done"],
            transitions: statusStates.slice(0, -1).map((fromState, idx) => ({
              from: fromState,
              to: statusStates[idx + 1] ?? fromState,
              trigger: `transicao_${idx + 1}`,
              evidenceIds: [statusEvidenceId],
            })),
            evidenceIds: [statusEvidenceId],
          },
        ]
      : [];

  const flows: InferBehaviorOutput["flows"] = [
    {
      name: "Fluxo Principal Observado",
      module: "Geral",
      description: "Sequência principal observada a partir das evidências coletadas.",
      steps: [
        {
          order: 1,
          actor: "Usuario",
          action: "Acessar aplicação alvo",
          outcome: "Estado inicial carregado conforme manifesto",
          evidenceIds: [firstId],
        },
      ],
      evidenceIds: [firstId],
    },
  ];

  return { stateMachines, flows };
}

function handleReportNarrative(payload: Record<string, unknown>): ReportNarrativeOutput {
  const productName =
    typeof payload.productFallbackName === "string" && payload.productFallbackName.trim().length > 0
      ? payload.productFallbackName.trim()
      : "Aplicação Analisada";

  const modules = Array.isArray(payload.modules) ? (payload.modules as PromptModuleEntry[]) : [];
  const findings = Array.isArray(payload.findings)
    ? (payload.findings as PromptFindingEntry[])
    : [];
  const rules = Array.isArray(payload.rules) ? (payload.rules as BusinessRule[]) : [];
  const pricing = Array.isArray(payload.pricing)
    ? (payload.pricing as Array<{ name?: string; price?: string; limits?: string }>)
    : [];

  const highlights = rules.slice(0, 5).map((r) => ({
    text: truncateClean(`${r.module}: ${r.title}`, 90),
    ruleIds: [r.id],
  }));

  const moduleSummaries = modules.map((mod) => {
    const modFindings = findings.filter(
      (f) => f.module.trim().toLowerCase() === mod.name.trim().toLowerCase(),
    );
    return {
      moduleName: mod.name,
      summary: truncateClean(
        mod.description || `Comportamento funcional sintetizado para ${mod.name}.`,
        95,
      ),
      features: modFindings.slice(0, 6).map((f) => ({
        name: f.category,
        description: truncateClean(f.statement, 88),
        confidence: f.confidence,
        evidenceIds: f.evidenceIds,
      })),
    };
  });

  const permissionsMatrixMarkdown =
    pricing.length > 0
      ? [
          "| Plano | Preço | Limites |",
          "|---|---|---|",
          ...pricing.map(
            (p) => `| ${p.name ?? "Plano"} | ${p.price ?? "-"} | ${p.limits ?? "-"} |`,
          ),
        ].join("\n")
      : "| Contexto | Capacidade | Restrição |\n|---|---|---|\n| Visitante | Fluxos públicos | Rotas administrativas fora de escopo |";

  return {
    productName,
    executiveNarrative: `Especificação clean room de ${productName} com ${modules.length} módulo(s) e ${rules.length} regra(s) rastreáveis.`,
    highlights,
    valueProposition: `Documentação comportamental estruturada de ${productName}.`,
    personas: [
      {
        name: "Usuário público",
        goal: "Utilizar as funcionalidades principais dentro dos limites operacionais.",
      },
    ],
    moduleSummaries,
    permissionsMatrixMarkdown,
    apiPurposes: [],
  };
}

/**
 * Registra handlers determinísticos no `FakeLlmClient` para que o pipeline completo
 * (`synthesize` + `report`) execute ponta a ponta quando `CLEANROOM_LLM_PROVIDER=fake`.
 */
export function registerSynthesizerFakeHandlers(client: FakeLlmClient): FakeLlmClient {
  client.registerHandler(
    (req) => req.opts?.schemaName === "synthesize_modules",
    (req) => handleSynthesizeModules(parseLastUserJson(req)),
  );
  client.registerHandler(
    (req) => req.opts?.schemaName === "synthesize_findings",
    (req) => handleSynthesizeFindings(parseLastUserJson(req)),
  );
  client.registerHandler(
    (req) => req.opts?.schemaName === "synthesize_rules",
    (req) => handleSynthesizeRules(parseLastUserJson(req)),
  );
  client.registerHandler(
    (req) => req.opts?.schemaName === "synthesize_domain",
    (req) => handleSynthesizeDomain(parseLastUserJson(req)),
  );
  client.registerHandler(
    (req) => req.opts?.schemaName === "synthesize_behavior",
    (req) => handleSynthesizeBehavior(parseLastUserJson(req)),
  );
  client.registerHandler(
    (req) => req.opts?.schemaName === "report_narrative",
    (req) => handleReportNarrative(parseLastUserJson(req)),
  );
  return client;
}

export function createSynthesizerFakeLlmClient(options?: FakeLlmClientOptions): FakeLlmClient {
  const client = new FakeLlmClient(options);
  return registerSynthesizerFakeHandlers(client);
}
