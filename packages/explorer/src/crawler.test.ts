import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceStore,
  FakeLlmClient,
  type JobEvent,
  type JobRecord,
  JobRunner,
  JobStore,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ExploreCheckpoint,
  type StateGraph,
  computeStateFingerprint,
  createExplorePhase,
  createIntakePhase,
  detectExploreChallenge,
  detectPaginationInfo,
  extractCandidateActionsFromHtml,
  extractInteractiveDomTreeFromHtml,
  isTrackingQueryParam,
  normalizeUrlForFingerprint,
  parseRetryAfterMs,
  resolveStateGraphPath,
  runExplorePhase,
  runIntakePhase,
  validateStateGraph,
} from "./index.js";

interface DemoProjectRecord {
  id: string;
  name: string;
  status: string;
}

interface DemoAppModule {
  createDemoApp(): {
    app: {
      fetch(request: Request): Response | Promise<Response>;
    };
    store: {
      getProject(id: string): DemoProjectRecord | undefined;
      getStats(): {
        adminVisitsCount: number;
        deletedProjectsCount: number;
        totalProjects: number;
      };
    };
  };
}

const DEMO_ORIGIN = "https://demo.cleanroom.test";

function buildExploreManifest(overrides?: {
  url?: string;
  allowedOrigins?: string[];
  docsUrls?: string[];
  maxPages?: number;
  maxDepth?: number;
  maxDurationMin?: number;
  rateLimitRps?: number;
  forbiddenPaths?: string[];
  destructiveActions?: boolean;
  respectRobotsTxt?: boolean;
  behavioralUi?: boolean;
  captcha?: "handoff" | "abort";
}): Manifest {
  const origin = overrides?.url ? new URL(overrides.url).origin : DEMO_ORIGIN;
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-explore-test",
      description: "Teste automatizado da fase explore (crawler BFS, fingerprint e state graph)",
      goals: ["Explorar estados da UI com segurança e construir state-graph.json"],
    },
    target: {
      url: overrides?.url ?? DEMO_ORIGIN,
      type: "web-ssr",
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
      behavioralUi: overrides?.behavioralUi ?? true,
      networkHar: true,
      publicDocs: true,
      staticBundles: true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: overrides?.maxPages ?? 50,
      maxDepth: overrides?.maxDepth ?? 4,
      maxDurationMin: overrides?.maxDurationMin ?? 10,
      rateLimitRps: overrides?.rateLimitRps ?? 5,
      maxAccounts: 0,
      forbiddenPaths: overrides?.forbiddenPaths ?? ["/admin", "**/admin/**", "**/logout"],
      destructiveActions: overrides?.destructiveActions ?? false,
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

describe("@cleanroom/explorer — Fingerprint de estado, árvore interativa e classificação de ações", () => {
  it("normaliza URL removendo query params de tracking e fragmentos, preservando query params funcionais", () => {
    expect(isTrackingQueryParam("utm_source")).toBe(true);
    expect(isTrackingQueryParam("UTM_CAMPAIGN")).toBe(true);
    expect(isTrackingQueryParam("fbclid")).toBe(true);
    expect(isTrackingQueryParam("gclid")).toBe(true);
    expect(isTrackingQueryParam("_ga")).toBe(true);
    expect(isTrackingQueryParam("page")).toBe(false);
    expect(isTrackingQueryParam("filter")).toBe(false);

    const url1 =
      "https://demo.cleanroom.test/projects/?utm_source=newsletter&page=2&fbclid=xyz123&filter=active#section-top";
    const url2 =
      "https://demo.cleanroom.test/projects?filter=active&page=2&utm_medium=email&gclid=abc999";

    expect(normalizeUrlForFingerprint(url1)).toBe(
      "https://demo.cleanroom.test/projects?filter=active&page=2",
    );
    expect(normalizeUrlForFingerprint(url1)).toBe(normalizeUrlForFingerprint(url2));
  });

  it("calcula o mesmo fingerprint SHA-256 quando apenas textos ou parâmetros de tracking mudam, e altera quando a estrutura interativa muda", () => {
    const htmlUserA = `<!DOCTYPE html>
      <html>
        <body>
          <header><nav><a href="/projects">Meus Projetos (12)</a></nav></header>
          <main>
            <h1>Olá, Maria!</h1>
            <p>Texto dinâmico longo que não deve afetar o fingerprint do estado.</p>
            <div style="display: none"><button type="button">Botão Oculto</button></div>
            <input type="hidden" name="csrf" value="random-token-123" />
            <form action="/api/projects" method="post">
              <input type="text" name="name" required />
              <button type="submit">Salvar agora</button>
            </form>
          </main>
        </body>
      </html>`;

    const htmlUserB = `<!DOCTYPE html>
      <html>
        <body>
          <header><nav><a href="/projects">Projects (999)</a></nav></header>
          <main>
            <h1>Welcome back, João!</h1>
            <p>Outro texto completamente diferente na mesma estrutura de tela.</p>
            <form action="/api/projects" method="post">
              <input type="text" name="name" required />
              <button type="submit">Create Project</button>
            </form>
          </main>
        </body>
      </html>`;

    const htmlWithExtraAction = `<!DOCTYPE html>
      <html>
        <body>
          <header><nav><a href="/projects">Projects</a></nav></header>
          <main>
            <form action="/api/projects" method="post">
              <input type="text" name="name" required />
              <button type="submit">Create Project</button>
            </form>
            <button type="button" data-feature="pro_export">Exportar</button>
          </main>
        </body>
      </html>`;

    const treeA = extractInteractiveDomTreeFromHtml(htmlUserA);
    const treeB = extractInteractiveDomTreeFromHtml(htmlUserB);
    const treeExtra = extractInteractiveDomTreeFromHtml(htmlWithExtraAction);

    const fpA = computeStateFingerprint(
      "https://demo.cleanroom.test/projects/new?utm_source=ads",
      treeA,
    );
    const fpB = computeStateFingerprint(
      "https://demo.cleanroom.test/projects/new?fbclid=12345#form",
      treeB,
    );
    const fpExtra = computeStateFingerprint("https://demo.cleanroom.test/projects/new", treeExtra);

    expect(fpA).toMatch(/^[a-f0-9]{64}$/);
    expect(fpA).toBe(fpB);
    expect(fpExtra).not.toBe(fpA);
  });

  it("extrai e classifica ações candidatas com a prioridade correta (main-nav > tabs-menus > content-links > pagination) e identifica destrutivas/externas", () => {
    const manifest = buildExploreManifest();
    const guard = createScopeGuard(manifest);

    const html = `<!DOCTYPE html>
      <html>
        <body>
          <header>
            <nav aria-label="Principal">
              <a href="/projects">Projetos</a>
              <a href="/pricing">Preços</a>
            </nav>
          </header>
          <main>
            <div role="tablist">
              <a role="tab" href="/projects?status=active">Ativos</a>
              <button type="button" aria-haspopup="dialog">Abrir filtro</button>
            </div>
            <section>
              <a href="/projects/proj_alpha">Ver projeto Alpha</a>
              <a href="https://external.example.com/docs">Documentação Externa</a>
            </section>
            <form id="delete-form" action="/api/projects/proj_alpha/delete" method="post">
              <button type="submit" class="destructive" data-action="delete">Excluir projeto</button>
            </form>
            <form id="create-form" action="/api/projects" method="post">
              <button type="submit">Criar projeto</button>
            </form>
            <nav aria-label="Paginação">
              <a href="/projects?page=1">Página 1</a>
              <a href="/projects?page=2">Página 2</a>
            </nav>
          </main>
          <footer>
            <a href="/logout">Sair</a>
          </footer>
        </body>
      </html>`;

    const actions = extractCandidateActionsFromHtml(html, `${DEMO_ORIGIN}/projects`, guard);

    const byLabel = new Map(actions.map((a) => [a.label, a]));

    expect(byLabel.get("Projetos")?.kind).toBe("navigate");
    expect(byLabel.get("Projetos")?.priorityBucket).toBe("main-nav");
    expect(byLabel.get("Projetos")?.priority).toBe(1);

    expect(byLabel.get("Ativos")?.kind).toBe("navigate");
    expect(byLabel.get("Ativos")?.priorityBucket).toBe("tabs-menus");
    expect(byLabel.get("Ativos")?.priority).toBe(2);

    expect(byLabel.get("Abrir filtro")?.kind).toBe("open-overlay");
    expect(byLabel.get("Abrir filtro")?.priority).toBe(2);

    expect(byLabel.get("Ver projeto Alpha")?.kind).toBe("navigate");
    expect(byLabel.get("Ver projeto Alpha")?.priorityBucket).toBe("content-links");
    expect(byLabel.get("Ver projeto Alpha")?.priority).toBe(3);

    expect(byLabel.get("Página 2")?.kind).toBe("navigate");
    expect(byLabel.get("Página 2")?.priorityBucket).toBe("pagination");
    expect(byLabel.get("Página 2")?.priority).toBe(4);
    expect(byLabel.get("Página 2")?.paginationListKey).toBe(`${DEMO_ORIGIN}/projects`);
    expect(byLabel.get("Página 2")?.paginationPage).toBe("page:2");

    expect(byLabel.get("Excluir projeto")?.kind).toBe("destructive");
    expect(byLabel.get("Sair")?.kind).toBe("destructive");
    expect(byLabel.get("Documentação Externa")?.kind).toBe("external");
    expect(byLabel.get("Criar projeto")?.kind).toBe("submit-form");

    // Verifica ordenação por prioridade nas ações navegáveis
    const navigableBuckets = actions
      .filter((a) => a.kind === "navigate")
      .map((a) => a.priorityBucket);
    expect(navigableBuckets).toEqual([
      "main-nav",
      "main-nav",
      "tabs-menus",
      "content-links",
      "pagination",
      "pagination",
    ]);

    expect(detectPaginationInfo(`${DEMO_ORIGIN}/articles/page/3`, "3", undefined, false)).toEqual({
      listKey: `${DEMO_ORIGIN}/articles`,
      page: "page:3",
    });
  });
});

describe("@cleanroom/explorer — Fase 2 explore (BFS crawler e state-graph contra fixtures/demo-app)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-explorer-crawl-"));
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
      jobId?: string;
      checkpoint?: unknown;
      onSaveCheckpoint?: (cp: unknown) => void;
      onEmit?: (ev: JobEvent) => void;
      signal?: AbortSignal;
    },
  ): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: opts?.jobId ?? "job_test_f1_04",
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
      signal: opts?.signal ?? new AbortController().signal,
      checkpoint: opts?.checkpoint,
      saveCheckpoint: (cp) => {
        opts?.onSaveCheckpoint?.(cp);
      },
      emit: (ev) => {
        opts?.onEmit?.(ev);
      },
    };
  }

  it("explora fixtures/demo-app descobrindo home, lista, detalhes, novo projeto, pricing e help, sem nunca visitar /admin nem clicar em Excluir/Sair, e grava state-graph.json válido", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const requestedUrls: { method: string; path: string }[] = [];
    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req = new Request(url, init);
      const parsed = new URL(req.url);
      requestedUrls.push({ method: req.method, path: `${parsed.pathname}${parsed.search}` });
      return demo.app.fetch(req);
    };

    const manifest = buildExploreManifest();
    let latestCheckpoint: ExploreCheckpoint | undefined;
    const ctx = createTestContext(manifest, {
      onSaveCheckpoint: (cp) => {
        latestCheckpoint = cp as ExploreCheckpoint;
      },
    });

    // Roda intake primeiro para popular robots.txt e sementes
    const intakeRes = await runIntakePhase(ctx, { fetch: fetchViaDemoApp });
    expect(intakeRes.phaseResult.status).toBe("ok");

    // Roda explore (sem wait real nos 500ms para manter o teste rápido)
    const exploreRes = await runExplorePhase(ctx, {
      fetch: fetchViaDemoApp,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });

    expect(exploreRes.phaseResult.status).toBe("ok");
    expect(latestCheckpoint).toBeDefined();
    expect(exploreRes.stateGraph).toBeDefined();
    expect(exploreRes.stateGraphPath).toBe(resolveStateGraphPath(evidenceStore, ctx.job.id));
    expect(existsSync(exploreRes.stateGraphPath ?? "")).toBe(true);

    // Lê e valida o arquivo jobs/<jobId>/graph/state-graph.json gravado em disco
    const rawGraphJson = readFileSync(exploreRes.stateGraphPath ?? "", "utf8");
    const parsedGraph = validateStateGraph(JSON.parse(rawGraphJson));

    const discoveredPaths = new Set(
      parsedGraph.nodes.map((n) => {
        const u = new URL(n.normalizedUrl);
        return `${u.pathname}${u.search}`;
      }),
    );

    // Critério 1: descobre home, lista de projetos, detalhe, novo projeto, pricing e help
    expect(discoveredPaths.has("/")).toBe(true);
    expect(discoveredPaths.has("/projects")).toBe(true);
    expect(discoveredPaths.has("/projects?page=2")).toBe(true);
    expect(discoveredPaths.has("/projects/proj-1")).toBe(true);
    expect(discoveredPaths.has("/projects/proj-2")).toBe(true);
    expect(discoveredPaths.has("/projects/proj-3")).toBe(true);
    expect(discoveredPaths.has("/projects/new")).toBe(true);
    expect(discoveredPaths.has("/pricing")).toBe(true);
    expect(discoveredPaths.has("/help")).toBe(true);
    expect(discoveredPaths.has("/login")).toBe(true);

    // Critério 2: NUNCA visita /admin nem clica em botão "Excluir" / "Sair"
    expect(discoveredPaths.has("/admin")).toBe(false);
    expect(discoveredPaths.has("/logout")).toBe(false);
    expect(demo.store.getStats().adminVisitsCount).toBe(0);
    expect(demo.store.getStats().deletedProjectsCount).toBe(0);
    expect(demo.store.getProject("proj-1")).toBeDefined();
    expect(demo.store.getStats().totalProjects).toBe(3);
    expect(requestedUrls.some((r) => r.path.startsWith("/admin"))).toBe(false);
    expect(requestedUrls.some((r) => r.path.startsWith("/logout"))).toBe(false);
    expect(requestedUrls.some((r) => r.path.includes("/delete"))).toBe(false);
    expect(parsedGraph.stats.skippedOutOfScope).toBeGreaterThan(0);
    expect(parsedGraph.stats.skippedDestructive).toBeGreaterThan(0);

    // Critério 3: state-graph.json válido com nós e arestas { from, to, action: { kind, selector, label } }
    expect(parsedGraph.nodes.length).toBeGreaterThanOrEqual(9);
    expect(parsedGraph.edges.length).toBeGreaterThan(0);
    const nodeIdSet = new Set(parsedGraph.nodes.map((n) => n.id));
    for (const edge of parsedGraph.edges) {
      expect(nodeIdSet.has(edge.from)).toBe(true);
      expect(nodeIdSet.has(edge.to)).toBe(true);
      expect(edge.action.kind).toBe("navigate");
      expect(edge.action.selector.length).toBeGreaterThan(0);
      expect(typeof edge.action.label).toBe("string");
    }

    // Verifica que evidências `state` e `transition` foram persistidas no EvidenceStore
    const storedStates = evidenceStore.list(ctx.job.id, { kind: "state", limit: 200 }).items;
    const storedTransitions = evidenceStore.list(ctx.job.id, {
      kind: "transition",
      limit: 200,
    }).items;
    expect(storedStates.length).toBe(parsedGraph.nodes.length);
    expect(storedTransitions.length).toBe(parsedGraph.edges.length);
  });

  it("respeita estritamente maxPages, maxDepth, maxDurationMin e limite de 2 páginas por lista paginada", async () => {
    const paginatedFetch: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      if (parsed.pathname === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><title>Home</title></head><body>
            <header><nav><a href="/items">Lista</a><a href="/d1">Profundidade 1</a></nav></header>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (parsed.pathname === "/items") {
        const page = parsed.searchParams.get("page") ?? "1";
        return new Response(
          `<!DOCTYPE html><html><head><title>Items p${page}</title></head><body>
            <main>
              <a href="/items/detail-${page}">Item da página ${page}</a>
              <nav aria-label="Paginação">
                <a href="/items?page=1">Página 1</a>
                <a href="/items?page=2">Página 2</a>
                <a href="/items?page=3">Página 3</a>
                <a href="/items?page=4">Página 4</a>
              </nav>
            </main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (parsed.pathname === "/d1") {
        return new Response(
          `<!DOCTYPE html><html><body><a href="/d2">Profundidade 2</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (parsed.pathname === "/d2") {
        return new Response(
          `<!DOCTYPE html><html><body><a href="/d3">Profundidade 3</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response(`<!DOCTYPE html><html><body><h1>${parsed.pathname}</h1></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    // 1. Teste de limite de paginação (máx. 2 páginas por lista) + maxDepth = 2
    const manifestDepth2 = buildExploreManifest({
      docsUrls: [],
      maxDepth: 2,
      maxPages: 30,
      respectRobotsTxt: false,
    });
    const ctxDepth2 = createTestContext(manifestDepth2, { jobId: "job_limits_depth" });
    const resDepth2 = await runExplorePhase(ctxDepth2, {
      fetch: paginatedFetch,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });

    const visitedUrlsDepth2 = resDepth2.stateGraph?.nodes.map((n) => n.normalizedUrl) ?? [];
    expect(visitedUrlsDepth2).toContain(`${DEMO_ORIGIN}/items`);
    expect(visitedUrlsDepth2).toContain(`${DEMO_ORIGIN}/items?page=2`);
    // Páginas 3 e 4 NÃO podem ser visitadas (máx. 2 páginas por lista)
    expect(visitedUrlsDepth2).not.toContain(`${DEMO_ORIGIN}/items?page=3`);
    expect(visitedUrlsDepth2).not.toContain(`${DEMO_ORIGIN}/items?page=4`);
    expect(resDepth2.stateGraph?.stats.skippedPaginationLimit).toBeGreaterThanOrEqual(2);
    // /d3 está em depth=3 (> maxDepth=2), logo não pode ser visitada
    expect(visitedUrlsDepth2).toContain(`${DEMO_ORIGIN}/d2`);
    expect(visitedUrlsDepth2).not.toContain(`${DEMO_ORIGIN}/d3`);

    // 2. Teste de maxPages = 2
    const manifestMaxPages = buildExploreManifest({
      docsUrls: [],
      maxPages: 2,
      maxDepth: 5,
      respectRobotsTxt: false,
    });
    const ctxMaxPages = createTestContext(manifestMaxPages, { jobId: "job_limits_pages" });
    const resMaxPages = await runExplorePhase(ctxMaxPages, {
      fetch: paginatedFetch,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });
    expect(resMaxPages.stateGraph?.stats.pagesVisited).toBe(2);
    expect(resMaxPages.stateGraph?.nodes).toHaveLength(2);

    // 3. Teste de maxDurationMin
    let fakeClockMs = 1_000_000;
    const manifestDuration = buildExploreManifest({
      docsUrls: [],
      maxPages: 50,
      maxDurationMin: 5,
      respectRobotsTxt: false,
    });
    const ctxDuration = createTestContext(manifestDuration, { jobId: "job_limits_duration" });
    const resDuration = await runExplorePhase(ctxDuration, {
      fetch: async (input, init) => {
        fakeClockMs += 310_000; // Avança mais que 5 minutos após a primeira página
        return paginatedFetch(input, init);
      },
      now: () => fakeClockMs,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });
    expect(resDuration.stateGraph?.stats.pagesVisited).toBe(1);
  });

  it("trata HTTP 429 (respeita Retry-After, reduz rateLimitRps pela metade após 3x, bloqueia após 6x) e desafios anti-bot / HTTP 403", async () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("invalid")).toBeNull();
    expect(
      detectExploreChallenge(
        403,
        { "cf-ray": "999" },
        "<html><body>Just a moment... cf-turnstile</body></html>",
      ),
    ).toContain("Cloudflare");

    let count429 = 0;
    const sleepsRecorded: number[] = [];
    const emittedEvents: JobEvent[] = [];

    const fetchAlways429: typeof globalThis.fetch = async () => {
      count429 += 1;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "2", "content-type": "text/plain" },
      });
    };

    const manifest429 = buildExploreManifest({
      docsUrls: [],
      rateLimitRps: 4,
      respectRobotsTxt: false,
    });
    const ctx429 = createTestContext(manifest429, {
      jobId: "job_test_429",
      onEmit: (ev) => emittedEvents.push(ev),
    });

    const res429 = await runExplorePhase(ctx429, {
      fetch: fetchAlways429,
      stabilizationMs: 0,
      sleep: async (ms) => {
        sleepsRecorded.push(ms);
      },
    });

    expect(count429).toBe(6);
    expect(res429.phaseResult.status).toBe("blocked");
    if (res429.phaseResult.status === "blocked") {
      expect(res429.phaseResult.reason).toContain("HTTP 429");
    }
    expect(res429.stateGraph?.stats.rateLimit429Count).toBe(6);
    // Verifica que o evento de redução pela metade na 3ª ocorrência foi emitido
    const halvedEvent = emittedEvents.find((e) => e.type === "rate_limit_halved");
    expect(halvedEvent).toBeDefined();
    expect(halvedEvent?.data?.newRateLimitRps).toBe(2);
    // Verifica que Retry-After de 2s (2000ms) foi respeitado nas 5 primeiras tentativas
    expect(sleepsRecorded.filter((ms) => ms === 2000).length).toBe(5);

    // Verifica desafio CAPTCHA -> awaiting_human quando captcha === "handoff"
    const fetchCaptcha: typeof globalThis.fetch = async () =>
      new Response('<html><body><div class="g-recaptcha"></div></body></html>', {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    const ctxCaptcha = createTestContext(
      buildExploreManifest({ captcha: "handoff", docsUrls: [] }),
      { jobId: "job_test_captcha" },
    );
    const resCaptcha = await runExplorePhase(ctxCaptcha, {
      fetch: fetchCaptcha,
      stabilizationMs: 0,
      sleep: async () => undefined,
    });
    expect(resCaptcha.phaseResult.status).toBe("awaiting_human");

    // Verifica que assertMethod("behavioralUi") bloqueia execução quando behavioralUi === false
    const ctxNoUi = createTestContext(buildExploreManifest({ behavioralUi: false }), {
      jobId: "job_no_ui",
    });
    await expect(
      runExplorePhase(ctxNoUi, { fetch: fetchCaptcha, stabilizationMs: 0 }),
    ).rejects.toThrowError(MethodNotAllowedError);
  });

  it("integra intake + explore no JobRunner e suporta retomada via checkpoint", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return demo.app.fetch(new Request(url, init));
    };

    const manifest = buildExploreManifest();
    const jobStore = new JobStore({ db, dataDir: tempDir });
    const created = jobStore.createJob({
      id: "job_runner_explore_01",
      name: manifest.job.name,
      manifest,
      manifestYaml: "version: 1\n",
    });
    jobStore.transition(created.id, "validating_manifest");
    jobStore.transition(created.id, "running");

    const runner = new JobRunner({
      store: jobStore,
      evidence: evidenceStore,
      phases: [
        createIntakePhase({ fetch: fetchViaDemoApp }),
        createExplorePhase({
          fetch: fetchViaDemoApp,
          stabilizationMs: 0,
          sleep: async () => undefined,
        }),
      ],
      logger: createLogger({ level: "silent" }),
      guardFactory: (m: Manifest) => createScopeGuard(m, { sleep: async () => undefined }),
    });

    const finishedJob = await runner.run(created.id, {
      enabledPhases: ["intake", "explore"],
    });
    expect(finishedJob.state).toBe("completed");

    const explorePhaseRecord = jobStore.getPhase(created.id, "explore");
    expect(explorePhaseRecord?.status).toBe("done");
    expect((explorePhaseRecord?.stats?.statesDiscovered ?? 0) >= 9).toBe(true);
    expect(demo.store.getStats().adminVisitsCount).toBe(0);

    // =========================================================================
    // Verificações F1-05: screenshots multi-viewport + snapshots DOM/a11y
    // =========================================================================
    const stateGraphPath = resolveStateGraphPath(evidenceStore, created.id);
    expect(existsSync(stateGraphPath)).toBe(true);
    const parsedGraph: StateGraph = JSON.parse(readFileSync(stateGraphPath, "utf8"));
    expect(parsedGraph.nodes.length).toBeGreaterThanOrEqual(9);

    const allScreenshots = evidenceStore.list(created.id, { kind: "screenshot", limit: 500 }).items;
    const allDomSnapshots = evidenceStore.list(created.id, {
      kind: "dom_snapshot",
      limit: 500,
    }).items;
    const allA11ySnapshots = evidenceStore.list(created.id, {
      kind: "a11y_snapshot",
      limit: 500,
    }).items;

    // Cada estado novo gera 3 screenshots nas viewports 375x812, 768x1024 e 1440x900
    for (const node of parsedGraph.nodes) {
      expect(node.screenshotEvidenceIds).toBeDefined();
      expect(node.screenshotEvidenceIds).toHaveLength(3);
      expect(node.domSnapshotEvidenceId).toBeDefined();
      expect(node.a11ySnapshotEvidenceId).toBeDefined();

      const nodeShots = allScreenshots.filter((s) => s.stateId === node.id);
      expect(nodeShots).toHaveLength(3);

      const viewportsFound = nodeShots
        .map((s) => `${String(s.data.width)}x${String(s.data.height)}`)
        .sort();
      expect(viewportsFound).toEqual(["1440x900", "375x812", "768x1024"]);

      for (const shot of nodeShots) {
        expect(shot.blobPath).toMatch(/^evidence\/screenshots\/[a-f0-9]{64}\.png$/);
        const shotBuffer = evidenceStore.readBlob(created.id, shot.id);
        expect(shotBuffer).not.toBeNull();
        expect(shotBuffer?.subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
      }

      // Snapshot DOM persistido: vinculado ao stateId, sem <script>, sem <style>, sem textos > 200 chars
      const domEv = allDomSnapshots.find((d) => d.stateId === node.id);
      expect(domEv).toBeDefined();
      expect(domEv?.blobPath).toMatch(/^evidence\/dom\/[a-f0-9]{64}\.html$/);
      if (!domEv) {
        throw new Error(`domEv não encontrado para o nó ${node.id}`);
      }
      const domBuffer = evidenceStore.readBlob(created.id, domEv.id);
      expect(domBuffer).not.toBeNull();
      if (!domBuffer) {
        throw new Error(`domBuffer nulo para a evidência ${domEv.id}`);
      }
      const domHtml = domBuffer.toString("utf8");

      expect(domHtml).not.toContain("<script");
      expect(domHtml).not.toContain("</script>");
      expect(domHtml).not.toContain("<style");
      expect(domHtml).not.toContain("</style>");

      const textNodes = (domHtml.match(/>([^<]+)</g) ?? []).map((t) => t.slice(1, -1).trim());
      for (const t of textNodes) {
        expect(t.length).toBeLessThanOrEqual(200);
      }

      // Snapshot A11y persistido: vinculado ao stateId
      const a11yEv = allA11ySnapshots.find((a) => a.stateId === node.id);
      expect(a11yEv).toBeDefined();
      expect(a11yEv?.blobPath).toMatch(/^evidence\/a11y\/[a-f0-9]{64}\.json$/);
      if (!a11yEv) {
        throw new Error(`a11yEv não encontrado para o nó ${node.id}`);
      }
      const a11yBuffer = evidenceStore.readBlob(created.id, a11yEv.id);
      expect(a11yBuffer).not.toBeNull();
      if (!a11yBuffer) {
        throw new Error(`a11yBuffer nulo para a evidência ${a11yEv.id}`);
      }
      const a11yParsed = JSON.parse(a11yBuffer.toString("utf8"));
      expect(a11yParsed.stateId).toBe(node.id);
      expect(a11yParsed.format).toBe("ariaSnapshot");
      expect(typeof a11yParsed.snapshot).toBe("string");
      expect(a11yParsed.snapshot.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!process.env.CLEANROOM_BROWSER_WS_ENDPOINT)(
  "@cleanroom/explorer — Fase 2 explore E2E (CDP Browserless + fixtures/demo-app)",
  () => {
    let tempDir: string;
    let db: SqliteDatabase;
    let evidenceStore: EvidenceStore;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "cleanroom-explorer-e2e-"));
      db = openDatabase({ dataDir: tempDir });
      evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
    });

    afterEach(() => {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("conecta ao Browserless via CDP e explora fixtures/demo-app completa sem tocar em /admin ou Excluir", async () => {
      const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url)
        .href;
      const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
      const demo = createDemoApp();

      const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return demo.app.fetch(new Request(url, init));
      };

      const manifest = buildExploreManifest();
      const nowIso = new Date().toISOString();
      const job: JobRecord = {
        id: "job_e2e_explore_f1_04",
        name: manifest.job.name,
        state: "running",
        manifest,
        createdAt: nowIso,
        updatedAt: nowIso,
        llmTokensIn: 0,
        llmTokensOut: 0,
      };
      const guard = createScopeGuard(manifest, { sleep: async () => undefined });
      const ctx: PhaseContext = {
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

      await runIntakePhase(ctx, { fetch: fetchViaDemoApp });

      const exploreRes = await runExplorePhase(ctx, {
        sessionOptions: {
          wsEndpoint: process.env.CLEANROOM_BROWSER_WS_ENDPOINT,
        },
        routeFetch: fetchViaDemoApp,
        stabilizationMs: 50,
      });

      expect(exploreRes.phaseResult.status).toBe("ok");
      const graph = exploreRes.stateGraph as StateGraph;
      expect(graph).toBeDefined();

      const urls = graph.nodes.map((n) => new URL(n.normalizedUrl).pathname);
      expect(urls).toContain("/");
      expect(urls).toContain("/projects");
      expect(urls).toContain("/projects/proj-1");
      expect(urls).toContain("/projects/new");
      expect(urls).toContain("/pricing");
      expect(urls).toContain("/help");
      expect(urls).not.toContain("/admin");
      expect(urls).not.toContain("/logout");
      expect(demo.store.getStats().adminVisitsCount).toBe(0);
      expect(demo.store.getProject("proj-1")).toBeDefined();
    }, 30_000);
  },
);
