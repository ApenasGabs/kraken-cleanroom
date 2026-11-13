import { mkdtempSync, rmSync } from "node:fs";
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
  createDocsHarvesterPhase,
  decodeHtmlEntities,
  docsHarvester,
  extractDocSections,
  extractPricingPlans,
  htmlToMarkdown,
} from "./docs-harvester.js";

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
  publicDocs?: boolean;
  docsUrls?: string[];
}): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-docs-harvester-test",
      description: "Estudo clean-room da fixture demo-app para validação do docsHarvester",
      goals: ["Extrair seções de documentação e planos de preço"],
    },
    target: {
      url: DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [DEMO_ORIGIN],
      docsUrls: overrides?.docsUrls ?? [`${DEMO_ORIGIN}/help`, `${DEMO_ORIGIN}/pricing`],
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
      publicDocs: overrides?.publicDocs ?? true,
      staticBundles: true,
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
    accounts: {
      strategy: "none",
    },
    humanInTheLoop: {
      captcha: "abort",
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

describe("docsHarvester & pricing (@cleanroom/analyzers)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-docs-harvester-"));
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
      id: "job_test_f1_09",
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

  it("contra fixtures/demo-app, /help gera 3 evidências doc_section e /pricing gera 2 evidências pricing_plan (Free: 3 projetos; Pro: ilimitado)", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return demo.app.fetch(new Request(url, init));
    };

    const manifest = buildManifest({ docsUrls: [] });
    const ctx = createTestContext(manifest);

    const result = await docsHarvester(ctx, { fetch: fetchViaDemoApp });

    expect(result.skipped).toBe(false);
    expect(result.docSections).toHaveLength(3);
    expect(result.pricingPlans).toHaveLength(2);

    // Verifica persistência no EvidenceStore
    const storedDocs = evidenceStore.list(ctx.job.id, { kind: "doc_section" }).items;
    const storedPlans = evidenceStore.list(ctx.job.id, { kind: "pricing_plan" }).items;

    expect(storedDocs).toHaveLength(3);
    expect(storedPlans).toHaveLength(2);

    // Verifica os 3 artigos de /help
    expect(storedDocs.map((d) => (d.data as { heading?: string }).heading)).toEqual([
      "1. Como criar projetos e regras de validação",
      "2. Ciclo de vida e máquina de estados do projeto",
      "3. Limites de planos Free vs Pro e rotas restritas",
    ]);
    expect(storedDocs.map((d) => (d.data as { sectionId?: string }).sectionId)).toEqual([
      "artigo-criacao-validacoes",
      "artigo-ciclo-vida-status",
      "artigo-planos-limites-seguranca",
    ]);

    for (const docEv of storedDocs) {
      expect(docEv.url).toBe(`${DEMO_ORIGIN}/help`);
      expect(docEv.blobPath).toMatch(/^evidence\/docs\/[a-f0-9]{64}\.md$/);
      const blobBuf = evidenceStore.readBlob(ctx.job.id, docEv.id);
      expect(blobBuf).not.toBeNull();
      const markdownText = blobBuf?.toString("utf8") ?? "";
      expect(markdownText).toContain(`## ${String(docEv.data.heading)}`);
      // Garante que summary não copia texto longo literal (> 120 chars idênticos ao blob)
      expect(docEv.summary.length).toBeLessThan(120);
    }

    // Verifica os 2 planos de /pricing (Free: 3 projetos; Pro: ilimitado)
    const freePlan = storedPlans.find((p) => (p.data as { planId?: string }).planId === "free");
    const proPlan = storedPlans.find((p) => (p.data as { planId?: string }).planId === "pro");

    expect(freePlan).toBeDefined();
    expect(freePlan?.url).toBe(`${DEMO_ORIGIN}/pricing`);
    expect(freePlan?.data.name).toBe("Free");
    expect(freePlan?.data.priceAmount).toBe(0);
    expect(freePlan?.data.currency).toBe("BRL");
    expect(freePlan?.data.projectLimit).toBe(3);
    expect(freePlan?.data.unlimitedProjects).toBe(false);

    expect(proPlan).toBeDefined();
    expect(proPlan?.url).toBe(`${DEMO_ORIGIN}/pricing`);
    expect(proPlan?.data.name).toBe("Pro");
    expect(proPlan?.data.priceAmount).toBe(49);
    expect(proPlan?.data.currency).toBe("BRL");
    expect(proPlan?.data.projectLimit).toBe("unlimited");
    expect(proPlan?.data.unlimitedProjects).toBe(true);

    // Garante que rotas administrativas nunca foram visitadas
    expect(demo.store.getStats().adminVisitsCount).toBe(0);
  });

  it("respeita guard.assertMethod('publicDocs') e pula quando methods.publicDocs === false", async () => {
    const manifest = buildManifest({ publicDocs: false });
    const ctx = createTestContext(manifest);
    const assertMethodSpy = vi.spyOn(ctx.guard, "assertMethod");
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    const result = await docsHarvester(ctx, { fetch: fetchSpy });

    expect(assertMethodSpy).toHaveBeenCalledWith("publicDocs");
    expect(result.skipped).toBe(true);
    expect(result.stats.skipped).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(evidenceStore.count(ctx.job.id)).toBe(0);

    // Verifica que throwOnMethodDisabled propaga MethodNotAllowedError se solicitado
    await expect(
      docsHarvester(ctx, { fetch: fetchSpy, throwOnMethodDisabled: true }),
    ).rejects.toBeInstanceOf(MethodNotAllowedError);

    // Verifica Phase wrapper isEnabled
    const phase = createDocsHarvesterPhase({ fetch: fetchSpy });
    expect(phase.isEnabled?.(manifest)).toBe(false);
    expect(phase.isEnabled?.(buildManifest({ publicDocs: true }))).toBe(true);
  });

  it("respeita guard.canNavigate, guard.throttle e checkpoints de retomada", async () => {
    const manifest = buildManifest({
      docsUrls: [
        `${DEMO_ORIGIN}/admin`,
        "https://external.example.com/docs",
        `${DEMO_ORIGIN}/help`,
      ],
    });
    const savedCheckpoints: unknown[] = [];
    const ctx = createTestContext(manifest, {
      onSaveCheckpoint: (cp) => savedCheckpoints.push(cp),
    });

    const throttleSpy = vi.spyOn(ctx.guard, "throttle");
    const canNavigateSpy = vi.spyOn(ctx.guard, "canNavigate");

    const fetchMock: typeof globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/help")) {
        return new Response(
          "<main><h1>Ajuda</h1><h2>Artigo Único</h2><p>Conteúdo com <code>/api/test</code>.</p></main>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const firstRun = await docsHarvester(ctx, {
      fetch: fetchMock,
      includeDefaultPaths: false,
    });

    expect(canNavigateSpy).toHaveBeenCalledWith(`${DEMO_ORIGIN}/admin`);
    expect(canNavigateSpy).toHaveBeenCalledWith("https://external.example.com/docs");
    expect(canNavigateSpy).toHaveBeenCalledWith(`${DEMO_ORIGIN}/help`);
    expect(throttleSpy).toHaveBeenCalledTimes(1);
    expect(firstRun.skippedUrls).toEqual([
      `${DEMO_ORIGIN}/admin`,
      "https://external.example.com/docs",
    ]);
    expect(firstRun.visitedUrls).toEqual([`${DEMO_ORIGIN}/help`]);
    expect(firstRun.docSections).toHaveLength(1);
    expect(savedCheckpoints.at(-1)).toEqual({
      completedUrls: [`${DEMO_ORIGIN}/help`],
    });

    // Segunda execução retomando do checkpoint não refaz chamadas HTTP
    const resumedCtx = createTestContext(manifest, {
      checkpoint: savedCheckpoints.at(-1),
    });
    const secondFetchMock = vi.fn<typeof globalThis.fetch>();
    const secondRun = await docsHarvester(resumedCtx, {
      fetch: secondFetchMock,
      includeDefaultPaths: false,
    });

    expect(secondFetchMock).not.toHaveBeenCalled();
    expect(secondRun.visitedUrls).toHaveLength(0);
  });

  it("converte HTML para Markdown e extrai tabelas/entidades corretamente", () => {
    expect(decodeHtmlEntities("A &amp; B &lt;3 &#39;ok&#39; &#x2014; fim")).toBe(
      "A & B <3 'ok' — fim",
    );

    const md = htmlToMarkdown(`
      <header><nav><a href="/">Menu</a></nav></header>
      <main>
        <h2>Guia Rápido</h2>
        <p>Use <code>cleanroom run</code> com <strong>manifesto</strong> e <a href="/docs">docs</a>.</p>
        <ul>
          <li>Primeiro item</li>
          <li>Segundo item</li>
        </ul>
      </main>
    `);

    expect(md).toContain("## Guia Rápido");
    expect(md).toContain("Use `cleanroom run` com **manifesto** e [docs](/docs).");
    expect(md).toContain("- Primeiro item");
    expect(md).not.toContain("Menu");

    const singleH1Sections = extractDocSections(
      "<main><h1>Termos de Uso</h1><p>Regras gerais do serviço.</p></main>",
      `${DEMO_ORIGIN}/terms`,
    );
    expect(singleH1Sections).toHaveLength(1);
    expect(singleH1Sections[0]?.heading).toBe("Termos de Uso");

    const tableOnlyPlans = extractPricingPlans(
      `<main>
        <h1>Preços</h1>
        <table>
          <thead><tr><th>Plano</th><th>Preço</th><th>Limite</th></tr></thead>
          <tbody>
            <tr><td>Starter</td><td>$10 / month</td><td>Up to 5 projects</td></tr>
          </tbody>
        </table>
      </main>`,
      `${DEMO_ORIGIN}/pricing`,
    );
    expect(tableOnlyPlans).toHaveLength(1);
    expect(tableOnlyPlans[0]?.name).toBe("Starter");
    expect(tableOnlyPlans[0]?.currency).toBe("USD");
    expect(tableOnlyPlans[0]?.priceAmount).toBe(10);
    expect(tableOnlyPlans[0]?.projectLimit).toBe(5);
  });
});
