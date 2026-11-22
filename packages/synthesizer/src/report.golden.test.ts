import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EvidenceStore,
  FakeLlmClient,
  type FindingsDocument,
  type JobRecord,
  type Manifest,
  type PhaseContext,
  type SqliteDatabase,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReportPhase, validateMarkdownMermaidBlocks } from "./index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEMO_ORIGIN = "http://localhost:4173";

function buildDemoManifest(): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-app-golden",
      description: "Estudo clean room completo da aplicação de demonstração.",
      goals: [
        "Mapear validações do formulário de criação de projeto",
        "Identificar limites do plano Free vs Pro",
        "Extrair máquina de estados do projeto",
      ],
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
      maxDepth: 5,
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
    },
  });
}

describe("@cleanroom/synthesizer — Golden test report.md e index.json (demo-app)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-report-golden-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignora
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("gera report.md e index.json determinísticos correspondentes aos snapshots golden da demo-app", async () => {
    const jobId = "job_demo_golden_01";
    const manifest = buildDemoManifest();
    const createdAt = "2026-11-22T03:58:30.000Z";
    const finishedAt = "2026-11-22T04:00:00.000Z";

    // Evidências determinísticas simulando saída das fases intake, explore, capture e analyze
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const evRobots = evidenceStore.put({
      id: "ev_demo_01_robots",
      jobId,
      kind: "robots",
      phase: "intake",
      url: `${DEMO_ORIGIN}/robots.txt`,
      summary: "robots.txt bloqueia /admin e /logout",
      blob: "User-agent: *\nDisallow: /admin\nDisallow: /logout\n",
      data: { disallow: ["/admin", "/logout"] },
    });
    const evStateProjects = evidenceStore.put({
      id: "ev_demo_02_state",
      jobId,
      kind: "state",
      phase: "explore",
      stateId: "st_projects_list",
      url: `${DEMO_ORIGIN}/projects`,
      summary: "Estado listagem de projetos",
      data: { title: "Projetos" },
    });
    const evShot = evidenceStore.put({
      id: "ev_demo_03_shot",
      jobId,
      kind: "screenshot",
      phase: "explore",
      stateId: "st_projects_list",
      url: `${DEMO_ORIGIN}/projects`,
      blob: pngBytes,
      summary: "Screenshot 1440x900 da listagem de projetos",
      data: { width: 1440, height: 900, viewport: "1440x900", stateId: "st_projects_list" },
    });
    const evProbeName = evidenceStore.put({
      id: "ev_demo_04_probe_name",
      jobId,
      kind: "form_probe",
      phase: "explore",
      url: `${DEMO_ORIGIN}/projects/new`,
      summary: "Probe nome curto retorna HTTP 400 (NAME_LENGTH_INVALID)",
      data: {
        formId: "/projects/new",
        field: "name",
        code: "NAME_LENGTH_INVALID",
        observedMessage: "O nome do projeto deve ter entre 3 e 60 caracteres.",
        httpStatus: 400,
      },
    });
    const evProbeBudget = evidenceStore.put({
      id: "ev_demo_05_probe_budget",
      jobId,
      kind: "form_probe",
      phase: "explore",
      url: `${DEMO_ORIGIN}/projects/new`,
      summary: "Probe orçamento negativo retorna HTTP 400 (BUDGET_MIN_ZERO)",
      data: {
        formId: "/projects/new",
        field: "budget",
        code: "BUDGET_MIN_ZERO",
        observedMessage: "O orçamento deve ser maior ou igual a 0.",
        httpStatus: 400,
      },
    });
    const evNetList = evidenceStore.put({
      id: "ev_demo_06_net_list",
      jobId,
      kind: "network_call",
      phase: "capture",
      url: `${DEMO_ORIGIN}/api/projects?page=1`,
      summary: "GET /api/projects paginado (pageSize=2) e enum status",
      data: { method: "GET", pathTemplate: "/api/projects", status: 200 },
    });
    const evPricing = evidenceStore.put({
      id: "ev_demo_07_pricing",
      jobId,
      kind: "pricing_plan",
      phase: "analyze",
      url: `${DEMO_ORIGIN}/pricing`,
      summary: "Planos Free (3 projetos) e Pro (ilimitado)",
      data: {
        plans: [
          { name: "Free", price: "R$ 0/mês", projectLimit: 3 },
          { name: "Pro", price: "R$ 49/mês", projectLimit: "unlimited" },
        ],
      },
    });
    const evDocHelp = evidenceStore.put({
      id: "ev_demo_08_doc",
      jobId,
      kind: "doc_section",
      phase: "analyze",
      url: `${DEMO_ORIGIN}/help`,
      summary: "Documentação sobre criação de projetos e estados",
      blob: "Esta documentação de ajuda explica os limites operacionais do sistema demo-app para criação de projetos, validações de orçamento positivo e prazos futuros, além do ciclo completo entre os estados draft, active e archived.",
      data: { heading: "Ajuda de Projetos" },
    });
    const evFlag = evidenceStore.put({
      id: "ev_demo_09_flag",
      jobId,
      kind: "feature_flag",
      phase: "analyze",
      url: `${DEMO_ORIGIN}/static/app.js`,
      summary: "Feature flag pro_export detectada no bundle público",
      data: { name: "pro_export", defaultValue: false },
    });

    const jobDir = evidenceStore.resolveJobDir(jobId);
    mkdirSync(join(jobDir, "analysis"), { recursive: true });
    writeFileSync(
      join(jobDir, "analysis", "openapi.yaml"),
      [
        'openapi: "3.1.0"',
        "info:",
        "  title: demo-app-golden",
        '  version: "0.1.0"',
        "paths:",
        "  /api/projects:",
        "    get:",
        "      summary: Lista projetos paginados",
        "      x-cleanroom-evidence:",
        `        - ${evNetList.id}`,
        "    post:",
        "      summary: Cria um novo projeto",
        "      x-cleanroom-evidence:",
        `        - ${evProbeName.id}`,
      ].join("\n"),
      "utf8",
    );

    mkdirSync(join(jobDir, "graph"), { recursive: true });
    writeFileSync(
      join(jobDir, "graph", "state-graph.json"),
      JSON.stringify({
        nodes: [{ id: "st_projects_list" }, { id: "st_projects_new" }],
        stats: { pagesVisited: 2, skippedOutOfScope: 1, skippedDestructive: 1 },
      }),
      "utf8",
    );

    const findingsDoc: FindingsDocument = {
      version: 1,
      jobId,
      generatedAt: finishedAt,
      modules: [
        {
          name: "Projetos",
          description: "Criação, listagem paginada e ciclo de vida de projetos.",
          stateIds: ["st_projects_list"],
          endpoints: ["/api/projects"],
          docSections: ["Ajuda de Projetos"],
          evidenceIds: [
            evStateProjects.id,
            evShot.id,
            evProbeName.id,
            evProbeBudget.id,
            evNetList.id,
          ],
        },
        {
          name: "Faturamento e Planos",
          description: "Limites do plano Free e recursos do plano Pro.",
          stateIds: [],
          endpoints: [],
          docSections: [],
          evidenceIds: [evPricing.id, evFlag.id],
        },
      ],
      findings: [
        {
          id: "fd_demo_01",
          jobId,
          module: "Projetos",
          category: "validation",
          statement: "Nome do projeto é obrigatório e deve ter entre 3 e 60 caracteres.",
          confidence: "observed",
          evidenceIds: [evProbeName.id, evDocHelp.id],
          fingerprint: "fp_01",
        },
        {
          id: "fd_demo_02",
          jobId,
          module: "Faturamento e Planos",
          category: "limit",
          statement: "Plano Free restringe a conta a 3 projetos ativos ou em rascunho.",
          confidence: "hypothesis",
          evidenceIds: [evPricing.id],
          fingerprint: "fp_02",
        },
      ],
      rules: [
        {
          id: "BR-001",
          module: "Faturamento e Planos",
          title: "Limite do Plano Free (3 projetos não arquivados)",
          trigger: "Ao tentar criar um projeto no plano Free",
          condition: "Conta já possui 3 projetos em draft ou active",
          effect: "Criação é bloqueada com HTTP 422",
          confidence: "hypothesis",
          findingIds: ["fd_demo_02"],
          evidenceIds: [evPricing.id],
        },
        {
          id: "BR-002",
          module: "Projetos",
          title: "Validação de tamanho do nome (3 a 60 caracteres)",
          trigger: "Ao submeter criação de projeto",
          condition: "Nome vazio ou fora da faixa de 3 a 60 caracteres",
          effect: "Requisição rejeitada com HTTP 400 NAME_LENGTH_INVALID",
          confidence: "observed",
          findingIds: ["fd_demo_01"],
          evidenceIds: [evProbeName.id, evDocHelp.id],
        },
        {
          id: "BR-003",
          module: "Projetos",
          title: "Orçamento não-negativo (budget >= 0)",
          trigger: "Ao submeter criação de projeto",
          condition: "Orçamento menor que zero",
          effect: "Requisição rejeitada com HTTP 400 BUDGET_MIN_ZERO",
          confidence: "observed",
          findingIds: [],
          evidenceIds: [evProbeBudget.id],
        },
      ],
      domain: {
        entities: [
          {
            name: "Project",
            attributes: [
              { name: "name", type: "string", required: true, evidenceIds: [evProbeName.id] },
              { name: "budget", type: "number", required: true, evidenceIds: [evProbeBudget.id] },
              {
                name: "status",
                type: "enum(draft,active,archived)",
                required: true,
                evidenceIds: [evNetList.id],
              },
            ],
            relations: [{ to: "Plan", kind: "1-n", evidenceIds: [evPricing.id] }],
          },
          {
            name: "Plan",
            attributes: [
              { name: "tier", type: "enum(free,pro)", required: true, evidenceIds: [evPricing.id] },
              {
                name: "projectLimit",
                type: "number|unlimited",
                required: true,
                evidenceIds: [evPricing.id],
              },
            ],
            relations: [],
          },
        ],
      },
      stateMachines: [
        {
          entity: "Project",
          states: ["draft", "active", "archived"],
          initialState: "draft",
          terminalStates: ["archived"],
          transitions: [
            {
              from: "draft",
              to: "active",
              trigger: "Ativar projeto",
              evidenceIds: [evNetList.id],
            },
            {
              from: "active",
              to: "archived",
              trigger: "Arquivar projeto",
              evidenceIds: [evNetList.id],
            },
          ],
          evidenceIds: [evNetList.id],
        },
      ],
      flows: [
        {
          name: "Criação e validação de projeto",
          module: "Projetos",
          description: "Usuário preenche o formulário de novo projeto e recebe validação imediata.",
          steps: [
            {
              order: 1,
              actor: "Usuário",
              action: "Preenche nome e orçamento em /projects/new",
              outcome: "Sistema valida tamanho do nome e orçamento não-negativo",
              evidenceIds: [evProbeName.id, evProbeBudget.id],
            },
            {
              order: 2,
              actor: "Usuário",
              action: "Consulta listagem paginada de projetos",
              outcome: "API retorna página com status e metadados",
              evidenceIds: [evNetList.id],
            },
          ],
          evidenceIds: [evProbeName.id, evNetList.id],
        },
      ],
      features: [],
      stats: {
        modules: 2,
        findings: 2,
        rules: 3,
        entities: 2,
        stateMachines: 1,
        flows: 1,
        unsupportedClaimsDiscarded: 0,
        totalClaimsEvaluated: 9,
        discardRatePercent: 0,
      },
    };

    const llm = new FakeLlmClient({
      fixtures: {
        report_narrative: {
          data: {
            productName: "Demo App",
            executiveNarrative:
              "Aplicação web voltada à gestão de projetos com validações estritas de entrada, máquina de estados de ciclo de vida e limites por plano de assinatura.",
            highlights: [
              {
                text: "Formulário de projetos valida tamanho do nome e orçamento não-negativo",
                ruleIds: ["BR-002", "BR-003"],
              },
              {
                text: "Plano Free limita projetos ativos enquanto o Pro libera criação ilimitada",
                ruleIds: ["BR-001"],
              },
            ],
            valueProposition:
              "Permite cadastrar, acompanhar e arquivar projetos conforme cotas do plano contratado.",
            personas: [
              { name: "Usuário Free", goal: "Gerenciar até 3 projetos não arquivados" },
              { name: "Usuário Pro", goal: "Criar projetos ilimitados e usar pro_export" },
            ],
            moduleSummaries: [
              {
                moduleName: "Projetos",
                summary: "Gerencia listagem paginada, criação validada e transições de status.",
                features: [
                  {
                    name: "Criação validada",
                    description: "Valida nome (3-60) e orçamento não-negativo no servidor.",
                    confidence: "observed",
                    evidenceIds: [evProbeName.id, evProbeBudget.id],
                  },
                ],
              },
              {
                moduleName: "Faturamento e Planos",
                summary: "Define cotas de projetos por plano e habilita exportação Pro.",
                features: [
                  {
                    name: "Cota Free vs Pro",
                    description: "Free permite 3 projetos; Pro remove o teto e libera pro_export.",
                    confidence: "hypothesis",
                    evidenceIds: [evPricing.id, evFlag.id],
                  },
                ],
              },
            ],
            permissionsMatrixMarkdown: [
              "| Papel / Plano | Permissões observadas | Restrições | Evidência |",
              "|---|---|---|---|",
              `| Usuário Free | Criar até 3 projetos | Sem acesso a /admin | ${evPricing.id}, ${evRobots.id} |`,
              `| Usuário Pro | Projetos ilimitados e pro_export | Sem acesso a /admin | ${evPricing.id}, ${evFlag.id} |`,
            ].join("\n"),
            apiPurposes: [
              {
                method: "GET",
                path: "/api/projects",
                purpose: "Lista projetos paginados com pageSize padrão 2",
              },
              {
                method: "POST",
                path: "/api/projects",
                purpose: "Cria projeto após validar nome, orçamento e cota",
              },
            ],
          },
          usage: { tokensIn: 320, tokensOut: 140 },
        },
      },
    });

    const job: JobRecord = {
      id: jobId,
      name: manifest.job.name,
      state: "running",
      manifest,
      createdAt,
      updatedAt: finishedAt,
      llmTokensIn: 500,
      llmTokensOut: 200,
    };

    const ctx: PhaseContext = {
      job,
      manifest,
      guard: createScopeGuard(manifest, { sleep: async () => undefined }),
      evidence: evidenceStore,
      llm,
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: () => undefined,
      emit: () => undefined,
    };

    const result = await runReportPhase(ctx, {
      findingsDocument: findingsDoc,
      finishedAt,
      durationMin: 1.5,
    });

    expect(result.quality.ok).toBe(true);
    expect(validateMarkdownMermaidBlocks(result.markdown)).toEqual({
      valid: true,
      blockCount: 3,
      errors: [],
    });

    const goldenDir = resolve(here, "../test/golden");
    const goldenMdPath = join(goldenDir, "demo-app-report.golden.md");
    const goldenJsonPath = join(goldenDir, "demo-app-report.golden.json");

    await expect(result.markdown).toMatchFileSnapshot(goldenMdPath);
    expect(existsSync(goldenJsonPath)).toBe(true);
    expect(JSON.parse(readFileSync(result.indexPath, "utf8"))).toEqual(
      JSON.parse(readFileSync(goldenJsonPath, "utf8")),
    );
  });
});
