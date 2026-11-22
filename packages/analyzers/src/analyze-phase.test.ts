import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PhaseContext,
  type SqliteDatabase,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalyzePhase } from "./index.js";

describe("@cleanroom/analyzers — composite analyzePhase", () => {
  let tempDir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-analyze-phase-"));
    db = openDatabase({ dataDir: tempDir });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("executa harToOpenApi, docsHarvester e bundleAnalyzer em paralelo com checkpoints isolados", async () => {
    const origin = "http://localhost:4199";
    const manifest = parseManifestObject({
      version: 1,
      job: {
        name: "analyze-composite-test",
        goals: ["Testar fase analyze composta"],
      },
      target: {
        url: origin,
        type: "web-ssr",
        allowedOrigins: [origin],
        docsUrls: [`${origin}/help`, `${origin}/pricing`],
      },
      ownership: "own",
      authorization: {
        basis: "Teste automatizado interno de fase analyze.",
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
        maxPages: 20,
        maxDepth: 2,
        maxDurationMin: 5,
        rateLimitRps: 5,
        maxAccounts: 0,
        forbiddenPaths: [],
        destructiveActions: false,
        formSubmission: "validation-only",
        respectRobotsTxt: false,
      },
      accounts: { strategy: "none" },
      humanInTheLoop: {
        captcha: "abort",
        smsOtp: "abort",
        payments: "abort",
        handoffTimeoutMin: 5,
      },
      cleanup: {
        deleteAccountAtEnd: false,
        purgeHarSecrets: true,
        retainDays: 7,
      },
      report: {
        language: "pt-BR",
        viewports: [[1440, 900]],
      },
    });

    const evidence = createEvidenceStore({ db, dataDir: tempDir });
    const jobId = "cr-20261122-analyze-0001";
    evidence.put({
      jobId,
      kind: "network_call",
      phase: "capture",
      url: `${origin}/api/items?page=1`,
      summary: "GET /api/items -> 200",
      data: {
        method: "GET",
        url: `${origin}/api/items?page=1`,
        urlTemplate: `${origin}/api/items`,
        pathTemplate: "/api/items",
        status: 200,
        safeEnumSamples: { status: ["draft", "active"] },
        resShape: { items: [{ id: "string", status: "string" }] },
      },
    });

    const savedCheckpoints: unknown[] = [];
    const emittedTypes: string[] = [];

    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/help")) {
        return new Response(
          "<html><head><title>Ajuda</title></head><body><main><h1>Ajuda</h1><h2>Projetos</h2><p>Validação de nome e orçamento.</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.endsWith("/pricing")) {
        return new Response(
          "<html><head><title>Planos</title></head><body><main><h1>Planos</h1><table><thead><tr><th>Plano</th><th>Preço</th><th>Projetos</th></tr></thead><tbody><tr><td>Free</td><td>R$ 0/mês</td><td>Até 3 projetos</td></tr></tbody></table></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.endsWith("/assets/app.js")) {
        return new Response(
          'const route = "/projects"; const flag = isEnabled("pro_export"); const err = "Nome obrigatório.";',
          { status: 200, headers: { "content-type": "application/javascript" } },
        );
      }
      return new Response(
        '<html><head><title>Home</title></head><body><main><h1>Home</h1></main><script src="/assets/app.js"></script></body></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const ctx: PhaseContext = {
      job: {
        id: jobId,
        name: manifest.job.name,
        state: "running",
        manifest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        llmTokensIn: 0,
        llmTokensOut: 0,
      },
      manifest,
      guard: createScopeGuard(manifest, { sleep: async () => undefined }),
      evidence,
      llm: {
        async generateObject() {
          throw new Error("não utilizado na fase analyze");
        },
      },
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: (cp) => {
        savedCheckpoints.push(cp);
      },
      emit: (ev) => {
        emittedTypes.push(ev.type);
      },
    };

    const phase = createAnalyzePhase({ fetch: mockFetch });
    expect(phase.id).toBe("analyze");
    expect(phase.isEnabled?.(manifest)).toBe(true);

    const res = await phase.run(ctx);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.stats.openApiOperations).toBeGreaterThanOrEqual(1);
      expect(res.stats.docSections).toBeGreaterThanOrEqual(1);
      expect(res.stats.pricingPlans).toBeGreaterThanOrEqual(1);
      expect(res.stats.bundlesAnalyzed).toBe(1);
    }

    const jobDir = evidence.resolveJobDir(jobId);
    expect(existsSync(join(jobDir, "analysis", "openapi.yaml"))).toBe(true);
    expect(existsSync(join(jobDir, "analysis", "strings.json"))).toBe(true);
    expect(readFileSync(join(jobDir, "analysis", "openapi.yaml"), "utf8")).toContain("/api/items");

    const lastCheckpoint = savedCheckpoints[savedCheckpoints.length - 1] as Record<string, unknown>;
    expect(lastCheckpoint).toHaveProperty("harToOpenApi");
    expect(lastCheckpoint).toHaveProperty("docsHarvester");
    expect(lastCheckpoint).toHaveProperty("bundleAnalyzer");
    expect(emittedTypes).toContain("analyze_completed");
  });
});
