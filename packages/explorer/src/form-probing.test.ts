import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceStore,
  FakeLlmClient,
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
import {
  buildProbePayload,
  createExplorePhase,
  executeFormProbe,
  extractErrorMessageFromHtml,
  extractFormSchemasFromHtml,
  generateFormProbes,
  getBaselineValidValue,
  isDestructiveForm,
  probeForm,
  recordFormProbeEvidence,
  recordFormSchemaEvidence,
  runExplorePhase,
  runIntakePhase,
} from "./index.js";

interface DemoAppModule {
  createDemoApp(): {
    app: {
      fetch(request: Request): Response | Promise<Response>;
    };
    store: {
      getStats(): {
        createdProjectsCount: number;
        validationFailuresCount: number;
        adminVisitsCount: number;
        totalProjects: number;
      };
    };
  };
}

const DEMO_ORIGIN = "https://demo.cleanroom.test";

function buildTestManifest(overrides?: {
  url?: string;
  formSubmission?: "none" | "validation-only" | "full";
  destructiveActions?: boolean;
}): Manifest {
  const origin = overrides?.url ? new URL(overrides.url).origin : DEMO_ORIGIN;
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-form-probing-test",
      description: "Teste de extração de schema e probing de validação (F1-06)",
      goals: ["Detectar regras de validação client e server-side"],
    },
    target: {
      url: overrides?.url ?? DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [origin],
      docsUrls: [`${origin}/help`],
    },
    ownership: "own",
    authorization: {
      basis: "App própria de demonstração para testes de probing.",
      tosReviewed: true,
      evidence: null,
    },
    methods: {
      behavioralUi: true,
      networkHar: false,
      publicDocs: false,
      staticBundles: false,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: 20,
      maxDepth: 4,
      maxDurationMin: 5,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["**/admin/**", "**/logout"],
      destructiveActions: overrides?.destructiveActions ?? false,
      formSubmission: overrides?.formSubmission ?? "validation-only",
      respectRobotsTxt: true,
    },
    humanInTheLoop: {
      captcha: "abort",
      smsOtp: "abort",
      payments: "abort",
      handoffTimeoutMin: 10,
    },
    cleanup: {
      deleteAccountAtEnd: false,
      purgeHarSecrets: true,
      retainDays: 7,
    },
    report: {
      language: "pt-BR",
      viewports: [[1440, 900]],
      include: ["executive-summary"],
    },
  });
}

describe("Form Schema Extraction & Validation-Only Probing (F1-06)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-form-probing-test-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignora erro se já fechado
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createTestContext(manifest: Manifest): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: "job_test_probing",
      name: manifest.job.name,
      state: "running",
      manifest,
      createdAt: nowIso,
      updatedAt: nowIso,
      llmTokensIn: 0,
      llmTokensOut: 0,
    };
    const guard = createScopeGuard(manifest, {
      sleep: async () => undefined,
    });

    return {
      job,
      manifest,
      guard,
      evidence: evidenceStore,
      llm: new FakeLlmClient(),
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: () => undefined,
      emit: () => undefined,
    };
  }

  it("extrai schema estruturado completo de formulários HTML (campos, types, labels, required, min, max, minLength, maxLength, step)", () => {
    const html = `<!DOCTYPE html>
      <html>
        <body>
          <form id="new-project-form" action="/api/projects" method="post" novalidate>
            <div class="field">
              <label for="name">Nome do projeto *</label>
              <input id="name" name="name" type="text" required minlength="3" maxlength="60" placeholder="Ex.: Portal" />
            </div>
            <div class="field">
              <label for="budget">Orçamento (R$) *</label>
              <input id="budget" name="budget" type="number" required min="0" step="0.01" placeholder="0.00" />
            </div>
            <div class="field">
              <label for="targetDate">Data de entrega (futura) *</label>
              <input id="targetDate" name="targetDate" type="date" required />
            </div>
            <div class="field">
              <label for="category">Categoria</label>
              <select id="category" name="category">
                <option value="web" selected>Web</option>
                <option value="mobile">Mobile</option>
              </select>
            </div>
            <div class="actions">
              <button type="submit">Criar projeto</button>
            </div>
          </form>
        </body>
      </html>`;

    const schemas = extractFormSchemasFromHtml(
      html,
      `${DEMO_ORIGIN}/projects/new`,
      "st_new_project",
    );
    expect(schemas.length).toBe(1);

    const form = schemas[0];
    expect(form).toBeDefined();
    if (!form) return;
    expect(form.formId).toBe("new-project-form");
    expect(form.action).toBe(`${DEMO_ORIGIN}/api/projects`);
    expect(form.method).toBe("post");
    expect(form.selector).toBe("form#new-project-form");
    expect(form.submitButton?.label).toBe("Criar projeto");

    const fieldsByName = new Map(form.fields.map((f) => [f.name, f]));

    // Campo name (3 a 60 caracteres)
    const nameField = fieldsByName.get("name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("text");
    expect(nameField?.label).toBe("Nome do projeto *");
    expect(nameField?.required).toBe(true);
    expect(nameField?.minLength).toBe(3);
    expect(nameField?.maxLength).toBe(60);
    expect(nameField?.placeholder).toBe("Ex.: Portal");

    // Campo budget (>= 0)
    const budgetField = fieldsByName.get("budget");
    expect(budgetField).toBeDefined();
    expect(budgetField?.type).toBe("number");
    expect(budgetField?.label).toBe("Orçamento (R$) *");
    expect(budgetField?.required).toBe(true);
    expect(budgetField?.min).toBe(0);
    expect(budgetField?.step).toBe(0.01);

    // Campo targetDate (date futura)
    const dateField = fieldsByName.get("targetDate");
    expect(dateField).toBeDefined();
    expect(dateField?.type).toBe("date");
    expect(dateField?.label).toBe("Data de entrega (futura) *");
    expect(dateField?.required).toBe(true);

    // Campo category (select)
    const catField = fieldsByName.get("category");
    expect(catField).toBeDefined();
    expect(catField?.type).toBe("select");
    expect(catField?.options?.length).toBe(2);
    expect(catField?.options?.[0]?.value).toBe("web");
  });

  it("gera bateria de probes inválidos abrangendo required vazio, minLength, maxLength, número negativo e data passada", () => {
    const html = `<form id="new-project-form" action="/api/projects" method="post">
      <input id="name" name="name" type="text" required minlength="3" maxlength="60" />
      <input id="budget" name="budget" type="number" required min="0" />
      <input id="targetDate" name="targetDate" type="date" required />
      <input id="csrf" name="_csrf" type="hidden" value="token123" />
    </form>`;

    const [form] = extractFormSchemasFromHtml(html, `${DEMO_ORIGIN}/projects/new`);
    expect(form).toBeDefined();
    if (!form) return;
    const probes = generateFormProbes(form);

    expect(probes.length).toBeGreaterThanOrEqual(5);

    // Probes do campo name
    const nameProbes = probes.filter((p) => p.field === "name");
    expect(nameProbes.some((p) => p.probeType === "empty_required" && p.value === "")).toBe(true);
    expect(nameProbes.some((p) => p.probeType === "min_length" && String(p.value).length < 3)).toBe(
      true,
    );
    expect(
      nameProbes.some((p) => p.probeType === "max_length" && String(p.value).length > 60),
    ).toBe(true);

    // Probes do campo budget
    const budgetProbes = probes.filter((p) => p.field === "budget");
    expect(budgetProbes.some((p) => p.probeType === "empty_required")).toBe(true);
    expect(budgetProbes.some((p) => p.probeType === "negative_number" && Number(p.value) < 0)).toBe(
      true,
    );

    // Probes do campo targetDate
    const dateProbes = probes.filter((p) => p.field === "targetDate");
    expect(dateProbes.some((p) => p.probeType === "empty_required")).toBe(true);
    expect(dateProbes.some((p) => p.probeType === "past_date" && p.value === "2000-01-01")).toBe(
      true,
    );

    // Hidden field não deve ter probes inválidos gerados
    expect(probes.some((p) => p.field === "_csrf")).toBe(false);
  });

  it("produz valores baseline válidos para isolar a validação do campo alvo sob teste", () => {
    const html = `<form id="new-project-form" action="/api/projects" method="post">
      <input id="name" name="name" type="text" required minlength="3" maxlength="60" />
      <input id="budget" name="budget" type="number" required min="0" />
      <input id="targetDate" name="targetDate" type="date" required />
    </form>`;

    const [form] = extractFormSchemasFromHtml(html, `${DEMO_ORIGIN}/projects/new`);
    expect(form).toBeDefined();
    if (!form) return;

    const budgetProbe = {
      field: "budget",
      probeType: "negative_number" as const,
      inputSummary: "número negativo (-1)",
      value: -1,
    };

    const payload = buildProbePayload(form, budgetProbe);
    expect(payload.budget).toBe(-1);
    expect(typeof payload.name).toBe("string");
    expect(String(payload.name).length).toBeGreaterThanOrEqual(3);
    expect(String(payload.name).length).toBeLessThanOrEqual(60);
    expect(payload.targetDate).toBe("2099-12-31");
  });

  it("detecta as 3 validações do formulário 'Novo projeto' da fixtures/demo-app e garante que nenhum projeto válido é criado (critérios 1 e 2)", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req = new Request(url, init);
      return demo.app.fetch(req);
    };

    const manifest = buildTestManifest({ formSubmission: "validation-only" });
    const ctx = createTestContext(manifest);

    // 1. Obtém HTML de /projects/new
    const res = await fetchViaDemoApp(`${DEMO_ORIGIN}/projects/new`);
    const html = await res.text();

    const schemas = extractFormSchemasFromHtml(html, `${DEMO_ORIGIN}/projects/new`);
    expect(schemas.length).toBe(1);
    const form = schemas[0];
    expect(form).toBeDefined();
    if (!form) return;

    // 2. Executa probing completo
    const runResult = await probeForm({
      form,
      ctx,
      fetchFn: fetchViaDemoApp,
    });

    expect(runResult.formSchemaEvidence).toBeDefined();
    expect(runResult.probeEvidences.length).toBeGreaterThanOrEqual(5);

    // Validação 1: Nome (3 a 60 caracteres)
    const nameProbeResults = runResult.results.filter((r) => r.field === "name");
    expect(nameProbeResults.length).toBeGreaterThan(0);
    expect(
      nameProbeResults.some(
        (r) =>
          r.passed &&
          (r.observedMessage.includes("3 e 60 caracteres") ||
            r.observedMessage.includes("nome do projeto")),
      ),
    ).toBe(true);

    // Validação 2: Orçamento (maior ou igual a 0)
    const budgetProbeResults = runResult.results.filter((r) => r.field === "budget");
    expect(budgetProbeResults.length).toBeGreaterThan(0);
    expect(
      budgetProbeResults.some(
        (r) =>
          r.passed &&
          (r.observedMessage.includes("maior ou igual a 0") ||
            r.observedMessage.includes("orçamento")),
      ),
    ).toBe(true);

    // Validação 3: Data de entrega (data futura)
    const dateProbeResults = runResult.results.filter((r) => r.field === "targetDate");
    expect(dateProbeResults.length).toBeGreaterThan(0);
    expect(
      dateProbeResults.some(
        (r) =>
          r.passed &&
          (r.observedMessage.includes("data futura") ||
            r.observedMessage.includes("data de entrega")),
      ),
    ).toBe(true);

    // CRITÉRIO DE ACEITE 2: Nenhum projeto válido criado na API da demo-app
    expect(demo.store.getStats().createdProjectsCount).toBe(0);
    expect(demo.store.getStats().validationFailuresCount).toBeGreaterThanOrEqual(5);

    // Evidências gravadas no EvidenceStore
    const storedSchemas = evidenceStore.list(ctx.job.id, { kind: "form_schema" }).items;
    const storedProbes = evidenceStore.list(ctx.job.id, { kind: "form_probe" }).items;

    expect(storedSchemas.length).toBe(1);
    expect(storedProbes.length).toBe(runResult.probeEvidences.length);

    for (const p of storedProbes) {
      expect(p.data.formId).toBe(form.formId);
      expect(typeof p.data.field).toBe("string");
      expect(typeof p.data.inputSummary).toBe("string");
      expect(typeof p.data.observedMessage).toBe("string");
    }
  });

  it("respeita limits.formSubmission === 'none' extraindo apenas form_schema sem executar probing (critério 3)", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req = new Request(url, init);
      return demo.app.fetch(req);
    };

    const manifest = buildTestManifest({ formSubmission: "none" });
    const ctx = createTestContext(manifest);

    const res = await fetchViaDemoApp(`${DEMO_ORIGIN}/projects/new`);
    const html = await res.text();
    const [form] = extractFormSchemasFromHtml(html, `${DEMO_ORIGIN}/projects/new`);
    expect(form).toBeDefined();
    if (!form) return;

    const runResult = await probeForm({
      form,
      ctx,
      fetchFn: fetchViaDemoApp,
    });

    // Form schema registrado com sucesso
    expect(runResult.formSchemaEvidence).toBeDefined();
    // Probing completamente desabilitado
    expect(runResult.probeEvidences.length).toBe(0);
    expect(runResult.results.length).toBe(0);

    const storedSchemas = evidenceStore.list(ctx.job.id, { kind: "form_schema" }).items;
    const storedProbes = evidenceStore.list(ctx.job.id, { kind: "form_probe" }).items;

    expect(storedSchemas.length).toBe(1);
    expect(storedProbes.length).toBe(0);
    expect(demo.store.getStats().createdProjectsCount).toBe(0);
  });

  it("nunca executa probing em formulários classificados como destrutivos quando destructiveActions é false", async () => {
    const manifest = buildTestManifest({ destructiveActions: false });
    const ctx = createTestContext(manifest);

    const deleteFormHtml = `<form id="delete-form" action="/api/projects/proj-1/delete" method="post">
      <input type="text" name="confirm" required />
      <button type="submit" class="destructive">Excluir projeto</button>
    </form>`;

    const [form] = extractFormSchemasFromHtml(deleteFormHtml, `${DEMO_ORIGIN}/projects/proj-1`);
    expect(form).toBeDefined();
    if (!form) return;
    expect(isDestructiveForm(form, ctx.guard)).toBe(true);

    const runResult = await probeForm({
      form,
      ctx,
    });

    // Schema é extraído, mas probing é bloqueado por segurança
    expect(runResult.formSchemaEvidence).toBeDefined();
    expect(runResult.probeEvidences.length).toBe(0);
    expect(runResult.results.length).toBe(0);
  });

  it("integração ponta a ponta: runExplorePhase descobre formulários e executa probing validation-only durante a exploração", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req = new Request(url, init);
      return demo.app.fetch(req);
    };

    const manifest = buildTestManifest({ formSubmission: "validation-only" });
    const ctx = createTestContext(manifest);

    // Intake primeiro para robots.txt e sementes
    await runIntakePhase(ctx, { fetch: fetchViaDemoApp });

    // Explore com extração de formulários e probing
    const exploreRes = await runExplorePhase(ctx, {
      fetch: fetchViaDemoApp,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });

    expect(exploreRes.phaseResult.status).toBe("ok");
    expect(exploreRes.formSchemaEvidences.length).toBeGreaterThan(0);
    expect(exploreRes.formProbeEvidences.length).toBeGreaterThanOrEqual(5);

    // Garante que o form de novo projeto foi descoberto e avaliado
    const hasNewProjectSchema = exploreRes.formSchemaEvidences.some(
      (e) => e.data.formId === "new-project-form",
    );
    expect(hasNewProjectSchema).toBe(true);

    const newProjectProbes = exploreRes.formProbeEvidences.filter(
      (e) => e.data.formId === "new-project-form",
    );
    expect(newProjectProbes.length).toBeGreaterThanOrEqual(5);

    // Nenhum projeto criado durante todo o explore
    expect(demo.store.getStats().createdProjectsCount).toBe(0);
  });
});
