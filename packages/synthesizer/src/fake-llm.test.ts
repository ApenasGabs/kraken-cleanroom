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
import { createSynthesizerFakeLlmClient, runReportPhase, runSynthesizePhase } from "./index.js";

describe("@cleanroom/synthesizer — createSynthesizerFakeLlmClient", () => {
  let tempDir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-fake-llm-"));
    db = openDatabase({ dataDir: tempDir });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("executa synthesize e report de ponta a ponta sem handlers manuais e passa na verificação de qualidade", async () => {
    const manifest = parseManifestObject({
      version: 1,
      job: {
        name: "fake-llm-e2e",
        description: "Validação do FakeLlmClient determinístico para CLI.",
        goals: ["Validar criação de projeto", "Listar planos"],
      },
      target: {
        url: "http://localhost:4173/",
        type: "web-ssr",
        allowedOrigins: ["http://localhost:4173"],
        docsUrls: ["http://localhost:4173/help", "http://localhost:4173/pricing"],
      },
      ownership: "own",
      authorization: {
        basis: "Aplicação de demonstração própria.",
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
        maxDepth: 3,
        maxDurationMin: 10,
        rateLimitRps: 5,
        maxAccounts: 0,
        forbiddenPaths: [],
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
        retainDays: 7,
      },
      report: {
        language: "pt-BR",
        viewports: [[1440, 900]],
      },
    });

    const evidence = createEvidenceStore({ db, dataDir: tempDir });
    const jobId = "cr-20261122-fakellm-0001";

    evidence.put({
      jobId,
      kind: "form_probe",
      phase: "explore",
      url: "http://localhost:4173/projects/new",
      summary: "Probe nome curto retorna 422",
      data: { field: "name", httpStatus: 422 },
    });
    evidence.put({
      jobId,
      kind: "pricing_plan",
      phase: "analyze",
      url: "http://localhost:4173/pricing",
      summary: "Plano Free: até 3 projetos",
      data: { displayName: "Free", price: "R$ 0/mês", projectLimit: 3 },
    });
    evidence.put({
      jobId,
      kind: "network_call",
      phase: "capture",
      url: "http://localhost:4173/api/projects?page=1",
      summary: "GET /api/projects -> 200",
      data: {
        method: "GET",
        pathTemplate: "/api/projects",
        status: 200,
        safeEnumSamples: { status: ["draft", "active", "archived"] },
      },
    });

    const llm = createSynthesizerFakeLlmClient();
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
      llm,
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: undefined,
      saveCheckpoint: () => undefined,
      emit: () => undefined,
    };

    const synthResult = await runSynthesizePhase(ctx);
    expect(synthResult.document.modules.length).toBeGreaterThanOrEqual(2);
    expect(synthResult.document.rules.length).toBeGreaterThanOrEqual(3);

    const reportResult = await runReportPhase(ctx);
    expect(reportResult.quality.ok).toBe(true);
    expect(existsSync(reportResult.reportPath)).toBe(true);
    expect(existsSync(reportResult.indexPath)).toBe(true);
    expect(readFileSync(reportResult.reportPath, "utf8")).toContain("BR-001");
  });
});
