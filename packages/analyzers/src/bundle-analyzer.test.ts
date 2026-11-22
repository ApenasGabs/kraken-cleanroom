import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceStore,
  FakeLlmClient,
  type JobRecord,
  type Manifest,
  MethodNotAllowedError,
  type PhaseContext,
  type SqliteDatabase,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_EXTRACTED_STRING_LENGTH,
  analyzeBundleSource,
  bundleAnalyzer,
  createBundleAnalyzerPhase,
  extractSourceMapModuleNames,
  isLikelyUiString,
  truncateExtractedString,
} from "./bundle-analyzer.js";

interface DemoAppModule {
  createDemoApp(): {
    app: { fetch(request: Request): Response | Promise<Response> };
  };
  PUBLIC_APP_BUNDLE_JS: string;
}

const DEMO_ORIGIN = "https://demo.cleanroom.test";
const JOB_ID = "job_test_f1_10";

function buildManifest(overrides?: { staticBundles?: boolean }): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-bundle-analyzer-test",
      description: "Estudo clean-room da fixture demo-app para validação do bundleAnalyzer",
      goals: ["Extrair rotas, mensagens e flags de bundles JS públicos"],
    },
    target: {
      url: DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [DEMO_ORIGIN],
      docsUrls: [`${DEMO_ORIGIN}/help`],
    },
    ownership: "own",
    authorization: {
      basis: "Aplicação de demonstração própria do repositório para testes automatizados.",
      tosReviewed: true,
      evidence: null,
    },
    methods: {
      behavioralUi: true,
      networkHar: true,
      publicDocs: true,
      staticBundles: overrides?.staticBundles ?? true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: 30,
      maxDepth: 3,
      maxDurationMin: 10,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["/admin", "**/admin/**", "**/logout"],
      destructiveActions: false,
      formSubmission: "validation-only",
      respectRobotsTxt: true,
    },
    accounts: { strategy: "none" },
    humanInTheLoop: {
      captcha: "abort",
      smsOtp: "abort",
      payments: "abort",
      handoffTimeoutMin: 5,
    },
    cleanup: { deleteAccountAtEnd: false, purgeHarSecrets: true, retainDays: 30 },
    report: { language: "pt-BR", viewports: [[1440, 900]] },
  });
}

async function loadDemo(): Promise<DemoAppModule> {
  const url = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
  return (await import(url)) as DemoAppModule;
}

function demoFetch(demo: ReturnType<DemoAppModule["createDemoApp"]>): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return demo.app.fetch(req);
  }) as typeof globalThis.fetch;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("bundleAnalyzer (@cleanroom/analyzers - F1-10)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-bundle-analyzer-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestContext(manifest: Manifest): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: JOB_ID,
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
      llm: new FakeLlmClient(),
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: () => undefined,
      emit: () => undefined,
    };
  }

  it("extrai rotas, endpoints, mensagens de erro de validação e feature flags do bundle da fixtures/demo-app", async () => {
    const { createDemoApp } = await loadDemo();
    const demo = createDemoApp();
    const ctx = createTestContext(buildManifest());

    const result = await bundleAnalyzer(ctx, { fetch: demoFetch(demo) });

    expect(result.skipped).toBe(false);
    expect(result.document.bundles.map((b) => b.url)).toEqual([`${DEMO_ORIGIN}/static/app.js`]);

    const routes = result.document.routes.filter((r) => r.type === "ui").map((r) => r.path);
    expect(routes).toEqual(
      expect.arrayContaining([
        "/",
        "/login",
        "/projects",
        "/projects/new",
        "/projects/:id",
        "/pricing",
        "/help",
      ]),
    );
    expect(result.document.endpoints).toEqual(
      expect.arrayContaining(["/api/projects", "/api/projects/stats", "/api/auth/login"]),
    );

    const errorTexts = result.document.strings
      .filter((s) => s.category === "error")
      .map((s) => s.text);
    expect(errorTexts).toEqual(
      expect.arrayContaining([
        "A data de entrega deve ser uma data futura.",
        "O orçamento deve ser um valor numérico maior ou igual a 0.",
        "A senha deve ter pelo menos 8 caracteres.",
      ]),
    );
    const budget = result.document.strings.find(
      (s) => s.i18nKey === "projects.validation.budget_min",
    );
    expect(budget?.text).toBe("O orçamento deve ser um valor numérico maior ou igual a 0.");
    expect(result.document.i18nKeys).toContain("projects.limit.free_plan");

    const flags = Object.fromEntries(
      result.document.featureFlags.map((f) => [f.name, f.defaultValue]),
    );
    expect(flags).toMatchObject({ pro_export: false, bulk_archive: false });

    // Barreira clean room: todo literal <= 100 chars e < 20 palavras.
    for (const s of result.document.strings) {
      expect(s.text.length).toBeLessThanOrEqual(MAX_EXTRACTED_STRING_LENGTH);
      expect(s.text.split(/\s+/).length).toBeLessThan(20);
    }

    // Evidências indexadas por tipo e referenciadas no strings.json.
    const kinds = new Set(result.evidence.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["bundle_route", "bundle_string", "feature_flag"]));
    expect(result.document.routes.every((r) => typeof r.evidenceId === "string")).toBe(true);
    expect(evidenceStore.list(JOB_ID, { kind: "feature_flag", limit: 50 }).items).toHaveLength(2);

    const jobDir = evidenceStore.resolveJobDir(JOB_ID);
    const persisted = JSON.parse(readFileSync(join(jobDir, "analysis", "strings.json"), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.routes.length).toBe(result.document.routes.length);
    expect(result.stats.bundlesAnalyzed).toBe(1);
    expect(result.stats.errorStrings).toBeGreaterThanOrEqual(5);
  });

  it("nunca persiste bundle JS bruto: nenhum arquivo > 4 KB com código e nenhum trecho do bundle no diretório do job", async () => {
    const { createDemoApp, PUBLIC_APP_BUNDLE_JS } = await loadDemo();
    const demo = createDemoApp();
    const ctx = createTestContext(buildManifest());
    // Também simula o bundle presente no HAR (texto completo) para garantir que não vaze.
    await bundleAnalyzer(ctx, {
      fetch: demoFetch(demo),
      har: {
        log: {
          version: "1.2",
          creator: { name: "test", version: "1" },
          entries: [
            {
              _resourceType: "script",
              request: {
                method: "GET",
                url: `${DEMO_ORIGIN}/static/app.js`,
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: [],
                queryString: [],
                headersSize: -1,
                bodySize: 0,
              },
              response: {
                status: 200,
                statusText: "OK",
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: [],
                content: {
                  size: PUBLIC_APP_BUNDLE_JS.length,
                  mimeType: "application/javascript",
                  text: PUBLIC_APP_BUNDLE_JS,
                },
                redirectURL: "",
                headersSize: -1,
                bodySize: PUBLIC_APP_BUNDLE_JS.length,
              },
            },
          ],
        },
      } as never,
    });

    const jobDir = evidenceStore.resolveJobDir(JOB_ID);
    const files = listFilesRecursive(jobDir);
    expect(files.length).toBeGreaterThan(0);

    const bundle = PUBLIC_APP_BUNDLE_JS.replace(/\s+/g, " ");
    const windows: string[] = [];
    for (let i = 0; i + 120 <= bundle.length; i += 60) windows.push(bundle.slice(i, i + 120));

    for (const file of files) {
      expect(file).not.toMatch(/\.(?:m?js|map)$/i);
      const content = readFileSync(file, "utf8");
      const normalized = content.replace(/\s+/g, " ");
      for (const w of windows) expect(normalized.includes(w)).toBe(false);
      expect(content).not.toMatch(/\bfunction\s*\(|addEventListener|document\.querySelector/);
      if (statSync(file).size > 4096) {
        // Único artefato que pode passar de 4 KB é o índice estruturado (sem código).
        expect(file.endsWith(join("analysis", "strings.json"))).toBe(true);
      }
    }

    // Evidências não possuem blob.
    for (const kind of ["bundle_route", "bundle_string", "feature_flag"] as const) {
      for (const ev of evidenceStore.list(JOB_ID, { kind, limit: 500 }).items) {
        expect(ev.blobPath ?? null).toBeNull();
      }
    }
  });

  it("pula quando methods.staticBundles=false e lança quando throwOnMethodDisabled=true", async () => {
    const ctx = createTestContext(buildManifest({ staticBundles: false }));
    const fetchSpy = vi.fn();
    const result = await bundleAnalyzer(ctx, { fetch: fetchSpy as never });
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(bundleAnalyzer(ctx, { throwOnMethodDisabled: true })).rejects.toBeInstanceOf(
      MethodNotAllowedError,
    );
    expect(createBundleAnalyzerPhase().isEnabled?.(buildManifest({ staticBundles: false }))).toBe(
      false,
    );
  });

  it("respeita allowedOrigins/forbiddenPaths: não baixa scripts fora de escopo", async () => {
    const ctx = createTestContext(buildManifest());
    const fetchSpy = vi.fn(async () => new Response("", { status: 404 }));
    const result = await bundleAnalyzer(ctx, {
      fetch: fetchSpy as never,
      discoverFromPages: false,
      scriptUrls: ["https://cdn.evil.test/app.js", `${DEMO_ORIGIN}/admin/app.js`],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.stats.bundlesSkipped).toBe(2);
    expect(result.stats.bundlesAnalyzed).toBe(0);
  });

  it("consome analysis/scripts-index.json gerado pela fase capture (F1-07)", async () => {
    const { createDemoApp } = await loadDemo();
    const demo = createDemoApp();
    const ctx = createTestContext(buildManifest());
    const analysisDir = join(evidenceStore.resolveJobDir(JOB_ID), "analysis");
    mkdirSync(analysisDir, { recursive: true });
    writeFileSync(
      join(analysisDir, "scripts-index.json"),
      JSON.stringify([
        { url: `${DEMO_ORIGIN}/static/app.js`, sha256: "x", size: 1, hasSourceMap: false },
      ]),
    );
    const result = await bundleAnalyzer(ctx, { fetch: demoFetch(demo), discoverFromPages: false });
    expect(result.stats.bundlesAnalyzed).toBe(1);
    expect(result.document.featureFlags.map((f) => f.name)).toContain("pro_export");
  });

  it("usa source map público apenas para nomes de módulos, nunca sourcesContent", async () => {
    const ctx = createTestContext(buildManifest());
    const secretSource = "export function segredoInterno() { return 'CODIGO_PROPRIETARIO'; }";
    const map = {
      version: 3,
      sources: [
        "webpack://app/./src/routes/Projects.tsx",
        "webpack://app/./node_modules/react/index.js",
      ],
      sourcesContent: [secretSource, "react"],
      mappings: "",
    };
    const js = `const r={path:"/billing"};\n//# sourceMappingURL=app.js.map`;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(".map")) return new Response(JSON.stringify(map));
      return new Response(js, { headers: { "content-type": "application/javascript" } });
    }) as typeof globalThis.fetch;

    const result = await bundleAnalyzer(ctx, {
      fetch: fetchFn,
      discoverFromPages: false,
      scriptUrls: [`${DEMO_ORIGIN}/static/app.js`],
    });
    expect(result.document.bundles[0]?.sourceMap?.modules).toEqual(["src/routes/Projects.tsx"]);
    expect(result.document.routes.map((r) => r.path)).toContain("/billing");
    const persisted = readFileSync(result.outputPath ?? "", "utf8");
    expect(persisted).not.toContain("CODIGO_PROPRIETARIO");
    expect(persisted).not.toContain("sourcesContent");
  });
});

describe("helpers puros do bundleAnalyzer", () => {
  it("trunca literais a <= 100 caracteres e < 20 palavras", () => {
    const long = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(" ");
    const out = truncateExtractedString(long);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(100);
    expect(out.text.split(" ").length).toBeLessThan(20);
    expect(truncateExtractedString("Texto curto.")).toEqual({
      text: "Texto curto.",
      truncated: false,
    });
  });

  it("filtra ruído técnico e reconhece rotas JSX/createBrowserRouter", () => {
    expect(isLikelyUiString("application/json")).toBe(false);
    expect(isLikelyUiString("[data-feature='x']")).toBe(false);
    expect(isLikelyUiString("DOMContentLoaded")).toBe(false);
    expect(isLikelyUiString("Disponível apenas no plano Pro")).toBe(true);

    const a = analyzeBundleSource(
      `createBrowserRouter([{ path: "/settings" }]); const el = <Route path="/team" />; if (flag("beta_ui")) {}`,
    );
    expect(a.routes).toEqual(["/settings", "/team"]);
    expect(a.featureFlags.map((f) => f.name)).toEqual(["beta_ui"]);
  });

  it("extractSourceMapModuleNames ignora node_modules e sourcesContent", () => {
    expect(
      extractSourceMapModuleNames({
        sources: ["../src/a.ts", "webpack:///./node_modules/x/y.js"],
        sourcesContent: ["secret"],
      }),
    ).toEqual(["src/a.ts"]);
  });
});
