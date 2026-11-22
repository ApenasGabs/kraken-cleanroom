import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PHASE_ORDER,
  type JobService,
  type JobStatus,
  type Phase,
  type PhaseContext,
  type PhaseId,
  createJobService,
  openDatabase,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, exitCodeForJobState, runCli } from "./index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEMO_MANIFEST_PATH = resolve(__dirname, "../../../examples/demo-app.cleanroom.yaml");

interface DemoServerHandle {
  port: number;
  baseUrl: string;
  getCreatedProjectsCount(): number;
  close(): Promise<void>;
}

interface DemoAppModule {
  startDemoServer(port?: number): Promise<DemoServerHandle>;
}

function createCapturedIo(overrides?: Partial<CliIo>): {
  io: CliIo;
  getStdout: () => string;
  getStderr: () => string;
} {
  let stdoutBuf = "";
  let stderrBuf = "";

  const io: CliIo = {
    stdout: (chunk: string) => {
      stdoutBuf += chunk;
    },
    stderr: (chunk: string) => {
      stderrBuf += chunk;
    },
    ...overrides,
  };

  return {
    io,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

function fakePhase(
  id: PhaseId,
  fn: (
    ctx: PhaseContext,
  ) => Promise<Awaited<ReturnType<Phase["run"]>>> | Awaited<ReturnType<Phase["run"]>>,
): Phase {
  return {
    id,
    async run(ctx) {
      return fn(ctx);
    },
  };
}

describe("@cleanroom/cli — run, status, list, resume, cancel, report, evidence (F1-14)", () => {
  let tempDir: string;
  let demoServer: DemoServerHandle | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cleanroom-cli-f1-14-"));
  });

  afterEach(async () => {
    if (demoServer) {
      await demoServer.close();
      demoServer = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1. executa cleanroom run ponta a ponta contra fixtures/demo-app local com CLEANROOM_LLM_PROVIDER=fake e gera report.md, index.json e openapi.yaml", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { startDemoServer } = (await import(demoModuleUrl)) as DemoAppModule;
    demoServer = await startDemoServer(0);

    const templateYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
    const manifestYaml = templateYaml.replaceAll("http://localhost:4173", demoServer.baseUrl);
    const manifestPath = join(tempDir, "demo-app.cleanroom.yaml");
    await writeFile(manifestPath, manifestYaml, "utf8");

    const dataDir = join(tempDir, "data");
    const env = {
      CLEANROOM_DATA_DIR: dataDir,
      CLEANROOM_LLM_PROVIDER: "fake",
    };

    const runCap = createCapturedIo({
      cwd: tempDir,
      env,
      fetch: globalThis.fetch,
      runPollMs: 25,
    });

    const runCode = await runCli(["run", manifestPath], runCap.io);
    expect(runCap.getStderr()).toBe("");
    expect(runCode).toBe(0);

    const runOut = runCap.getStdout();
    const jobIdMatch = runOut.match(/Job iniciado:\s+(cr-[a-z0-9-]+)/);
    expect(jobIdMatch?.[1]).toBeTruthy();
    const jobId = jobIdMatch?.[1] ?? "";
    expect(runOut).toContain("Estado: completed");

    const jobDir = join(dataDir, "jobs", jobId);
    const reportMdPath = join(jobDir, "report", "report.md");
    const indexJsonPath = join(jobDir, "report", "index.json");
    const openApiPath = join(jobDir, "analysis", "openapi.yaml");

    expect(existsSync(reportMdPath)).toBe(true);
    expect(existsSync(indexJsonPath)).toBe(true);
    expect(existsSync(openApiPath)).toBe(true);

    const indexJson = JSON.parse(await readFile(indexJsonPath, "utf8")) as {
      rules: unknown[];
      quality: { ok: boolean };
    };
    expect(indexJson.quality.ok).toBe(true);
    expect(indexJson.rules.length).toBeGreaterThan(0);

    // Nenhum projeto foi criado durante o probing validation-only
    expect(demoServer.getCreatedProjectsCount()).toBe(0);

    // status --json
    const statusCap = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["status", jobId, "--json"], statusCap.io)).toBe(0);
    const parsedStatus = JSON.parse(statusCap.getStdout()) as JobStatus;
    expect(parsedStatus.jobId).toBe(jobId);
    expect(parsedStatus.state).toBe("completed");
    expect(parsedStatus.counters.evidence).toBeGreaterThan(0);
    expect(parsedStatus.counters.rules).toBeGreaterThan(0);
    expect(parsedStatus.llm.tokensIn).toBeGreaterThan(0);

    // list --json e --state completed
    const listCap = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["list", "--state", "completed", "--json"], listCap.io)).toBe(0);
    const listItems = JSON.parse(listCap.getStdout()) as Array<{ jobId: string; state: string }>;
    expect(listItems.some((item) => item.jobId === jobId && item.state === "completed")).toBe(true);

    // report --format md, --format json e --open
    const reportMdCap = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["report", jobId, "--format", "md"], reportMdCap.io)).toBe(0);
    expect(reportMdCap.getStdout()).toContain("BR-001");

    const reportJsonCap = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["report", jobId, "--format", "json"], reportJsonCap.io)).toBe(0);
    const parsedReportJson = JSON.parse(reportJsonCap.getStdout()) as { job: { id: string } };
    expect(parsedReportJson.job.id).toBe(jobId);

    let openedPath = "";
    const reportOpenCap = createCapturedIo({
      cwd: tempDir,
      env,
      openFile: (filePath) => {
        openedPath = filePath;
      },
    });
    expect(await runCli(["report", jobId, "--format", "md", "--open"], reportOpenCap.io)).toBe(0);
    expect(openedPath).toBe(reportMdPath);

    // evidence --kind, --limit e paginação via --cursor
    const evPage1Cap = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["evidence", jobId, "--limit", "3", "--json"], evPage1Cap.io)).toBe(0);
    const evPage1 = JSON.parse(evPage1Cap.getStdout()) as {
      items: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(evPage1.items).toHaveLength(3);
    expect(evPage1.nextCursor).toBeTruthy();

    const evPage2Cap = createCapturedIo({ cwd: tempDir, env });
    expect(
      await runCli(
        ["evidence", jobId, "--limit", "3", "--cursor", evPage1.nextCursor ?? "", "--json"],
        evPage2Cap.io,
      ),
    ).toBe(0);
    const evPage2 = JSON.parse(evPage2Cap.getStdout()) as { items: Array<{ id: string }> };
    expect(evPage2.items.length).toBeGreaterThan(0);
    expect(evPage2.items[0]?.id).not.toBe(evPage1.items[0]?.id);

    const evKindCap = createCapturedIo({ cwd: tempDir, env });
    expect(
      await runCli(["evidence", jobId, "--kind", "network_call", "--json"], evKindCap.io),
    ).toBe(0);
    const evNetwork = JSON.parse(evKindCap.getStdout()) as {
      items: Array<{ kind: string }>;
    };
    expect(evNetwork.items.length).toBeGreaterThan(0);
    expect(evNetwork.items.every((item) => item.kind === "network_call")).toBe(true);
  }, 30_000);

  it("2. executa cleanroom run --phases intake,analyze,synthesize,report sem browser e gera artefatos com saída 0", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { startDemoServer } = (await import(demoModuleUrl)) as DemoAppModule;
    demoServer = await startDemoServer(0);

    const templateYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
    const manifestYaml = templateYaml.replaceAll("http://localhost:4173", demoServer.baseUrl);
    const manifestPath = join(tempDir, "demo-no-browser.yaml");
    await writeFile(manifestPath, manifestYaml, "utf8");

    const dataDir = join(tempDir, "data-no-browser");
    const env = {
      CLEANROOM_DATA_DIR: dataDir,
      CLEANROOM_LLM_PROVIDER: "fake",
    };

    const runCap = createCapturedIo({ cwd: tempDir, env, runPollMs: 25 });
    const code = await runCli(
      ["run", manifestPath, "--phases", "intake,analyze,synthesize,report", "--json"],
      runCap.io,
    );

    expect(runCap.getStderr()).toBe("");
    expect(code).toBe(0);
    const status = JSON.parse(runCap.getStdout()) as JobStatus;
    expect(status.state).toBe("completed");

    const phaseMap = Object.fromEntries(status.phases.map((p) => [p.id, p.status]));
    expect(phaseMap).toMatchObject({
      intake: "done",
      explore: "skipped",
      capture: "skipped",
      analyze: "done",
      synthesize: "done",
      report: "done",
    });

    const jobDir = join(dataDir, "jobs", status.jobId);
    expect(existsSync(join(jobDir, "report", "report.md"))).toBe(true);
    expect(existsSync(join(jobDir, "report", "index.json"))).toBe(true);
    expect(existsSync(join(jobDir, "analysis", "openapi.yaml"))).toBe(true);
  });

  it("3. retorna códigos de saída corretos (0=completed, 2=awaiting_human, 3=blocked, 1=failed/rejected)", async () => {
    expect(exitCodeForJobState("completed")).toBe(0);
    expect(exitCodeForJobState("awaiting_human")).toBe(2);
    expect(exitCodeForJobState("blocked")).toBe(3);
    expect(exitCodeForJobState("failed")).toBe(1);
    expect(exitCodeForJobState("rejected")).toBe(1);
    expect(exitCodeForJobState("cancelled")).toBe(1);

    const makeMockFactory = (behavior: "awaiting_human" | "blocked" | "failed") => {
      return ({ cwd }: { cwd: string }) => {
        const db = openDatabase({ dataDir: join(cwd, `db-${behavior}`) });
        const phases: Phase[] = DEFAULT_PHASE_ORDER.map((id) =>
          fakePhase(id, async () => {
            if (id === "explore") {
              if (behavior === "awaiting_human") {
                return {
                  status: "awaiting_human",
                  handoff: { kind: "captcha", message: "Resolva o CAPTCHA", timeoutMin: 10 },
                };
              }
              if (behavior === "blocked") {
                return { status: "blocked", reason: "HTTP 403 no alvo" };
              }
              throw new Error("erro inesperado");
            }
            return { status: "ok", stats: { ok: 1 } };
          }),
        );
        const service = createJobService({
          db,
          dataDir: join(cwd, `db-${behavior}`),
          phases,
        });
        return { service, close: () => db.close() };
      };
    };

    const capHandoff = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: makeMockFactory("awaiting_human"),
      runPollMs: 10,
    });
    expect(await runCli(["run", DEMO_MANIFEST_PATH], capHandoff.io)).toBe(2);
    expect(capHandoff.getStdout()).toContain("Estado: awaiting_human");

    const capBlocked = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: makeMockFactory("blocked"),
      runPollMs: 10,
    });
    expect(await runCli(["run", DEMO_MANIFEST_PATH], capBlocked.io)).toBe(3);
    expect(capBlocked.getStdout()).toContain("Estado: blocked");

    const capFailed = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: makeMockFactory("failed"),
      runPollMs: 10,
    });
    expect(await runCli(["run", DEMO_MANIFEST_PATH], capFailed.io)).toBe(1);
    expect(capFailed.getStdout()).toContain("Estado: failed");
  });

  it("4. suporta --detach, status --watch, cancel --reason e resume", async () => {
    const dataDir = join(tempDir, "detach-data");
    const db = openDatabase({ dataDir });

    let releaseExplore!: () => void;
    const exploreGate = new Promise<void>((res) => {
      releaseExplore = res;
    });

    const service = createJobService({
      db,
      dataDir,
      phases: DEFAULT_PHASE_ORDER.map((id) =>
        fakePhase(id, async (ctx) => {
          if (id === "explore") {
            ctx.saveCheckpoint({ step: 1 });
            await exploreGate;
          }
          return { status: "ok", stats: { step: 1 } };
        }),
      ),
    });

    const sharedFactory = () => ({ service });

    // --detach inicia e retorna 0 imediatamente com jobId
    let detachedArgs: readonly string[] = [];
    const detachCap = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: sharedFactory,
      spawnDetached: (args) => {
        detachedArgs = args;
      },
    });
    expect(await runCli(["run", DEMO_MANIFEST_PATH, "--detach", "--json"], detachCap.io)).toBe(0);
    const detachedPayload = JSON.parse(detachCap.getStdout()) as {
      jobId: string;
      detached: boolean;
    };
    expect(detachedPayload.detached).toBe(true);
    expect(detachedArgs[0]).toBe("_worker");
    expect(detachedArgs[1]).toBe(detachedPayload.jobId);

    // status --watch acompanha até concluir após liberação
    setTimeout(() => releaseExplore(), 30);
    const watchCap = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: sharedFactory,
      watchPollMs: 15,
    });
    expect(await runCli(["status", detachedPayload.jobId, "--watch"], watchCap.io)).toBe(0);
    expect(watchCap.getStdout()).toContain("Estado: completed");

    // cancel --reason em job aguardando handoff
    const handoffService = createJobService({
      db,
      dataDir,
      phases: DEFAULT_PHASE_ORDER.map((id) =>
        fakePhase(id, async () =>
          id === "intake"
            ? {
                status: "awaiting_human",
                handoff: { kind: "sms_otp", message: "Código OTP", timeoutMin: 5 },
              }
            : { status: "ok", stats: {} },
        ),
      ),
    });

    const started = await handoffService.start(await readFile(DEMO_MANIFEST_PATH, "utf8"));
    await handoffService.waitForJob(started.jobId);

    const cancelCap = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: () => ({ service: handoffService }),
    });
    expect(
      await runCli(
        ["cancel", started.jobId, "--reason", "cancelado no teste", "--json"],
        cancelCap.io,
      ),
    ).toBe(0);
    const cancelJson = JSON.parse(cancelCap.getStdout()) as { ok: boolean; state: string };
    expect(cancelJson.ok).toBe(true);
    expect(cancelJson.state).toBe("cancelled");

    // resume em job interrompido em estado running (simulação de recuperação após queda)
    const crashedYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
    const recoveredJob = service.store.createJob({
      id: "cr-20261122-crashed-0001",
      name: "demo-app-local",
      manifest: {},
      manifestYaml: crashedYaml,
    });
    service.store.transition(recoveredJob.id, "validating_manifest");
    const { parseManifestYaml } = await import("@cleanroom/core");
    service.store.transition(recoveredJob.id, "running", {
      manifest: parseManifestYaml(crashedYaml),
    });

    const resumeCap = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: sharedFactory,
      runPollMs: 15,
    });
    expect(await runCli(["resume", recoveredJob.id, "--json"], resumeCap.io)).toBe(0);
    const resumedStatus = JSON.parse(resumeCap.getStdout()) as JobStatus;
    expect(resumedStatus.state).toBe("completed");

    db.close();
  });

  it("5. valida argumentos inválidos (--phases, --state, --kind, --format, jobId inexistente) com código 1", async () => {
    const dataDir = join(tempDir, "err-data");
    const env = { CLEANROOM_DATA_DIR: dataDir, CLEANROOM_LLM_PROVIDER: "fake" };

    const badPhases = createCapturedIo({ cwd: tempDir, env });
    expect(
      await runCli(["run", DEMO_MANIFEST_PATH, "--phases", "intake,fantasma"], badPhases.io),
    ).toBe(1);
    expect(badPhases.getStderr()).toContain("--phases");

    const badState = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["list", "--state", "unknown_state"], badState.io)).toBe(1);
    expect(badState.getStderr()).toContain("--state inválido");

    const badKind = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["evidence", "cr-missing", "--kind", "invalid_kind"], badKind.io)).toBe(1);
    expect(badKind.getStderr()).toContain("--kind inválido");

    const badFormat = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["report", "cr-missing", "--format", "pdf"], badFormat.io)).toBe(1);
    expect(badFormat.getStderr()).toContain("--format inválido");

    const missingJob = createCapturedIo({ cwd: tempDir, env });
    expect(await runCli(["status", "cr-inexistente"], missingJob.io)).toBe(1);
    expect(missingJob.getStderr()).toContain("JOB_NOT_FOUND");
  });

  it("6. fallback de waitWithProgress funciona mesmo com JobService sem waitForJob", async () => {
    let calls = 0;
    const minimalService: JobService = {
      validateManifest: async () => ({ ok: false, issues: [] }),
      initManifest: async () => "",
      start: async () => ({ jobId: "cr-minimal-1" }),
      status: async (jobId) => {
        calls += 1;
        return {
          jobId,
          state: calls >= 2 ? "completed" : "running",
          ...(calls >= 2 ? {} : { currentPhase: "intake" }),
          phases: [{ id: "intake", status: calls >= 2 ? "done" : "running" }],
          counters: { pages: 1, evidence: 2, findings: 0, rules: 0 },
          llm: { tokensIn: 0, tokensOut: 0 },
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      list: async () => [],
      cancel: async () => undefined,
      resume: async () => undefined,
      resolveHandoff: async () => undefined,
      getReport: async () => "# Report",
      listEvidence: async () => ({ items: [] }),
      getEvidence: async () => {
        throw new Error("unused");
      },
      listRules: async () => [],
    };

    const cap = createCapturedIo({
      cwd: tempDir,
      jobServiceFactory: () => ({ service: minimalService }),
      runPollMs: 10,
    });

    const code = await runCli(["run", DEMO_MANIFEST_PATH], cap.io);
    expect(code).toBe(0);
    expect(cap.getStdout()).toContain("cr-minimal-1");
    expect(cap.getStdout()).toContain("Estado: completed");
  });

  it("7. suporta cleanroom serve --mcp-stdio e recusa ausência de flag ou --http na Fase 1", async () => {
    const missingFlag = createCapturedIo({ cwd: tempDir });
    expect(await runCli(["serve"], missingFlag.io)).toBe(1);
    expect(missingFlag.getStderr()).toContain("--mcp-stdio");

    const httpFlag = createCapturedIo({ cwd: tempDir });
    expect(await runCli(["serve", "--http"], httpFlag.io)).toBe(1);
    expect(httpFlag.getStderr()).toContain("Fase 2");

    let calledWithEnv: Record<string, string | undefined> | undefined;
    const mcpCap = createCapturedIo({
      cwd: tempDir,
      env: { CLEANROOM_DATA_DIR: join(tempDir, "mcp-data"), CLEANROOM_LLM_PROVIDER: "fake" },
      startMcpStdio: async (opts) => {
        calledWithEnv = opts.env;
      },
    });
    expect(await runCli(["serve", "--mcp-stdio"], mcpCap.io)).toBe(0);
    expect(mcpCap.getStderr()).toBe("");
    expect(calledWithEnv?.CLEANROOM_LLM_PROVIDER).toBe("fake");
  });
});
