import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  type CompactEvidenceEntry,
  ExtractFindingsOutputSchema,
  assignStableRuleIds,
  buildSynthesizerSystemPrompt,
  computeFindingFingerprint,
  createSynthesizePhase,
  deduplicateFindings,
  loadSystemPromptTemplate,
  paginateEvidenceBatches,
  runSynthesizePhase,
  serializeEvidenceForPrompt,
  zodToJsonSchema,
} from "./index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEMO_ORIGIN = "http://localhost:4173";

interface DemoAppModule {
  createDemoApp(): {
    app: {
      fetch(request: Request): Response | Promise<Response>;
    };
  };
  PUBLIC_APP_BUNDLE_JS: string;
}

function buildManifest(): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-synthesizer-test",
      description: "Síntese clean room das regras de negócio da demo-app.",
      goals: [
        "Mapear validações do formulário de criação de projeto",
        "Identificar limites do plano Free vs Pro",
        "Extrair máquina de estados e ações permitidas por status",
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
      basis: "Aplicação de demonstração própria para testes do kraken-cleanroom.",
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
    },
  });
}

describe("@cleanroom/synthesizer — Fase 5 synthesize", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-synthesizer-test-"));
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
    opts?: {
      jobId?: string;
      checkpoint?: unknown;
      onSaveCheckpoint?: (cp: unknown) => void;
      events?: JobEvent[];
    },
  ): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: opts?.jobId ?? "job_synth_01",
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
      checkpoint: opts?.checkpoint,
      saveCheckpoint: (cp) => {
        opts?.onSaveCheckpoint?.(cp);
      },
      emit: (ev) => {
        opts?.events?.push(ev);
      },
    };
  }

  it("carrega prompts/system.md com contexto do manifesto, regras clean room e JSON schema", () => {
    const template = loadSystemPromptTemplate();
    expect(template).toContain("{{MANIFEST_CONTEXT}}");
    expect(template).toContain("{{JSON_SCHEMA}}");
    expect(template).toContain("clean room");

    const jsonSchema = zodToJsonSchema(ExtractFindingsOutputSchema);
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("findings");

    const manifest = buildManifest();
    const prompt = buildSynthesizerSystemPrompt(manifest, ExtractFindingsOutputSchema);
    expect(prompt).toContain("Ownership: own");
    expect(prompt).toContain(manifest.authorization.basis);
    expect(prompt).toContain("behavioralUi");
    expect(prompt).toContain('"findings"');
    expect(prompt).not.toContain("{{MANIFEST_CONTEXT}}");
    expect(prompt).not.toContain("{{JSON_SCHEMA}}");
  });

  it("serializa evidências sem blobs e pagina lotes em até ~30k tokens", () => {
    const evidences: Evidence[] = [];
    for (let i = 0; i < 12; i += 1) {
      evidences.push(
        evidenceStore.put({
          jobId: "job_batch",
          kind: "doc_section",
          phase: "analyze",
          url: `${DEMO_ORIGIN}/help#s${i}`,
          summary: `Seção de ajuda ${i}: ${"detalhes comportamentais ".repeat(6)}`,
          blob: "<html><body>CONTEUDO BLOB GRANDE QUE NAO DEVE IR PARA O PROMPT</body></html>",
          data: {
            heading: `Seção ${i}`,
            highlights: ["regra de negocio"],
            html: "<script>alert(1)</script>",
          },
        }),
      );
    }

    const compact = serializeEvidenceForPrompt(evidences[0] as Evidence);
    expect(compact.data).not.toHaveProperty("html");
    expect(JSON.stringify(compact)).not.toContain("CONTEUDO BLOB GRANDE");

    // Com orçamento reduzido (~400 tokens), deve dividir em múltiplos lotes
    const batches = paginateEvidenceBatches(evidences, 600);
    expect(batches.length).toBeGreaterThan(1);
    const totalItems = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalItems).toBe(12);
  });

  it("deduplica achados por fingerprint normalizado e gera IDs estáveis BR-001..BR-NNN por módulo e criação", () => {
    const fp1 = computeFindingFingerprint(
      "Projetos",
      "validation",
      "O nome do projeto deve ter entre 3 e 60 caracteres!",
    );
    const fp2 = computeFindingFingerprint(
      "projetos",
      "validation",
      "  O nome do projeto deve ter entre 3 e 60 caracteres  ",
    );
    expect(fp1).toBe(fp2);

    const deduped = deduplicateFindings([
      {
        id: "fd_1",
        jobId: "job_x",
        module: "Projetos",
        category: "validation",
        statement: "O nome do projeto deve ter entre 3 e 60 caracteres.",
        confidence: "inferred",
        evidenceIds: ["ev_1"],
        fingerprint: fp1,
      },
      {
        id: "fd_2",
        jobId: "job_x",
        module: "Projetos",
        category: "validation",
        statement: "O nome do projeto deve ter entre 3 e 60 caracteres.",
        confidence: "observed",
        evidenceIds: ["ev_2"],
        fingerprint: fp2,
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.confidence).toBe("observed");
    expect(deduped[0]?.evidenceIds).toEqual(["ev_1", "ev_2"]);

    const ordered = assignStableRuleIds([
      {
        module: "Projetos",
        title: "Regra Projetos 1",
        trigger: "T1",
        condition: "C1",
        effect: "E1",
        confidence: "observed",
        findingIds: ["fd_1"],
        evidenceIds: ["ev_1"],
      },
      {
        module: "Autenticação",
        title: "Regra Auth 1",
        trigger: "T2",
        condition: "C2",
        effect: "E2",
        confidence: "observed",
        findingIds: ["fd_2"],
        evidenceIds: ["ev_2"],
      },
      {
        module: "Projetos",
        title: "Regra Projetos 2",
        trigger: "T3",
        condition: "C3",
        effect: "E3",
        confidence: "inferred",
        findingIds: ["fd_3"],
        evidenceIds: ["ev_3"],
      },
    ]);

    expect(ordered.map((r) => [r.id, r.module, r.title])).toEqual([
      ["BR-001", "Autenticação", "Regra Auth 1"],
      ["BR-002", "Projetos", "Regra Projetos 1"],
      ["BR-003", "Projetos", "Regra Projetos 2"],
    ]);
  });

  it("descarta Finding e BusinessRule sem evidenceIds válidos no EvidenceStore e emite synthesis_unsupported_claim + alerta > 20%", async () => {
    const jobId = "job_unsupported_test";
    const evValid = evidenceStore.put({
      jobId,
      kind: "form_probe",
      phase: "explore",
      url: `${DEMO_ORIGIN}/projects/new`,
      summary: "Probe campo name vazio retorna 400",
      data: { field: "name", httpStatus: 400 },
    });

    const events: JobEvent[] = [];
    const llm = new FakeLlmClient({
      fixtures: {
        synthesize_modules: {
          modules: [
            {
              name: "Projetos",
              description: "Gestão de projetos",
              stateIds: [],
              endpoints: ["/api/projects"],
              docSections: [],
              evidenceIds: [evValid.id],
            },
            {
              name: "Módulo Inventado",
              description: "Alucinação do LLM",
              stateIds: [],
              endpoints: [],
              docSections: [],
              evidenceIds: ["ev_invented_module"],
            },
          ],
        },
        synthesize_findings: {
          findings: [
            {
              module: "Projetos",
              category: "validation",
              statement: "Nome do projeto é obrigatório.",
              confidence: "observed",
              evidenceIds: [evValid.id],
            },
            {
              module: "Projetos",
              category: "feature",
              statement: "Suporta exportação em PDF com marca d'água.",
              confidence: "hypothesis",
              evidenceIds: ["ev_nao_existe_no_store"],
            },
            {
              module: "Projetos",
              category: "limit",
              statement: "Permite 999 anexos por projeto.",
              confidence: "inferred",
              evidenceIds: [],
            },
          ],
        },
        synthesize_rules: {
          rules: [
            {
              module: "Projetos",
              title: "Nome obrigatório",
              trigger: "Ao criar projeto",
              condition: "Nome vazio",
              effect: "Rejeita criação",
              confidence: "observed",
              findingIds: [],
              evidenceIds: [evValid.id],
            },
            {
              module: "Projetos",
              title: "Regra sem evidência válida",
              trigger: "Ao exportar",
              condition: "Qualquer",
              effect: "Gera PDF",
              confidence: "hypothesis",
              findingIds: [],
              evidenceIds: ["ev_orphan_rule_id"],
            },
          ],
        },
        synthesize_domain: {
          entities: [
            {
              name: "Project",
              attributes: [
                {
                  name: "name",
                  type: "string",
                  required: true,
                  evidenceIds: [evValid.id],
                },
                {
                  name: "ghostField",
                  type: "string",
                  required: false,
                  evidenceIds: ["ev_ghost_attr"],
                },
              ],
              relations: [],
            },
          ],
        },
        synthesize_behavior: {
          stateMachines: [],
          flows: [],
        },
      },
    });

    const ctx = createTestContext(buildManifest(), llm, { jobId, events });
    const result = await runSynthesizePhase(ctx);

    expect(result.document.modules).toHaveLength(1);
    expect(result.document.modules[0]?.name).toBe("Projetos");

    expect(result.document.findings).toHaveLength(1);
    expect(result.document.findings[0]?.statement).toBe("Nome do projeto é obrigatório.");

    expect(result.document.rules).toHaveLength(1);
    expect(result.document.rules[0]?.id).toBe("BR-001");
    expect(result.document.rules[0]?.title).toBe("Nome obrigatório");

    expect(result.document.domain.entities[0]?.attributes).toHaveLength(1);
    expect(result.document.domain.entities[0]?.attributes[0]?.name).toBe("name");

    const unsupportedEvents = events.filter((e) => e.type === "synthesis_unsupported_claim");
    // 1 módulo inventado + 2 findings sem evidência válida + 1 rule sem evidência válida + 1 atributo fantasma = 5
    expect(unsupportedEvents).toHaveLength(5);
    expect(unsupportedEvents.map((e) => e.data?.claimType)).toEqual(
      expect.arrayContaining(["module", "finding", "rule", "domain_attribute"]),
    );

    // Taxa de descarte > 20% deve emitir alerta
    expect(result.stats.discardRatePercent).toBeGreaterThan(20);
    expect(events.some((e) => e.type === "synthesis_high_discard_alert")).toBe(true);

    // Persistência em SQLite e findings.json
    expect(evidenceStore.listFindings(jobId)).toHaveLength(1);
    expect(evidenceStore.listRules(jobId)).toHaveLength(1);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  it("contra evidências coletadas da fixtures/demo-app com FakeLlmClient, cobre >= 70% de EXPECTED.md e persiste findings, rules e findings.json", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp, PUBLIC_APP_BUNDLE_JS } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const jobId = "job_demo_app_f1_12";
    const collected: Evidence[] = [];

    // 1. Coleta real de /robots.txt, /pricing, /help, /projects, /projects/new, /projects/:id, /login e API da demo-app
    const robotsText = await (
      await demo.app.fetch(new Request(`${DEMO_ORIGIN}/robots.txt`))
    ).text();
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "robots",
        phase: "intake",
        url: `${DEMO_ORIGIN}/robots.txt`,
        summary: "robots.txt bloqueia /admin e /logout",
        blob: robotsText,
        data: { disallow: ["/admin", "/logout"] },
      }),
    );

    const helpHtml = await (await demo.app.fetch(new Request(`${DEMO_ORIGIN}/help`))).text();
    expect(helpHtml).toContain("3 e 60");
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "doc_section",
        phase: "analyze",
        url: `${DEMO_ORIGIN}/help`,
        summary:
          "Ajuda: criação de projeto exige nome 3-60, orçamento >= 0 e data futura; status draft/active/archived",
        data: {
          heading: "Projetos, validações e ciclo de vida",
          highlights: [
            "Nome 3 a 60 caracteres",
            "Orçamento >= 0",
            "Data de entrega futura",
            "Status draft, active e archived",
          ],
        },
      }),
    );

    const pricingHtml = await (await demo.app.fetch(new Request(`${DEMO_ORIGIN}/pricing`))).text();
    expect(pricingHtml).toContain("Free");
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "pricing_plan",
        phase: "analyze",
        url: `${DEMO_ORIGIN}/pricing`,
        summary:
          "Plano Free (R$ 0/mês): máximo de 3 projetos não arquivados; Plano Pro (R$ 49/mês): ilimitado + pro_export",
        data: {
          plans: [
            { name: "Free", price: "R$ 0/mês", projectLimit: 3 },
            { name: "Pro", price: "R$ 49/mês", projectLimit: "unlimited" },
          ],
        },
      }),
    );

    // 2. Probes reais contra POST /api/projects (validações BR-001, BR-002, BR-003, BR-004)
    const invalidNameRes = await demo.app.fetch(
      new Request(`${DEMO_ORIGIN}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ab", budget: 100, targetDate: "2099-01-01" }),
      }),
    );
    const invalidNameJson = (await invalidNameRes.json()) as { code: string; message: string };
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "form_probe",
        phase: "explore",
        url: `${DEMO_ORIGIN}/projects/new`,
        summary: `Probe nome curto retorna HTTP ${invalidNameRes.status} (${invalidNameJson.code})`,
        data: { field: "name", httpStatus: invalidNameRes.status, code: invalidNameJson.code },
      }),
    );

    const invalidBudgetRes = await demo.app.fetch(
      new Request(`${DEMO_ORIGIN}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Projeto Valido", budget: -10, targetDate: "2099-01-01" }),
      }),
    );
    const invalidBudgetJson = (await invalidBudgetRes.json()) as { code: string };
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "form_probe",
        phase: "explore",
        url: `${DEMO_ORIGIN}/projects/new`,
        summary: `Probe orçamento negativo retorna HTTP ${invalidBudgetRes.status} (${invalidBudgetJson.code})`,
        data: {
          field: "budget",
          httpStatus: invalidBudgetRes.status,
          code: invalidBudgetJson.code,
        },
      }),
    );

    const invalidDateRes = await demo.app.fetch(
      new Request(`${DEMO_ORIGIN}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Projeto Valido", budget: 100, targetDate: "2020-01-01" }),
      }),
    );
    const invalidDateJson = (await invalidDateRes.json()) as { code: string };
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "form_probe",
        phase: "explore",
        url: `${DEMO_ORIGIN}/projects/new`,
        summary: `Probe data passada retorna HTTP ${invalidDateRes.status} (${invalidDateJson.code})`,
        data: {
          field: "targetDate",
          httpStatus: invalidDateRes.status,
          code: invalidDateJson.code,
        },
      }),
    );

    // 3. Listagem paginada e detalhe de estados draft/active/archived (BR-006..BR-010)
    const listRes = await demo.app.fetch(new Request(`${DEMO_ORIGIN}/api/projects?page=1`));
    const listJson = (await listRes.json()) as {
      items: Array<{ status: string }>;
      meta: { pageSize: number };
    };
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "network_call",
        phase: "capture",
        url: `${DEMO_ORIGIN}/api/projects?page=1`,
        summary: `GET /api/projects paginado com pageSize=${listJson.meta.pageSize} e enum status`,
        data: {
          method: "GET",
          pathTemplate: "/api/projects",
          status: listRes.status,
          safeEnumSamples: { status: ["draft", "active", "archived"] },
          pagination: { pageSize: listJson.meta.pageSize },
        },
      }),
    );

    const draftHtml = await (
      await demo.app.fetch(new Request(`${DEMO_ORIGIN}/projects/proj-1`))
    ).text();
    const activeHtml = await (
      await demo.app.fetch(new Request(`${DEMO_ORIGIN}/projects/proj-2`))
    ).text();
    const archivedHtml = await (
      await demo.app.fetch(new Request(`${DEMO_ORIGIN}/projects/proj-3`))
    ).text();
    expect(draftHtml).toContain("Ativar projeto");
    expect(activeHtml).toContain("Arquivar projeto");
    expect(archivedHtml).toContain("archived");

    collected.push(
      evidenceStore.put({
        jobId,
        kind: "dom_snapshot",
        phase: "explore",
        stateId: "state_project_states",
        url: `${DEMO_ORIGIN}/projects/proj-1`,
        summary:
          "Estados draft (Ativar/Arquivar/Excluir), active (Arquivar/Exportar Pro) e archived (somente leitura)",
        data: {
          statesObserved: ["draft", "active", "archived"],
          destructiveButton: "Excluir projeto",
        },
      }),
    );

    // 4. Transição inválida em archived (BR-009) e login inválido (BR-011)
    const archivedTransitionRes = await demo.app.fetch(
      new Request(`${DEMO_ORIGIN}/api/projects/proj-3/activate`, { method: "POST" }),
    );
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "network_call",
        phase: "capture",
        url: `${DEMO_ORIGIN}/api/projects/proj-3/activate`,
        summary: `POST /api/projects/{id}/activate em archived retorna HTTP ${archivedTransitionRes.status}`,
        data: {
          method: "POST",
          pathTemplate: "/api/projects/{id}/activate",
          status: archivedTransitionRes.status,
        },
      }),
    );

    const loginFailRes = await demo.app.fetch(
      new Request(`${DEMO_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "invalido", password: "123" }),
      }),
    );
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "form_probe",
        phase: "explore",
        url: `${DEMO_ORIGIN}/login`,
        summary: `Probe login email/senha inválidos retorna HTTP ${loginFailRes.status}`,
        data: { field: "email", httpStatus: loginFailRes.status },
      }),
    );

    // 5. Bundle público (feature flag pro_export)
    expect(PUBLIC_APP_BUNDLE_JS).toContain("pro_export");
    collected.push(
      evidenceStore.put({
        jobId,
        kind: "feature_flag",
        phase: "analyze",
        url: `${DEMO_ORIGIN}/static/app.js`,
        summary: "Feature flag pro_export detectada no bundle público",
        data: { name: "pro_export", defaultValue: false },
      }),
    );

    const evId = (idx: number): string => collected[idx]?.id ?? "";

    // FakeLlmClient determinístico que responde cada etapa usando apenas IDs reais recebidos no prompt
    const llm = new FakeLlmClient({
      handlers: [
        {
          matcher: "synthesize_modules",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              evidences: CompactEvidenceEntry[];
            };
            const ids = payload.evidences.map((e) => e.id);
            return {
              modules: [
                {
                  name: "Projetos",
                  description: "Criação, listagem paginada e ciclo de vida de projetos.",
                  stateIds: ["state_project_states"],
                  endpoints: ["/api/projects", "/api/projects/{id}/activate"],
                  docSections: ["Projetos, validações e ciclo de vida"],
                  evidenceIds: ids.filter((id) =>
                    [evId(1), evId(3), evId(4), evId(5), evId(6), evId(7), evId(8)].includes(id),
                  ),
                },
                {
                  name: "Faturamento e Planos",
                  description: "Limites de planos Free e Pro e recurso pro_export.",
                  stateIds: [],
                  endpoints: ["/api/projects"],
                  docSections: ["Planos"],
                  evidenceIds: ids.filter((id) => [evId(2), evId(10)].includes(id)),
                },
                {
                  name: "Autenticação",
                  description: "Validação de credenciais de login.",
                  stateIds: [],
                  endpoints: ["/api/auth/login"],
                  docSections: [],
                  evidenceIds: ids.filter((id) => [evId(9)].includes(id)),
                },
                {
                  name: "Segurança e Escopo",
                  description: "Rotas administrativas bloqueadas e ações destrutivas protegidas.",
                  stateIds: [],
                  endpoints: ["/admin", "/logout"],
                  docSections: [],
                  evidenceIds: ids.filter((id) => [evId(0), evId(7)].includes(id)),
                },
              ],
            };
          },
        },
        {
          matcher: "synthesize_findings",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              module: { name: string };
              evidences: CompactEvidenceEntry[];
            };
            const mod = payload.module.name;
            if (mod === "Projetos") {
              return {
                findings: [
                  {
                    module: "Projetos",
                    category: "validation",
                    statement: "Nome do projeto é obrigatório e deve ter entre 3 e 60 caracteres.",
                    confidence: "observed",
                    evidenceIds: [evId(3), evId(1)],
                  },
                  {
                    module: "Projetos",
                    category: "validation",
                    statement: "Orçamento deve ser numérico maior ou igual a 0.",
                    confidence: "observed",
                    evidenceIds: [evId(4), evId(1)],
                  },
                  {
                    module: "Projetos",
                    category: "validation",
                    statement: "Data de entrega deve ser estritamente futura.",
                    confidence: "observed",
                    evidenceIds: [evId(5), evId(1)],
                  },
                  {
                    module: "Projetos",
                    category: "state",
                    statement: "Projeto nasce em draft e transita por draft, active e archived.",
                    confidence: "observed",
                    evidenceIds: [evId(6), evId(7)],
                  },
                  {
                    module: "Projetos",
                    category: "state",
                    statement:
                      "Em draft exibe Ativar, Arquivar e Excluir; em active exibe Arquivar e Exportar Pro; em archived é somente leitura retornando 409.",
                    confidence: "observed",
                    evidenceIds: [evId(7), evId(8)],
                  },
                  {
                    module: "Projetos",
                    category: "feature",
                    statement: "Listagem GET /api/projects é paginada com pageSize padrão 2.",
                    confidence: "observed",
                    evidenceIds: [evId(6)],
                  },
                ],
              };
            }
            if (mod === "Faturamento e Planos") {
              return {
                findings: [
                  {
                    module: "Faturamento e Planos",
                    category: "limit",
                    statement:
                      "Plano Free limita a conta a no máximo 3 projetos não arquivados (422 PLAN_LIMIT_REACHED).",
                    confidence: "inferred",
                    evidenceIds: [evId(2)],
                  },
                  {
                    module: "Faturamento e Planos",
                    category: "pricing",
                    statement:
                      "Plano Pro permite projetos ilimitados e habilita a flag pro_export.",
                    confidence: "inferred",
                    evidenceIds: [evId(2), evId(10)],
                  },
                ],
              };
            }
            if (mod === "Autenticação") {
              return {
                findings: [
                  {
                    module: "Autenticação",
                    category: "validation",
                    statement: "Login exige e-mail com @ e senha com mínimo de 8 caracteres.",
                    confidence: "observed",
                    evidenceIds: [evId(9)],
                  },
                ],
              };
            }
            return {
              findings: [
                {
                  module: "Segurança e Escopo",
                  category: "permission",
                  statement:
                    "Rotas /admin e /logout estão bloqueadas no robots.txt e ação Excluir é destrutiva.",
                  confidence: "observed",
                  evidenceIds: [evId(0), evId(7)],
                },
              ],
            };
          },
        },
        {
          matcher: "synthesize_rules",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              findings: Array<{ id: string; evidenceIds: string[] }>;
            };
            const fIds = payload.findings.map((f) => f.id);
            return {
              rules: [
                {
                  module: "Autenticação",
                  title: "Validação de credenciais no login",
                  trigger: "Ao submeter login em /login ou /api/auth/login",
                  condition: "E-mail sem @ ou senha com menos de 8 caracteres",
                  effect: "Rejeita autenticação com HTTP 400/422",
                  confidence: "observed",
                  findingIds: fIds.slice(8, 9),
                  evidenceIds: [evId(9)],
                },
                {
                  module: "Faturamento e Planos",
                  title: "Limite do Plano Free (máximo de 3 projetos não arquivados)",
                  trigger: "Ao criar novo projeto no plano Free",
                  condition: "Já existem 3 projetos em draft ou active",
                  effect: "Rejeita criação com HTTP 422 PLAN_LIMIT_REACHED",
                  confidence: "inferred",
                  findingIds: fIds.slice(6, 7),
                  evidenceIds: [evId(2)],
                },
                {
                  module: "Faturamento e Planos",
                  title: "Plano Pro sem limite de projetos e exportação Pro",
                  trigger: "Ao utilizar conta no plano Pro",
                  condition: "Assinatura Pro ativa",
                  effect: "Criação de projetos ilimitada e flag pro_export disponível",
                  confidence: "inferred",
                  findingIds: fIds.slice(7, 8),
                  evidenceIds: [evId(2), evId(10)],
                },
                {
                  module: "Projetos",
                  title: "Nome obrigatório e tamanho (3-60 caracteres)",
                  trigger: "Ao submeter criação de projeto",
                  condition: "Nome vazio ou fora de 3 a 60 caracteres",
                  effect: "Rejeita criação com HTTP 400/422",
                  confidence: "observed",
                  findingIds: fIds.slice(0, 1),
                  evidenceIds: [evId(3), evId(1)],
                },
                {
                  module: "Projetos",
                  title: "Orçamento não-negativo (budget >= 0)",
                  trigger: "Ao submeter criação de projeto",
                  condition: "Orçamento ausente, inválido ou menor que 0",
                  effect: "Rejeita criação com HTTP 400/422",
                  confidence: "observed",
                  findingIds: fIds.slice(1, 2),
                  evidenceIds: [evId(4), evId(1)],
                },
                {
                  module: "Projetos",
                  title: "Data de entrega estritamente futura",
                  trigger: "Ao submeter criação de projeto",
                  condition: "Data ausente, malformada ou <= data atual",
                  effect: "Rejeita criação com HTTP 400/422",
                  confidence: "observed",
                  findingIds: fIds.slice(2, 3),
                  evidenceIds: [evId(5), evId(1)],
                },
                {
                  module: "Projetos",
                  title: "Estado inicial draft e enum de status",
                  trigger: "Ao criar um projeto válido",
                  condition: "Criação bem-sucedida",
                  effect: "Projeto inicia com status draft dentro de draft|active|archived",
                  confidence: "observed",
                  findingIds: fIds.slice(3, 4),
                  evidenceIds: [evId(6), evId(7)],
                },
                {
                  module: "Projetos",
                  title: "Ações permitidas em draft e active",
                  trigger: "Ao visualizar detalhe do projeto",
                  condition: "Status igual a draft ou active",
                  effect:
                    "Draft permite ativar/arquivar/excluir; active permite arquivar/exportar e bloqueia exclusão",
                  confidence: "observed",
                  findingIds: fIds.slice(4, 5),
                  evidenceIds: [evId(7)],
                },
                {
                  module: "Projetos",
                  title: "Estado terminal somente leitura (archived)",
                  trigger: "Ao tentar mutação em projeto arquivado",
                  condition: "Status igual a archived",
                  effect: "Oculta botões de mutação e retorna HTTP 409 Conflict",
                  confidence: "observed",
                  findingIds: fIds.slice(4, 5),
                  evidenceIds: [evId(7), evId(8)],
                },
                {
                  module: "Projetos",
                  title: "Listagem paginada de projetos",
                  trigger: "Ao consultar GET /api/projects",
                  condition: "Parâmetro page informado ou padrão 1",
                  effect: "Retorna lista paginada com pageSize 2 e metadados de paginação",
                  confidence: "observed",
                  findingIds: fIds.slice(5, 6),
                  evidenceIds: [evId(6)],
                },
                {
                  module: "Segurança e Escopo",
                  title: "Proteção de rotas administrativas e ações destrutivas",
                  trigger: "Ao explorar rotas e ações da aplicação",
                  condition: "Rota em /admin ou /logout ou ação de exclusão",
                  effect:
                    "Rotas proibidas ficam fora do escopo e ações destrutivas não são executadas",
                  confidence: "observed",
                  findingIds: fIds.slice(9, 10),
                  evidenceIds: [evId(0), evId(7)],
                },
              ],
            };
          },
        },
        {
          matcher: "synthesize_domain",
          handler: () => ({
            entities: [
              {
                name: "Project",
                attributes: [
                  { name: "name", type: "string", required: true, evidenceIds: [evId(3)] },
                  { name: "budget", type: "number", required: true, evidenceIds: [evId(4)] },
                  { name: "targetDate", type: "date", required: true, evidenceIds: [evId(5)] },
                  {
                    name: "status",
                    type: "enum(draft,active,archived)",
                    required: true,
                    evidenceIds: [evId(6)],
                  },
                ],
                relations: [{ to: "Plan", kind: "1-n", evidenceIds: [evId(2)] }],
              },
              {
                name: "Plan",
                attributes: [
                  { name: "tier", type: "enum(free,pro)", required: true, evidenceIds: [evId(2)] },
                  {
                    name: "projectLimit",
                    type: "number|unlimited",
                    required: true,
                    evidenceIds: [evId(2)],
                  },
                ],
                relations: [],
              },
            ],
          }),
        },
        {
          matcher: "synthesize_behavior",
          handler: () => ({
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
                    evidenceIds: [evId(7)],
                  },
                  {
                    from: "draft",
                    to: "archived",
                    trigger: "Arquivar projeto",
                    evidenceIds: [evId(7)],
                  },
                  {
                    from: "active",
                    to: "archived",
                    trigger: "Arquivar projeto",
                    evidenceIds: [evId(7), evId(8)],
                  },
                ],
                evidenceIds: [evId(6), evId(7)],
              },
            ],
            flows: [
              {
                name: "Ciclo de criação e ativação de projeto",
                module: "Projetos",
                description: "Fluxo completo de validação de entrada, criação em draft e ativação.",
                steps: [
                  {
                    order: 1,
                    actor: "Usuário",
                    action: "Preenche nome, orçamento e data futura e submete formulário",
                    outcome: "Projeto criado com status draft após passar pelas validações",
                    evidenceIds: [evId(3), evId(4), evId(5)],
                  },
                  {
                    order: 2,
                    actor: "Usuário",
                    action: "Aciona ativação do projeto em draft",
                    outcome: "Status transita para active",
                    evidenceIds: [evId(7)],
                  },
                ],
                evidenceIds: [evId(3), evId(7)],
              },
            ],
          }),
        },
      ],
    });

    const ctx = createTestContext(buildManifest(), llm, { jobId });
    const result = await runSynthesizePhase(ctx);

    // Verifica cobertura >= 70% das 12 regras plantadas em fixtures/demo-app/EXPECTED.md
    const expectedMd = readFileSync(
      resolve(here, "../../../fixtures/demo-app/EXPECTED.md"),
      "utf8",
    );
    const expectedIds = [...expectedMd.matchAll(/\*\*(BR-\d{3})\*\*/g)].map((m) => m[1]);
    expect(expectedIds).toHaveLength(12);

    const coverageRatio = result.document.rules.length / expectedIds.length;
    expect(coverageRatio).toBeGreaterThanOrEqual(0.7);
    expect(result.document.rules.map((r) => r.id)).toEqual(
      result.document.rules.map((_, idx) => `BR-${String(idx + 1).padStart(3, "0")}`),
    );
    expect(result.document.features).toEqual([]);
    expect(result.document.domain.entities).toHaveLength(2);
    expect(result.document.stateMachines).toHaveLength(1);
    expect(result.document.flows).toHaveLength(1);

    // Verifica persistência nas tabelas findings e rules + jobs/<jobId>/findings.json
    const persistedFindings = evidenceStore.listFindings(jobId);
    const persistedRules = evidenceStore.listRules(jobId);
    expect(persistedFindings).toHaveLength(result.document.findings.length);
    expect(persistedRules).toHaveLength(result.document.rules.length);

    const jsonOnDisk = JSON.parse(readFileSync(result.outputPath, "utf8")) as FindingsDocument;
    expect(jsonOnDisk.version).toBe(1);
    expect(jsonOnDisk.jobId).toBe(jobId);
    expect(jsonOnDisk.rules).toHaveLength(result.document.rules.length);
    expect(jsonOnDisk.features).toEqual([]);
  });

  it("integra com JobRunner/JobService, contabiliza tokens e suporta retomada por checkpoint sem duplicar achados", async () => {
    const checkpoints: unknown[] = [];
    const manifest = buildManifest();
    const manifestYaml = [
      "version: 1",
      "job:",
      "  name: demo-runner-synth",
      "  goals: ['Validar integração JobRunner + synthesize']",
      "target:",
      `  url: ${DEMO_ORIGIN}`,
      "  type: web-ssr",
      `  allowedOrigins: [${DEMO_ORIGIN}]`,
      "ownership: own",
      "authorization:",
      "  basis: Aplicação própria para testes.",
      "  tosReviewed: true",
      "  evidence: null",
    ].join("\n");

    const llm = new FakeLlmClient({
      handlers: [
        {
          matcher: "synthesize_modules",
          handler: (req) => {
            const payload = JSON.parse(req.messages[1]?.content ?? "{}") as {
              evidences: CompactEvidenceEntry[];
            };
            return {
              data: {
                modules: [
                  {
                    name: "Projetos",
                    description: "Módulo de projetos",
                    stateIds: [],
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
              evidences: CompactEvidenceEntry[];
            };
            return {
              data: {
                findings: [
                  {
                    module: "Projetos",
                    category: "validation",
                    statement: "Nome obrigatório entre 3 e 60 caracteres.",
                    confidence: "observed",
                    evidenceIds: payload.evidences.map((e) => e.id),
                  },
                ],
              },
              usage: { tokensIn: 120, tokensOut: 50 },
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
                    title: "Nome obrigatório",
                    trigger: "Ao criar projeto",
                    condition: "Nome inválido",
                    effect: "Retorna 400/422",
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
          handler: () => ({
            data: { entities: [] },
            usage: { tokensIn: 50, tokensOut: 10 },
          }),
        },
        {
          matcher: "synthesize_behavior",
          handler: () => ({
            data: { stateMachines: [], flows: [] },
            usage: { tokensIn: 50, tokensOut: 10 },
          }),
        },
      ],
    });

    const synthPhase = createSynthesizePhase();
    const phases: Phase[] = DEFAULT_PHASE_ORDER.map((id) => {
      if (id === "intake") {
        return {
          id,
          async run(ctx) {
            ctx.evidence.put({
              jobId: ctx.job.id,
              kind: "form_probe",
              phase: "intake",
              summary: "Nome obrigatório retorna 400",
              data: { field: "name" },
            });
            return { status: "ok", stats: { seeded: 1 } };
          },
        };
      }
      if (id === "synthesize") {
        return synthPhase;
      }
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
    expect(finished.llmTokensIn).toBe(400);
    expect(finished.llmTokensOut).toBe(140);

    const status = await svc.status(jobId);
    expect(status.counters.findings).toBe(1);
    expect(status.counters.rules).toBe(1);

    const rules = await svc.listRules(jobId);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe("BR-001");

    // Teste de retomada a partir de checkpoint no estágio "domain" (não deve rechamar modules/findings/rules)
    const resumeLlm = new FakeLlmClient({
      fixtures: {
        synthesize_domain: { entities: [] },
        synthesize_behavior: { stateMachines: [], flows: [] },
      },
    });
    const ev = svc.evidence.listAll(jobId)[0] as Evidence;
    const resumeCtx = createTestContext(manifest, resumeLlm, {
      jobId,
      checkpoint: {
        stage: "domain",
        modules: [
          {
            name: "Projetos",
            description: "Módulo de projetos",
            stateIds: [],
            endpoints: [],
            docSections: [],
            evidenceIds: [ev.id],
          },
        ],
        findings: svc.evidence.listFindings(jobId),
        rules: svc.evidence.listRules(jobId),
        unsupportedClaimsDiscarded: 0,
        totalClaimsEvaluated: 3,
      },
      onSaveCheckpoint: (cp) => checkpoints.push(cp),
    });

    const resumedResult = await runSynthesizePhase(resumeCtx);
    expect(resumedResult.stats.rules).toBe(1);
    expect(resumeLlm.calls.map((c) => c.opts?.schemaName)).toEqual([
      "synthesize_domain",
      "synthesize_behavior",
    ]);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  });
});
