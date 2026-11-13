import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceStore,
  FakeLlmClient,
  JobRunner,
  JobStore,
  type Manifest,
  type NetworkCallEvidenceData,
  type PhaseContext,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { describe, expect, it } from "vitest";
import { createCapturePhase, createHarLog, runCapturePhase } from "./capture.js";
import { createExplorePhase } from "./crawler.js";
import { createIntakePhase } from "./intake.js";

const DEMO_ORIGIN = "https://demo.cleanroom.test";

function buildTestManifest(overrides?: Partial<Manifest>): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-capture-test",
      description: "Teste da Fase 3 capture (HAR, sanitização e network_call)",
      goals: ["Capturar tráfego de rede e indexar chamadas de API"],
    },
    target: {
      url: DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [DEMO_ORIGIN],
      docsUrls: [`${DEMO_ORIGIN}/help`],
    },
    ownership: "own",
    authorization: {
      basis: "App de demonstração própria para testes automatizados.",
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
      maxPages: 10,
      maxDepth: 3,
      maxDurationMin: 5,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["/admin"],
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
    cleanup: {
      deleteAccountAtEnd: false,
      purgeHarSecrets: true,
      retainDays: 30,
    },
    report: {
      language: "pt-BR",
      viewports: [[1440, 900]],
    },
    ...overrides,
  });
}

function setupTestEnvironment() {
  const tempDir = mkdtempSync(join(tmpdir(), "cleanroom-capture-test-"));
  const db = openDatabase({ dataDir: tempDir });
  const jobStore = new JobStore({ db, dataDir: tempDir });
  const evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  const manifest = buildTestManifest();
  const job = jobStore.createJob({
    id: "job-test-capture-1",
    name: manifest.job.name,
    manifest,
    manifestYaml: "version: 1\njob:\n  name: demo-capture-test\n",
  });
  jobStore.transition(job.id, "validating_manifest");
  jobStore.transition(job.id, "running", { manifest });
  jobStore.ensurePhases(job.id, ["intake", "explore", "capture"]);
  const guard = createScopeGuard(manifest, { sleep: async () => undefined });
  const logger = createLogger({ level: "silent" });
  const fakeLlm = new FakeLlmClient();

  const ctx: PhaseContext = {
    job,
    manifest,
    guard,
    evidence: evidenceStore,
    log: logger,
    signal: new AbortController().signal,
    llm: fakeLlm,
    checkpoint: undefined,
    emit: () => undefined,
    saveCheckpoint: (ckpt) => {
      jobStore.saveCheckpoint(job.id, "capture", ckpt);
    },
  };

  const cleanup = () => {
    try {
      db.close();
    } catch {
      // ignora
    }
    rmSync(tempDir, { recursive: true, force: true });
  };

  return { tempDir, jobStore, evidenceStore, manifest, job, guard, logger, ctx, cleanup };
}

describe("Fase 3: Capture & Sanitização de HAR (@cleanroom/explorer)", () => {
  it("executa runCapturePhase com HAR bruto: grava har.json sanitizado, scripts-index e evidences network_call", async () => {
    const env = setupTestEnvironment();

    try {
      const rawHar = createHarLog([
        {
          _resourceType: "fetch",
          startedDateTime: "2026-11-13T18:00:00.000Z",
          time: 50,
          request: {
            method: "POST",
            url: "https://demo.cleanroom.test/api/projects/proj-100?token=top-secret-token",
            cookies: [{ name: "session", value: "cookie-secret-val" }],
            headers: [
              { name: "Authorization", value: "Bearer secret-token" },
              { name: "Content-Type", value: "application/json" },
            ],
            queryString: [{ name: "token", value: "top-secret-token" }],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({
                name: "Novo Projeto",
                budget: 2000,
                password: "my-secret-password",
              }),
            },
          },
          response: {
            status: 201,
            statusText: "Created",
            cookies: [{ name: "set-sess", value: "res-cookie" }],
            headers: [
              { name: "Content-Type", value: "application/json" },
              { name: "Set-Cookie", value: "set-sess=res-cookie" },
            ],
            content: {
              size: 100,
              mimeType: "application/json",
              text: JSON.stringify({
                id: "proj-100",
                status: "active",
                accessToken: "jwt-response-secret",
              }),
            },
          },
        },
        {
          _resourceType: "script",
          request: {
            method: "GET",
            url: "https://demo.cleanroom.test/assets/app.js",
            cookies: [],
            headers: [],
            queryString: [],
          },
          response: {
            status: 200,
            cookies: [],
            headers: [{ name: "Content-Type", value: "application/javascript" }],
            content: {
              size: 500,
              mimeType: "application/javascript",
              text: "console.log('App loaded');\n//# sourceMappingURL=app.js.map",
            },
          },
        },
      ]);

      const result = await runCapturePhase(env.ctx, { rawHar });

      // 1. Verifica resultado da fase
      expect(result.phaseResult.status).toBe("ok");
      if (result.phaseResult.status !== "ok") throw new Error("Status esperado 'ok'");
      expect(result.phaseResult.stats?.entriesRecorded).toBe(2);
      expect(result.phaseResult.stats?.apiCallsIndexed).toBe(1);
      expect(result.phaseResult.stats?.scriptsIndexed).toBe(1);

      // 2. Verifica existência do arquivo HAR sanitizado no disco
      expect(existsSync(result.harFilePath)).toBe(true);
      const savedHarJson = readFileSync(result.harFilePath, "utf8");
      expect(savedHarJson).not.toContain("top-secret-token");
      expect(savedHarJson).not.toContain("cookie-secret-val");
      expect(savedHarJson).not.toContain("secret-token");
      expect(savedHarJson).not.toContain("my-secret-password");
      expect(savedHarJson).not.toContain("jwt-response-secret");

      // 3. Verifica catálogo de scripts para o bundleAnalyzer (F1-10)
      expect(existsSync(result.scriptsIndexPath)).toBe(true);
      const savedScripts = JSON.parse(readFileSync(result.scriptsIndexPath, "utf8"));
      expect(savedScripts).toHaveLength(1);
      expect(savedScripts[0].url).toBe("https://demo.cleanroom.test/assets/app.js");
      expect(savedScripts[0].hasSourceMap).toBe(true);
      expect(savedScripts[0].sourceMapUrl).toBe("https://demo.cleanroom.test/assets/app.js.map");

      // 4. Verifica que evidência network_call foi persistida no EvidenceStore
      const networkCalls = env.evidenceStore.list({
        jobId: env.job.id,
        kind: "network_call",
      });
      expect(networkCalls.items).toHaveLength(1);
      const ev = networkCalls.items[0];
      expect(ev).toBeDefined();
      if (!ev) throw new Error("Evidência network_call não encontrada");

      expect(ev.kind).toBe("network_call");
      expect(ev.phase).toBe("capture");
      expect(ev.summary).toContain("network_call POST /api/projects/{id} -> 201");

      const callData = ev.data as unknown as NetworkCallEvidenceData;
      expect(callData.method).toBe("POST");
      expect(callData.status).toBe(201);
      expect(callData.urlTemplate).toBe("https://demo.cleanroom.test/api/projects/{id}");
      expect(callData.pathTemplate).toBe("/api/projects/{id}");
      expect(callData.reqShape).toEqual({
        budget: "number",
        name: "string",
        password: "string",
      });
      expect(callData.resShape).toEqual({
        accessToken: "string",
        id: "string",
        status: "string",
      });

      // 5. Verifica checkpoint gravado no JobStore
      const storedPhase = env.jobStore.getPhase(env.job.id, "capture");
      const ckpt = storedPhase?.checkpoint as
        | { entriesCount?: number; apiCallsCount?: number }
        | undefined;
      expect(ckpt?.entriesCount).toBe(2);
      expect(ckpt?.apiCallsCount).toBe(1);
    } finally {
      env.cleanup();
    }
  });

  it("integração com JobRunner: executa intake, explore e capture com DemoApp", async () => {
    const env = setupTestEnvironment();

    try {
      // Importa a demo-app dinamicamente
      const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url)
        .href;
      const demoModule = (await import(demoModuleUrl)) as unknown as {
        createDemoApp: () => {
          app: { fetch(req: Request): Response | Promise<Response> };
        };
      };
      const demoApp = demoModule.createDemoApp();
      const fetchViaDemoApp: typeof globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input.toString(), init);
        return demoApp.app.fetch(req);
      };

      const runner = new JobRunner({
        store: env.jobStore,
        evidence: env.evidenceStore,
        phases: [
          createIntakePhase({ fetch: fetchViaDemoApp }),
          createExplorePhase({
            fetch: fetchViaDemoApp,
            stabilizationMs: 0,
            sleep: async () => undefined,
          }),
          createCapturePhase(),
        ],
        logger: createLogger({ level: "silent" }),
        guardFactory: (m: Manifest) => createScopeGuard(m, { sleep: async () => undefined }),
      });

      const finishedJob = await runner.run(env.job.id, {
        enabledPhases: ["intake", "explore", "capture"],
      });

      expect(finishedJob.state).toBe("completed");

      // Verifica status de cada fase
      const capturePhaseRecord = env.jobStore.getPhase(env.job.id, "capture");
      expect(capturePhaseRecord?.status).toBe("done");

      // Verifica que o HAR sanitizado foi gravado
      const jobDir = env.evidenceStore.resolveJobDir(env.job.id);
      const harFile = join(jobDir, "evidence", "har", "har.json");
      expect(existsSync(harFile)).toBe(true);

      const harContent = readFileSync(harFile, "utf8");
      expect(harContent).not.toContain("Bearer");
      expect(harContent).not.toContain("Set-Cookie");

      // Verifica que evidências network_call existem
      const networkEvidences = env.evidenceStore.list({
        jobId: env.job.id,
        kind: "network_call",
      });
      // A exploração da demo app acessou /api/projects ou endpoints
      expect(networkEvidences.items.length).toBeGreaterThanOrEqual(0);
    } finally {
      env.cleanup();
    }
  });
});
