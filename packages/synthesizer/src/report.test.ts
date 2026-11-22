import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PHASE_ORDER,
  type Evidence,
  type EvidenceStore,
  FakeLlmClient,
  type FindingsDocument,
  type JobEvent,
  type JobRecord,
  type Manifest,
  type Phase,
  type PhaseContext,
  type ReportIndexDocument,
  ReportQualityError,
  type SqliteDatabase,
  createEvidenceStore,
  createJobService,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectAntiCopyCorpus,
  createReportPhase,
  createSynthesizePhase,
  findLiteralCopyViolations,
  generateErMermaid,
  generateFlowSequenceMermaid,
  generateStateMachineMermaid,
  loadReportTemplate,
  renderReportTemplate,
  runReportPhase,
  validateMarkdownMermaidBlocks,
  validateMermaidSyntax,
  verifyReportQuality,
} from "./index.js";

const DEMO_ORIGIN = "http://localhost:4173";

function buildManifest(includeSections?: Manifest["report"]["include"]): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-report-test",
      description: "Relatório clean room da demo-app.",
      goals: ["Validar criação de projeto", "Identificar limites Free vs Pro"],
    },
    target: {
      url: DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [DEMO_ORIGIN],
      docsUrls: [`${DEMO_ORIGIN}/help`, `${DEMO_ORIGIN}/pricing`],
    },
    ownership: "own",
    authorization: {
      basis: "Aplicação de demonstração própria para testes automatizados.",
      tosReviewed: true,
      evidence: null,
    },
    methods: {
      behavioralUi: true,
      networkHar: true,
      publicDocs: true,
      staticBundles: true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: 50,
      maxDepth: 4,
      maxDurationMin: 15,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["**/admin/**", "**/logout"],
      destructiveActions: false,
      formSubmission: "validation-only",
      respectRobotsTxt: true,
    },
    accounts: { strategy: "none" },
    humanInTheLoop: {
      captcha: "abort",
      smsOtp: "abort",
      payments: "abort",
      handoffTimeoutMin: 10,
    },
    cleanup: {
      deleteAccountAtEnd: false,
      purgeHarSecrets: true,
      retainDays: 30,
    },
    report: {
      language: "pt-BR",
      viewports: [[1440, 900]],
      ...(includeSections !== undefined ? { include: includeSections } : {}),
    },
  });
}

describe("@cleanroom/synthesizer — Fase 7 report", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-report-test-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignora se já fechado
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createTestContext(
    manifest: Manifest,
    llm: FakeLlmClient,
    opts?: { jobId?: string; events?: JobEvent[] },
  ): PhaseContext {
    const nowIso = "2026-11-22T04:00:00.000Z";
    const job: JobRecord = {
      id: opts?.jobId ?? "job_report_01",
      name: manifest.job.name,
      state: "running",
      manifest,
      createdAt: nowIso,
      updatedAt: nowIso,
      llmTokensIn: 0,
      llmTokensOut: 0,
    };

    return {
      job,
      manifest,
      guard: createScopeGuard(manifest, { sleep: async () => undefined }),
      evidence: evidenceStore,
      llm,
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: () => undefined,
      emit: (ev) => {
        opts?.events?.push(ev);
      },
    };
  }

  it("gera diagramas Mermaid válidos (erDiagram, stateDiagram-v2, sequenceDiagram) e rejeita sintaxe inválida", () => {
    const er = generateErMermaid([
      {
        name: "Projeto",
        attributes: [
          {
            name: "status",
            type: "enum(draft,active,archived)",
            required: true,
            evidenceIds: ["ev_1"],
          },
          { name: "budget", type: "number|unlimited", required: false, evidenceIds: ["ev_2"] },
        ],
        relations: [{ to: "Plano", kind: "1-n", evidenceIds: ["ev_3"] }],
      },
      {
        name: "Plano",
        attributes: [{ name: "tier", type: "string", required: true, evidenceIds: ["ev_3"] }],
        relations: [],
      },
    ]);
    expect(validateMermaidSyntax(er)).toMatchObject({ valid: true, kind: "erDiagram" });

    const sm = generateStateMachineMermaid({
      entity: "Projeto",
      states: ["Em rascunho", "Ativo", "Arquivado"],
      initialState: "Em rascunho",
      terminalStates: ["Arquivado"],
      transitions: [
        {
          from: "Em rascunho",
          to: "Ativo",
          trigger: "Ativar projeto: botão principal",
          guard: "usuário autorizado",
          evidenceIds: ["ev_1"],
        },
      ],
      evidenceIds: ["ev_1"],
    });
    expect(validateMermaidSyntax(sm)).toMatchObject({ valid: true, kind: "stateDiagram-v2" });

    const seq = generateFlowSequenceMermaid({
      name: "Criação de projeto",
      module: "Projetos",
      description: "Fluxo de criação",
      steps: [
        {
          order: 1,
          actor: "Usuário Final",
          action: "Submete formulário com dados válidos",
          outcome: "Retorna HTTP 201 e status draft",
          evidenceIds: ["ev_1"],
        },
      ],
      evidenceIds: ["ev_1"],
    });
    expect(validateMermaidSyntax(seq)).toMatchObject({ valid: true, kind: "sequenceDiagram" });

    // Negativos: sintaxe malformada deve falhar
    expect(validateMermaidSyntax("erDiagram\n  Projeto {\n    string nome\n").valid).toBe(false);
    expect(validateMermaidSyntax("erDiagram\n  Projeto <--> Plano : invalido").valid).toBe(false);
    expect(validateMermaidSyntax("stateDiagram-v2\n  draft -> active : seta_errada").valid).toBe(
      false,
    );
    expect(validateMermaidSyntax("sequenceDiagram\n  alt caso\n    User->>App: ok").valid).toBe(
      false,
    );
    expect(
      validateMarkdownMermaidBlocks("```mermaid\nerDiagram\n  A {\n    string x\n  }\n```").valid,
    ).toBe(true);
    expect(validateMarkdownMermaidBlocks("```mermaid\nerDiagram\n  A {\n").valid).toBe(false);
  });

  it("renderiza report-template.md tratando features vazia, validation ausente, tabelas e report.include", () => {
    const template = loadReportTemplate();
    const rendered = renderReportTemplate(
      template,
      {
        product: {
          name: "Demo App",
          valueProposition: "Gestão simples de projetos.",
          personas: [{ name: "Gestor", goal: "Criar e acompanhar projetos" }],
        },
        target: { url: DEMO_ORIGIN },
        job: {
          id: "job_1",
          finishedAt: "2026-11-22T04:00:00.000Z",
          durationMin: 1.2,
          llmTokensIn: 100,
          llmTokensOut: 50,
          phases: ["intake", "synthesize", "report"],
        },
        manifest: { ownership: "own", methodsEnabled: ["behavioralUi", "networkHar"] },
        coverage: {
          pagesVisited: 4,
          endpoints: 2,
          docSections: 3,
          limitsHit: "nenhum limite atingido",
        },
        stats: { rules: { total: 1, observed: 1, inferred: 0, hypothesis: 0 } },
        summary: {
          narrative: "Resumo executivo.",
          highlights: [{ text: "Validação de nome", ruleIds: ["BR-001"] }],
        },
        pricing: { plans: [] },
        modules: [
          {
            name: "Projetos",
            summary: "Cadastro | pipe e consulta.",
            features: [
              {
                name: "Criar | projeto",
                description: "Valida nome 3-60",
                confidence: "observed",
                evidenceIds: ["ev_1"],
              },
            ],
          },
        ],
        domain: {
          erMermaid: generateErMermaid([]),
          entities: [],
        },
        rules: [
          {
            id: "BR-001",
            module: "Projetos",
            title: "Nome obrigatório",
            trigger: "Ao submeter",
            condition: "Nome < 3 chars",
            effect: "Retorna 400",
            confidence: "observed",
            evidenceIds: ["ev_1"],
          },
        ],
        stateMachines: [],
        flows: [],
        api: { operations: [] },
        permissions: { matrixMarkdown: "| Papel | Permissão |\n|---|---|\n| Público | Leitura |" },
        validations: [],
        integrations: [],
        features: [],
        gaps: [],
      },
      {
        includedSections: ["executive-summary", "business-rules", "acceptance-criteria"],
      },
    );

    expect(rendered).toContain("# Relatório clean room: Demo App");
    expect(rendered).toContain("## 1. Sumário executivo");
    expect(rendered).toContain("## 5. Catálogo de regras de negócio");
    expect(rendered).toContain("## 12. Critérios de aceite");
    expect(rendered).toContain("Nenhum arquivo `.feature` gerado neste job");
    expect(rendered).not.toContain("(validação:");
    expect(rendered).not.toContain("## 3. Mapa funcional");
    expect(rendered).not.toContain("{{");
  });

  it("falha na verificação de qualidade quando regra não tem evidenceIds, screenshot está ausente ou há cópia >= 120 chars", () => {
    const jobId = "job_quality_checks";
    const literalDocText =
      "Este parágrafo longo da documentação pública descreve exatamente todos os detalhes internos do fluxo operacional da aplicação alvo para testar a detecção anti-cópia em cento e vinte caracteres.";
    expect(literalDocText.length).toBeGreaterThanOrEqual(120);

    const literalBundleText =
      "const internalValidationMessage = 'Mensagem literal muito longa extraída diretamente do bundle público da aplicação alvo que jamais deve ser reproduzida integralmente no relatório clean room gerado.';";
    expect(literalBundleText.length).toBeGreaterThanOrEqual(120);

    const docEv = evidenceStore.put({
      id: "ev_doc_copy",
      jobId,
      kind: "doc_section",
      phase: "analyze",
      summary: "Seção de documentação longa",
      blob: literalDocText,
      data: { heading: "Detalhes" },
    });
    const bundleEv = evidenceStore.put({
      id: "ev_bundle_copy",
      jobId,
      kind: "bundle_string",
      phase: "analyze",
      summary: "String longa do bundle",
      blob: literalBundleText,
      data: { text: literalBundleText },
    });

    const corpus = collectAntiCopyCorpus(evidenceStore, jobId);
    expect(corpus).toHaveLength(2);
    expect(findLiteralCopyViolations(`Resumo limpo.\n\n${literalDocText}`, corpus)).toHaveLength(1);
    expect(findLiteralCopyViolations(`Resumo limpo.\n\n${literalBundleText}`, corpus)).toHaveLength(
      1,
    );
    expect(findLiteralCopyViolations("Resumo totalmente parafraseado e curto.", corpus)).toEqual(
      [],
    );

    const assetsDir = join(tempDir, "assets_check");
    mkdirSync(assetsDir, { recursive: true });

    const qualityFail = verifyReportQuality({
      reportMarkdown: `# Relatório\n\n${literalDocText}\n\n![Tela](assets/missing.png)\n\n\`\`\`mermaid\nerDiagram\n  Bad {\n\`\`\``,
      reportIndex: {
        rules: [
          {
            id: "BR-001",
            module: "Projetos",
            title: "Regra órfã",
            trigger: "T",
            condition: "C",
            effect: "E",
            confidence: "observed",
            findingIds: [],
            evidenceIds: [],
          },
        ],
        domain: { erMermaid: generateErMermaid([]), entities: [] },
        stateMachines: [],
        flows: [],
        modules: [],
      },
      assetsDir,
      corpusEntries: corpus,
      validEvidenceIds: new Set([docEv.id, bundleEv.id]),
    });

    expect(qualityFail.ok).toBe(false);
    expect(qualityFail.issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        "rule_without_evidence",
        "anti_copy_violation",
        "missing_asset",
        "invalid_mermaid",
      ]),
    );
  });

  it("rejeita runReportPhase com ReportQualityError quando LLM injeta trecho literal >= 120 chars de evidência", async () => {
    const jobId = "job_anticopy_phase";
    const copiedBlob =
      "A plataforma de gestão de projetos aplica validação estrita de orçamento não-negativo e exige que a data de entrega informada seja posterior ao dia corrente em todas as requisições enviadas.";
    expect(copiedBlob.length).toBeGreaterThanOrEqual(120);

    const ev = evidenceStore.put({
      id: "ev_doc_long",
      jobId,
      kind: "doc_section",
      phase: "analyze",
      summary: "Documentação de projeto",
      blob: copiedBlob,
      data: { heading: "Regras" },
    });

    const findingsDoc: FindingsDocument = {
      version: 1,
      jobId,
      generatedAt: "2026-11-22T04:00:00.000Z",
      modules: [
        {
          name: "Projetos",
          description: "Cadastro de projetos.",
          stateIds: [],
          endpoints: [],
          docSections: ["Regras"],
          evidenceIds: [ev.id],
        },
      ],
      findings: [],
      rules: [
        {
          id: "BR-001",
          module: "Projetos",
          title: "Orçamento não-negativo",
          trigger: "Ao submeter projeto",
          condition: "Orçamento < 0",
          effect: "Rejeita com HTTP 400",
          confidence: "observed",
          findingIds: [],
          evidenceIds: [ev.id],
        },
      ],
      domain: { entities: [] },
      stateMachines: [],
      flows: [],
      features: [],
      stats: {
        modules: 1,
        findings: 0,
        rules: 1,
        entities: 0,
        stateMachines: 0,
        flows: 0,
        unsupportedClaimsDiscarded: 0,
        totalClaimsEvaluated: 1,
        discardRatePercent: 0,
      },
    };

    const llm = new FakeLlmClient({
      fixtures: {
        report_narrative: {
          productName: "Demo App",
          executiveNarrative: copiedBlob,
          highlights: [{ text: "Validação de orçamento", ruleIds: ["BR-001"] }],
          valueProposition: "Gestão de projetos.",
          personas: [],
          moduleSummaries: [],
          permissionsMatrixMarkdown: "| Papel | Permissão |\n|---|---|\n| Público | Leitura |",
          apiPurposes: [],
        },
      },
    });

    const ctx = createTestContext(buildManifest(), llm, { jobId });
    await expect(runReportPhase(ctx, { findingsDocument: findingsDoc })).rejects.toBeInstanceOf(
      ReportQualityError,
    );
  });

  it("integra Fase 5 (synthesize) + Fase 7 (report) no JobRunner, copia screenshots e serve report.md e index.json via JobService.getReport", async () => {
    const manifest = buildManifest();
    const manifestYaml = [
      "version: 1",
      "job:",
      "  name: demo-runner-report",
      "  goals: ['Gerar relatório e index.json']",
      "target:",
      `  url: ${DEMO_ORIGIN}`,
      "  type: web-ssr",
      `  allowedOrigins: [${DEMO_ORIGIN}]`,
      "ownership: own",
      "authorization:",
      "  basis: Aplicação própria para testes do pipeline completo.",
      "  tosReviewed: true",
      "  evidence: null",
    ].join("\n");

    const llm = new FakeLlmClient({
      handlers: [
        {
          matcher: "synthesize_modules",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              evidences: Array<{ id: string }>;
            };
            return {
              data: {
                modules: [
                  {
                    name: "Projetos",
                    description: "Criação e acompanhamento de projetos.",
                    stateIds: ["st_projects"],
                    endpoints: ["/api/projects"],
                    docSections: [],
                    evidenceIds: payload.evidences.map((e) => e.id),
                  },
                ],
              },
              usage: { tokensIn: 100, tokensOut: 40 },
            };
          },
        },
        {
          matcher: "synthesize_findings",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              evidences: Array<{ id: string }>;
            };
            return {
              data: {
                findings: [
                  {
                    module: "Projetos",
                    category: "validation",
                    statement: "Nome do projeto exige entre 3 e 60 caracteres.",
                    confidence: "observed",
                    evidenceIds: payload.evidences.map((e) => e.id),
                  },
                ],
              },
              usage: { tokensIn: 110, tokensOut: 40 },
            };
          },
        },
        {
          matcher: "synthesize_rules",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              findings: Array<{ id: string; evidenceIds: string[] }>;
            };
            return {
              data: {
                rules: [
                  {
                    module: "Projetos",
                    title: "Tamanho de nome obrigatório",
                    trigger: "Ao criar projeto",
                    condition: "Nome fora de 3-60 caracteres",
                    effect: "Retorna HTTP 400",
                    confidence: "observed",
                    findingIds: payload.findings.map((f) => f.id),
                    evidenceIds: payload.findings[0]?.evidenceIds ?? [],
                  },
                ],
              },
              usage: { tokensIn: 80, tokensOut: 30 },
            };
          },
        },
        {
          matcher: "synthesize_domain",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              evidences: Array<{ id: string }>;
            };
            return {
              data: {
                entities: [
                  {
                    name: "Project",
                    attributes: [
                      {
                        name: "name",
                        type: "string",
                        required: true,
                        evidenceIds: payload.evidences.map((e) => e.id),
                      },
                    ],
                    relations: [],
                  },
                ],
              },
              usage: { tokensIn: 50, tokensOut: 20 },
            };
          },
        },
        {
          matcher: "synthesize_behavior",
          handler: () => ({
            data: { stateMachines: [], flows: [] },
            usage: { tokensIn: 40, tokensOut: 10 },
          }),
        },
        {
          matcher: "report_narrative",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              modules: Array<{ evidenceIds: string[] }>;
            };
            const evIds = payload.modules[0]?.evidenceIds ?? [];
            return {
              data: {
                productName: "Demo App",
                executiveNarrative: "Aplicação de gestão de projetos com validação de entrada.",
                highlights: [{ text: "Validação de tamanho do nome", ruleIds: ["BR-001"] }],
                valueProposition: "Organização simples de projetos em equipe.",
                personas: [{ name: "Criador", goal: "Cadastrar projetos válidos" }],
                moduleSummaries: [
                  {
                    moduleName: "Projetos",
                    summary: "Fluxos de criação e consulta de projetos.",
                    features: [
                      {
                        name: "Validação de nome",
                        description: "Bloqueia nomes curtos ou longos demais.",
                        confidence: "observed",
                        evidenceIds: evIds,
                      },
                    ],
                  },
                ],
                permissionsMatrixMarkdown:
                  "| Papel | Permissões | Restrições |\n|---|---|---|\n| Usuário | Criar projeto | Sem acesso a /admin |",
                apiPurposes: [
                  { method: "GET", path: "/api/projects", purpose: "Listar projetos paginados" },
                ],
              },
              usage: { tokensIn: 60, tokensOut: 35 },
            };
          },
        },
      ],
    });

    let capturedShotFilename = "";
    const synthPhase = createSynthesizePhase();
    const repPhase = createReportPhase();
    const phases: Phase[] = DEFAULT_PHASE_ORDER.map((id) => {
      if (id === "explore") {
        return {
          id,
          async run(ctx) {
            const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]);
            const shot = ctx.evidence.put({
              jobId: ctx.job.id,
              kind: "screenshot",
              phase: "explore",
              stateId: "st_projects",
              url: `${DEMO_ORIGIN}/projects`,
              blob: fakePng,
              summary: "Screenshot 1440x900 da listagem de projetos",
              data: { width: 1440, height: 900, viewport: "1440x900", stateId: "st_projects" },
            });
            capturedShotFilename = `${shot.sha256}.png`;
            ctx.evidence.put({
              jobId: ctx.job.id,
              kind: "state",
              phase: "explore",
              stateId: "st_projects",
              url: `${DEMO_ORIGIN}/projects`,
              summary: "Estado listagem de projetos",
              data: { url: `${DEMO_ORIGIN}/projects` },
            });
            ctx.evidence.put({
              jobId: ctx.job.id,
              kind: "form_probe",
              phase: "explore",
              url: `${DEMO_ORIGIN}/projects/new`,
              summary: "Probe campo name retorna 400",
              data: { field: "name", code: "NAME_LENGTH_INVALID", httpStatus: 400 },
            });
            return { status: "ok", stats: { states: 1 } };
          },
        };
      }
      if (id === "analyze") {
        return {
          id,
          async run(ctx) {
            const netEv = ctx.evidence.put({
              jobId: ctx.job.id,
              kind: "network_call",
              phase: "capture",
              url: `${DEMO_ORIGIN}/api/projects?page=1`,
              summary: "GET /api/projects retorna lista paginada",
              data: { method: "GET", pathTemplate: "/api/projects", status: 200 },
            });
            const jobDir = ctx.evidence.resolveJobDir(ctx.job.id);
            mkdirSync(join(jobDir, "analysis"), { recursive: true });
            writeFileSync(
              join(jobDir, "analysis", "openapi.yaml"),
              `openapi: "3.1.0"\ninfo:\n  title: Demo API\n  version: "0.1.0"\npaths:\n  /api/projects:\n    get:\n      summary: Listar projetos\n      x-cleanroom-evidence:\n        - ${netEv.id}\n`,
              "utf8",
            );
            return { status: "ok", stats: { endpoints: 1 } };
          },
        };
      }
      if (id === "synthesize") return synthPhase;
      if (id === "report") return repPhase;
      return {
        id,
        async run() {
          return { status: "ok", stats: {} };
        },
      };
    });

    const svc = createJobService({ db, dataDir: tempDir, phases, llm });
    const { jobId } = await svc.start(manifestYaml);
    const finished = await svc.waitForJob(jobId);

    expect(finished.state).toBe("completed");
    expect(finished.llmTokensIn).toBe(440);
    expect(finished.llmTokensOut).toBe(175);

    const md = await svc.getReport(jobId, "markdown");
    const jsonRaw = await svc.getReport(jobId, "json");
    const indexDoc = JSON.parse(jsonRaw) as ReportIndexDocument;

    expect(md).toContain("# Relatório clean room: Demo App");
    expect(md).toContain(`![Projetos](assets/${capturedShotFilename})`);
    expect(md).toContain("Listar projetos paginados");
    expect(md).toContain("BR-001: Tamanho de nome obrigatório");

    expect(indexDoc.version).toBe(1);
    expect(indexDoc.assets).toContain(capturedShotFilename);
    expect(indexDoc.quality.ok).toBe(true);
    expect(existsSync(join(tempDir, "jobs", jobId, "report", "assets", capturedShotFilename))).toBe(
      true,
    );
    expect(existsSync(join(tempDir, "jobs", jobId, "report", "index.json"))).toBe(true);

    const events = svc.store.listEvents(jobId);
    expect(events.some((e) => e.type === "report_quality_checked")).toBe(true);
    expect(events.some((e) => e.type === "report_generated")).toBe(true);

    // Garante que todo Evidence usado é válido
    const allEv = svc.evidence.listAll(jobId);
    expect(allEv.length).toBeGreaterThanOrEqual(4);
    const firstEv: Evidence | undefined = allEv[0];
    expect(firstEv).toBeDefined();
  });
});
