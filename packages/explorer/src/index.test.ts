import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserUnavailableError,
  type EvidenceStore,
  FakeLlmClient,
  type JobRecord,
  JobRunner,
  JobStore,
  type Manifest,
  type PhaseContext,
  type SqliteDatabase,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import type { Browser, BrowserContext, Page as PlaywrightPage } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  CAPTURE_PHASE_ID,
  EXPLORER_PHASE_ID,
  INTAKE_PHASE_ID,
  type IntakeCheckpoint,
  capturePhase,
  createCapturePhase,
  createIntakePhase,
  detectRenderingMode,
  detectTechSignatures,
  extractSitemapsFromRobots,
  normalizeViewport,
  parseSitemapXml,
  resolveViewportsList,
  runIntakePhase,
  sanitizeCdpText,
  sanitizeResponseHeaders,
  selectDesktopViewport,
  withBrowserSession,
} from "./index.js";

interface DemoAppModule {
  createDemoApp(): {
    app: {
      fetch(request: Request): Response | Promise<Response>;
    };
    store: {
      getStats(): {
        adminVisitsCount: number;
      };
    };
  };
}

const DEMO_ORIGIN = "https://demo.cleanroom.test";

function buildManifest(overrides?: {
  url?: string;
  type?: "web-spa" | "web-ssr" | "web-unknown";
  allowedOrigins?: string[];
  docsUrls?: string[];
  respectRobotsTxt?: boolean;
  captcha?: "handoff" | "abort";
  networkHar?: boolean;
}): Manifest {
  const origin = overrides?.url ? new URL(overrides.url).origin : DEMO_ORIGIN;
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-intake-test",
      description: "Teste automatizado da fase intake e BrowserSession",
      goals: ["Reconhecer alvo, robots, sitemap e tecnologias"],
    },
    target: {
      url: overrides?.url ?? DEMO_ORIGIN,
      type: overrides?.type ?? "web-unknown",
      allowedOrigins: overrides?.allowedOrigins ?? [origin],
      docsUrls: overrides?.docsUrls ?? [`${origin}/help`, `${origin}/pricing`],
    },
    ownership: "own",
    authorization: {
      basis: "Aplicação de demonstração própria do repositório para testes automatizados.",
      tosReviewed: true,
      evidence: null,
    },
    methods: {
      behavioralUi: true,
      networkHar: overrides?.networkHar ?? true,
      publicDocs: true,
      staticBundles: true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: 50,
      maxDepth: 4,
      maxDurationMin: 10,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["/admin", "**/admin/**", "**/logout"],
      destructiveActions: false,
      formSubmission: "validation-only",
      respectRobotsTxt: overrides?.respectRobotsTxt ?? true,
    },
    accounts: {
      strategy: "none",
    },
    humanInTheLoop: {
      captcha: overrides?.captcha ?? "abort",
      smsOtp: "abort",
      payments: "abort",
      handoffTimeoutMin: 5,
    },
    cleanup: {
      deleteAccountAtEnd: false,
      purgeHarSecrets: true,
      retainDays: 30,
    },
    report: {
      language: "pt-BR",
      viewports: [
        [375, 812],
        [768, 1024],
        [1440, 900],
      ],
    },
  });
}

describe("@cleanroom/explorer — Fase 1 intake (fetch, sem browser)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-explorer-intake-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestContext(
    manifest: Manifest,
    opts?: {
      checkpoint?: unknown;
      onSaveCheckpoint?: (cp: unknown) => void;
    },
  ): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: "job_test_f1_03",
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
      checkpoint: opts?.checkpoint,
      saveCheckpoint: (cp) => {
        opts?.onSaveCheckpoint?.(cp);
      },
      emit: () => undefined,
    };
  }

  it("exporta constantes de fase INTAKE_PHASE_ID e EXPLORER_PHASE_ID", () => {
    expect(INTAKE_PHASE_ID).toBe("intake");
    expect(EXPLORER_PHASE_ID).toBe("explore");
  });

  it("contra fixtures/demo-app via fetch: persiste http_response, robots, tech_signature, alimenta ScopeGuard e grava sementes no checkpoint", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = await demo.app.fetch(new Request(url, init));
      // Simula um Set-Cookie na resposta da home para comprovar que nunca é persistido
      if (new URL(url).pathname === "/") {
        const headers = new Headers(response.headers);
        headers.set("set-cookie", "session_id=secret_cookie_value; HttpOnly");
        headers.set("x-powered-by", "Hono");
        return new Response(await response.text(), {
          status: response.status,
          headers,
        });
      }
      return response;
    };

    let savedCheckpoint: IntakeCheckpoint | undefined;
    const manifest = buildManifest({
      docsUrls: [`${DEMO_ORIGIN}/help`, `${DEMO_ORIGIN}/pricing`, "https://evil.example.com/docs"],
    });
    const ctx = createTestContext(manifest, {
      onSaveCheckpoint: (cp) => {
        savedCheckpoint = cp as IntakeCheckpoint;
      },
    });

    const result = await runIntakePhase(ctx, { fetch: fetchViaDemoApp });

    expect(result.phaseResult.status).toBe("ok");
    expect(savedCheckpoint).toBeDefined();

    // 1. Verifica persistência das 3 evidências obrigatórias: http_response, robots, tech_signature
    const httpEvidences = evidenceStore.list(ctx.job.id, { kind: "http_response" }).items;
    const robotsEvidences = evidenceStore.list(ctx.job.id, { kind: "robots" }).items;
    const techEvidences = evidenceStore.list(ctx.job.id, { kind: "tech_signature" }).items;

    expect(httpEvidences).toHaveLength(1);
    expect(robotsEvidences).toHaveLength(1);
    expect(techEvidences).toHaveLength(1);

    // 2. Verifica http_response sem cookies
    const httpEv = httpEvidences[0];
    expect(httpEv).toBeDefined();
    expect(httpEv?.data.status).toBe(200);
    const recordedHeaders = (httpEv?.data.headers ?? {}) as Record<string, string>;
    expect(recordedHeaders["content-type"]).toContain("text/html");
    expect(recordedHeaders["x-powered-by"]).toBe("Hono");
    expect(recordedHeaders["set-cookie"]).toBeUndefined();
    expect(recordedHeaders.cookie).toBeUndefined();
    const httpBlob = evidenceStore.readBlob(ctx.job.id, httpEv?.id ?? "")?.toString("utf8") ?? "";
    expect(httpBlob).not.toContain("secret_cookie_value");

    // 3. Verifica robots.txt e alimentação do ScopeGuard
    const robotsEv = robotsEvidences[0];
    expect(robotsEv?.data.found).toBe(true);
    expect(robotsEv?.data.disallow).toEqual(["/admin", "/logout"]);
    expect(robotsEv?.data.sitemaps).toEqual([`${DEMO_ORIGIN}/sitemap.xml`]);

    // Verifica que Tech Signature detectou SSR e Hono na demo-app
    const techEv = techEvidences[0];
    expect(techEv?.data.targetType).toBe("web-ssr");
    expect(techEv?.data.renderingMode).toBe("ssr");
    const detectedNames = ((techEv?.data.technologies ?? []) as { name: string }[]).map(
      (t) => t.name,
    );
    expect(detectedNames).toContain("Hono");

    // 4. Verifica fila de sementes no checkpoint (entrada + sitemap + docsUrls dentro de allowedOrigins)
    expect(savedCheckpoint?.seedUrls).toEqual([
      `${DEMO_ORIGIN}/`,
      `${DEMO_ORIGIN}/projects`,
      `${DEMO_ORIGIN}/projects/new`,
      `${DEMO_ORIGIN}/pricing`,
      `${DEMO_ORIGIN}/help`,
      `${DEMO_ORIGIN}/login`,
    ]);
    // Nunca inclui /admin, /logout nem URLs fora de allowedOrigins
    expect(savedCheckpoint?.seedUrls).not.toContain(`${DEMO_ORIGIN}/admin`);
    expect(savedCheckpoint?.seedUrls).not.toContain(`${DEMO_ORIGIN}/logout`);
    expect(savedCheckpoint?.seedUrls.some((u) => u.includes("evil.example.com"))).toBe(false);

    // Garante que nenhuma requisição tocou /admin
    expect(demo.store.getStats().adminVisitsCount).toBe(0);

    // 5. Verifica idempotência: rodar de novo não duplica evidências
    await runIntakePhase(ctx, { fetch: fetchViaDemoApp });
    expect(evidenceStore.list(ctx.job.id, { kind: "http_response" }).items).toHaveLength(1);
    expect(evidenceStore.list(ctx.job.id, { kind: "robots" }).items).toHaveLength(1);
    expect(evidenceStore.list(ctx.job.id, { kind: "tech_signature" }).items).toHaveLength(1);
  });

  it("alimenta o ScopeGuard com regras Disallow do /robots.txt quando limits.respectRobotsTxt é true", async () => {
    const customFetch: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      if (parsed.pathname === "/robots.txt") {
        return new Response(
          [
            "User-agent: *",
            "Allow: /public",
            "Disallow: /internal- area",
            "Disallow: /private-docs",
            `Sitemap: ${DEMO_ORIGIN}/sitemap.xml`,
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      if (parsed.pathname === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <urlset>
            <url><loc>${DEMO_ORIGIN}/public</loc></url>
            <url><loc>${DEMO_ORIGIN}/private-docs</loc></url>
            <url><loc>${DEMO_ORIGIN}/private-docs/guide</loc></url>
            <url><loc>https://other-origin.example.com/page</loc></url>
          </urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response(
        `<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const manifest = buildManifest({ respectRobotsTxt: true, docsUrls: [] });
    const ctx = createTestContext(manifest);

    // Antes do intake, /private-docs era permitido pelo ScopeGuard
    expect(ctx.guard.canNavigate(`${DEMO_ORIGIN}/private-docs`)).toBe(true);

    const result = await runIntakePhase(ctx, { fetch: customFetch });

    // Após o intake, o ScopeGuard bloqueia /private-docs por causa do /robots.txt
    expect(ctx.guard.canNavigate(`${DEMO_ORIGIN}/private-docs`)).toBe(false);
    expect(ctx.guard.canNavigate(`${DEMO_ORIGIN}/private-docs/guide`)).toBe(false);
    expect(ctx.guard.canNavigate(`${DEMO_ORIGIN}/public`)).toBe(true);

    // E as sementes do sitemap já foram filtradas pelo ScopeGuard atualizado
    expect(result.checkpoint?.seedUrls).toEqual([`${DEMO_ORIGIN}/`, `${DEMO_ORIGIN}/public`]);
    expect(result.checkpoint?.targetType).toBe("web-spa");
    expect(result.checkpoint?.renderingMode).toBe("spa");
  });

  it("integra com JobRunner persistindo o checkpoint da fase intake no SQLite", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return demo.app.fetch(new Request(url, init));
    };

    const manifest = buildManifest();
    const jobStore = new JobStore({ db, dataDir: tempDir });
    const created = jobStore.createJob({
      id: "job_runner_intake_01",
      name: manifest.job.name,
      manifest,
      manifestYaml: "version: 1\n",
    });
    jobStore.transition(created.id, "validating_manifest");
    jobStore.transition(created.id, "running");

    const phase = createIntakePhase({ fetch: fetchViaDemoApp });
    const runner = new JobRunner({
      store: jobStore,
      evidence: evidenceStore,
      phases: [phase],
      logger: createLogger({ level: "silent" }),
      guardFactory: (m: Manifest) => createScopeGuard(m, { sleep: async () => undefined }),
    });

    const finishedJob = await runner.run(created.id, { enabledPhases: ["intake"] });
    expect(finishedJob.state).toBe("completed");

    const phaseRecord = jobStore.getPhase(created.id, "intake");
    expect(phaseRecord?.status).toBe("done");
    const cp = phaseRecord?.checkpoint as IntakeCheckpoint;
    expect(cp.targetType).toBe("web-ssr");
    expect(cp.seedUrls).toContain(`${DEMO_ORIGIN}/projects`);
    expect(cp.evidenceIds.httpResponse).toMatch(/^ev_/);
    expect(cp.evidenceIds.robots).toMatch(/^ev_/);
    expect(cp.evidenceIds.techSignature).toMatch(/^ev_/);
  });

  it("retorna status blocked em HTTP 403 e awaiting_human em desafio anti-bot quando configurado", async () => {
    const fetch403: typeof globalThis.fetch = async () =>
      new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });

    const ctxBlocked = createTestContext(buildManifest({ captcha: "abort" }));
    const blockedRes = await runIntakePhase(ctxBlocked, { fetch: fetch403 });
    expect(blockedRes.phaseResult.status).toBe("blocked");

    const fetchChallenge: typeof globalThis.fetch = async () =>
      new Response('<html><body><div class="cf-turnstile"></div>Just a moment...</body></html>', {
        status: 403,
        headers: { "content-type": "text/html", "cf-ray": "12345" },
      });

    const ctxHandoff = createTestContext(buildManifest({ captcha: "handoff" }));
    const handoffRes = await runIntakePhase(ctxHandoff, { fetch: fetchChallenge });
    expect(handoffRes.phaseResult.status).toBe("awaiting_human");
  });

  it("detecta corretamente SPA vs SSR e assinaturas de Next.js, Nuxt, React, Vue, Angular e Flutter Web", () => {
    // Next.js + React
    const nextHtml = `<!DOCTYPE html><html><head></head><body><div id="__next"><main><h1>Dashboard</h1><section><p>${"Conteúdo renderizado no servidor ".repeat(5)}</p></section></main></div><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script></body></html>`;
    const nextTechs = detectTechSignatures(nextHtml, { "x-nextjs-cache": "HIT" });
    expect(nextTechs.map((t) => t.name)).toContain("Next.js");
    expect(nextTechs.map((t) => t.name)).toContain("React");
    expect(detectRenderingMode(nextHtml, nextTechs).targetType).toBe("web-ssr");

    // Nuxt + Vue
    const nuxtHtml = `<!DOCTYPE html><html><body><div id="__nuxt"><main data-v-1234abcd><section><h1>App Nuxt</h1></section></main></div><script>window.__NUXT__={};</script><script src="/_nuxt/entry.js"></script></body></html>`;
    const nuxtTechs = detectTechSignatures(nuxtHtml);
    expect(nuxtTechs.map((t) => t.name)).toContain("Nuxt");
    expect(nuxtTechs.map((t) => t.name)).toContain("Vue");
    expect(detectRenderingMode(nuxtHtml, nuxtTechs).targetType).toBe("web-ssr");

    // Angular SPA
    const angularSpaHtml = `<!DOCTYPE html><html><body><app-root></app-root><script src="runtime.js"></script><script src="zone.js"></script><script src="main.a1b2c3d4.js"></script></body></html>`;
    const angularTechs = detectTechSignatures(angularSpaHtml);
    expect(angularTechs.map((t) => t.name)).toContain("Angular");
    expect(detectRenderingMode(angularSpaHtml, angularTechs).targetType).toBe("web-spa");

    // Flutter Web SPA
    const flutterHtml = `<!DOCTYPE html><html><body><script src="flutter_bootstrap.js" async></script></body></html>`;
    const flutterTechs = detectTechSignatures(flutterHtml);
    expect(flutterTechs.map((t) => t.name)).toContain("Flutter Web");
    expect(detectRenderingMode(flutterHtml, flutterTechs).targetType).toBe("web-spa");

    // React CSR SPA (<div id="root"></div> vazio)
    const reactSpaHtml = `<!DOCTYPE html><html><body><div id="root"></div><script src="/assets/react.production.min.js"></script><script src="/assets/index.js"></script></body></html>`;
    const reactTechs = detectTechSignatures(reactSpaHtml);
    expect(reactTechs.map((t) => t.name)).toContain("React");
    expect(detectRenderingMode(reactSpaHtml, reactTechs).targetType).toBe("web-spa");
  });

  it("sanitizeResponseHeaders remove qualquer cookie, token ou header de autenticação", () => {
    const sanitized = sanitizeResponseHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "sid=12345; Secure",
      Cookie: "sid=12345",
      Authorization: "Bearer secret",
      "X-Api-Key": "secret-key",
      "X-Csrf-Token": "csrf-secret",
      Server: "cloudflare",
      "X-Powered-By": "Next.js",
    });

    expect(sanitized).toEqual({
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      "x-powered-by": "Next.js",
    });
  });

  it("parseSitemapXml e extractSitemapsFromRobots filtram URLs por allowedOrigins e suportam sitemapindex", () => {
    const robots = [
      "User-agent: *",
      "Disallow: /admin",
      `Sitemap: ${DEMO_ORIGIN}/sitemap-index.xml`,
      "Sitemap: https://external.example.com/sitemap.xml",
    ].join("\n");

    const sitemaps = extractSitemapsFromRobots(robots, DEMO_ORIGIN);
    expect(sitemaps).toEqual([
      `${DEMO_ORIGIN}/sitemap-index.xml`,
      "https://external.example.com/sitemap.xml",
    ]);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex>
        <sitemap><loc>${DEMO_ORIGIN}/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://external.example.com/sitemap-other.xml</loc></sitemap>
      </sitemapindex>
      <urlset>
        <url><loc><![CDATA[${DEMO_ORIGIN}/projects?page=1]]></loc></url>
        <url><loc>https://external.example.com/secret</loc></url>
      </urlset>`;

    const parsed = parseSitemapXml(xml, {
      baseOrigin: DEMO_ORIGIN,
      allowedOrigins: [DEMO_ORIGIN],
    });

    expect(parsed.childSitemaps).toEqual([`${DEMO_ORIGIN}/sitemap-pages.xml`]);
    expect(parsed.urls).toEqual([`${DEMO_ORIGIN}/projects?page=1`]);
  });
});

describe("@cleanroom/explorer — BrowserSession (unitário + mocks CDP)", () => {
  function createMockBrowserStack(opts?: {
    newContextThrows?: Error;
    contextCloseThrows?: Error;
    browserCloseThrows?: Error;
  }) {
    const viewportHistory: { width: number; height: number }[] = [];
    let pageClosed = false;

    const mockPage = {
      setViewportSize: vi.fn(async (vp: { width: number; height: number }) => {
        viewportHistory.push({ ...vp });
      }),
      isClosed: vi.fn(() => pageClosed),
      close: vi.fn(async () => {
        pageClosed = true;
      }),
      goto: vi.fn(async () => null),
    } as unknown as PlaywrightPage;

    const openPages: PlaywrightPage[] = [];

    const mockContext = {
      newPage: vi.fn(async () => {
        openPages.push(mockPage);
        return mockPage;
      }),
      pages: vi.fn(() => openPages),
      close: vi.fn(async () => {
        if (opts?.contextCloseThrows) {
          throw opts.contextCloseThrows;
        }
      }),
    } as unknown as BrowserContext;

    const mockBrowser = {
      newContext: vi.fn(async () => {
        if (opts?.newContextThrows) {
          throw opts.newContextThrows;
        }
        return mockContext;
      }),
      close: vi.fn(async () => {
        if (opts?.browserCloseThrows) {
          throw opts.browserCloseThrows;
        }
      }),
      version: vi.fn(() => "HeadlessChrome/131.0"),
    } as unknown as Browser;

    const connector = vi.fn(async () => mockBrowser);

    return {
      connector,
      mockBrowser,
      mockContext,
      mockPage,
      viewportHistory,
    };
  }

  it("valida wsEndpoint, redige tokens em erros e seleciona viewport desktop padrão", async () => {
    await expect(BrowserSession.connect({ wsEndpoint: "" })).rejects.toThrowError(
      BrowserUnavailableError,
    );
    await expect(
      BrowserSession.connect({ wsEndpoint: "http://localhost:9222?token=super_secret_123" }),
    ).rejects.toThrowError(BrowserUnavailableError);

    expect(sanitizeCdpText("ws://localhost:9222?token=my_secret_token")).toBe(
      "ws://localhost:9222?token=[REDACTED]",
    );

    const viewports = resolveViewportsList([
      [375, 812],
      [768, 1024],
      [1440, 900],
    ]);
    expect(selectDesktopViewport(viewports)).toEqual({ width: 1440, height: 900 });
    expect(() => normalizeViewport([100, 100])).toThrowError(RangeError);
  });

  it("cria BrowserContext isolado por job, gerencia viewports (375/768/1440) e restaura viewport em finally", async () => {
    const { connector, mockBrowser, mockContext, viewportHistory } = createMockBrowserStack();
    const manifest = buildManifest();

    await withBrowserSession(
      {
        wsEndpoint: "ws://localhost:9222?token=test_token",
        manifest,
        cdpConnector: connector,
      },
      async (session) => {
        expect(session.defaultViewport).toEqual({ width: 1440, height: 900 });
        expect(session.currentViewport).toEqual({ width: 1440, height: 900 });

        const page = await session.getPage();
        expect(page).toBeDefined();

        // Testa withViewport restaurando o viewport original mesmo quando fn lança erro
        await expect(
          session.withViewport([375, 812], async (_p, vp) => {
            expect(vp).toEqual({ width: 375, height: 812 });
            expect(session.currentViewport).toEqual({ width: 375, height: 812 });
            throw new Error("erro simulado durante captura mobile");
          }),
        ).rejects.toThrow("erro simulado durante captura mobile");

        // Deve ter restaurado para 1440x900 no finally
        expect(session.currentViewport).toEqual({ width: 1440, height: 900 });

        // Testa forEachViewport passando por 375x812, 768x1024, 1440x900 e restaurando ao final
        const visited = await session.forEachViewport(async (vp) => `${vp.width}x${vp.height}`);
        expect(visited).toEqual(["375x812", "768x1024", "1440x900"]);
        expect(session.currentViewport).toEqual({ width: 1440, height: 900 });
      },
    );

    expect(viewportHistory.length).toBeGreaterThanOrEqual(5);
    expect(mockContext.close).toHaveBeenCalledTimes(1);
    expect(mockBrowser.close).toHaveBeenCalledTimes(1);
  });

  it("garante fechamento de context e browser em bloco finally mesmo quando o job falha ou context.close lança erro", async () => {
    const stack1 = createMockBrowserStack();
    await expect(
      BrowserSession.withSession(
        {
          wsEndpoint: "ws://localhost:9222",
          cdpConnector: stack1.connector,
        },
        async () => {
          throw new Error("falha na fase explore");
        },
      ),
    ).rejects.toThrow("falha na fase explore");

    expect(stack1.mockContext.close).toHaveBeenCalledTimes(1);
    expect(stack1.mockBrowser.close).toHaveBeenCalledTimes(1);

    // Se context.close() falhar, browser.close() ainda DEVE rodar no finally
    const stack2 = createMockBrowserStack({
      contextCloseThrows: new Error("falha no context.close token=secret123"),
    });
    const session2 = await BrowserSession.connect({
      wsEndpoint: "ws://localhost:9222",
      cdpConnector: stack2.connector,
    });
    await expect(session2.close()).rejects.toThrowError(BrowserUnavailableError);
    expect(stack2.mockContext.close).toHaveBeenCalledTimes(1);
    expect(stack2.mockBrowser.close).toHaveBeenCalledTimes(1);

    // Se browser.newContext() falhar durante connect, browser.close() ainda DEVE rodar no finally
    const stack3 = createMockBrowserStack({
      newContextThrows: new Error("sem memória para contexto"),
    });
    await expect(
      BrowserSession.connect({
        wsEndpoint: "ws://localhost:9222",
        cdpConnector: stack3.connector,
      }),
    ).rejects.toThrowError(BrowserUnavailableError);
    expect(stack3.mockBrowser.close).toHaveBeenCalledTimes(1);
  });

  it("exporta constantes e fábricas da Fase 3 capture (CAPTURE_PHASE_ID, createCapturePhase, capturePhase)", () => {
    expect(CAPTURE_PHASE_ID).toBe("capture");
    expect(capturePhase.id).toBe("capture");

    const manifestWithHar = buildManifest({ networkHar: true });
    expect(capturePhase.isEnabled?.(manifestWithHar)).toBe(true);

    const manifestWithoutHar = buildManifest({ networkHar: false });
    expect(capturePhase.isEnabled?.(manifestWithoutHar)).toBe(false);
  });
});

describe.skipIf(!process.env.CLEANROOM_BROWSER_WS_ENDPOINT)(
  "@cleanroom/explorer — BrowserSession E2E (CDP Browserless)",
  () => {
    it("conecta ao Browserless via CDP, cria BrowserContext isolado, alterna viewports e encerra em finally", async () => {
      let closedAfterRun = false;
      let sessionRef: BrowserSession | undefined;

      await BrowserSession.withSession(
        {
          wsEndpoint: process.env.CLEANROOM_BROWSER_WS_ENDPOINT,
          jobId: "job_e2e_cdp_f1_03",
        },
        async (session) => {
          sessionRef = session;
          const page = await session.getPage();
          await page.goto("about:blank");

          const observedSizes = await session.forEachViewport(async (vp, p) => {
            const inner = (await p.evaluate(
              "({ w: window.innerWidth, h: window.innerHeight })",
            )) as {
              w: number;
              h: number;
            };
            expect(inner).toEqual({ w: vp.width, h: vp.height });
            return `${inner.w}x${inner.h}`;
          });

          expect(observedSizes).toEqual(["375x812", "768x1024", "1440x900"]);
        },
      );

      closedAfterRun = sessionRef?.isClosed ?? false;
      expect(closedAfterRun).toBe(true);
    });
  },
);
