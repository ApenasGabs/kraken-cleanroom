import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type BusinessRule,
  DEFAULT_PHASE_ORDER,
  type Evidence,
  type JobStatus,
  type JobSummary,
  type Page,
  type Phase,
  createJobService,
  openDatabase,
  parseManifestYaml,
} from "@cleanroom/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_REPORT_MARKDOWN_BYTES,
  MAX_SCREENSHOT_IMAGE_BYTES,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  createCleanroomMcpServer,
  createMcpJobService,
  createStderrLogger,
  startMcpStdioServer,
  truncateReportMarkdown,
} from "./index.js";

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

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((entry) => entry.type === "text");
  if (!item || typeof item.text !== "string") {
    throw new Error("Tool result did not include a text content block.");
  }
  return item.text;
}

function createStreamClientTransport(
  serverStdin: PassThrough,
  serverStdout: PassThrough,
): Transport {
  let buffer = "";
  const transport: Transport = {
    async start() {
      serverStdout.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length > 0) {
            const parsed = JSON.parse(line) as JSONRPCMessage;
            transport.onmessage?.(parsed);
          }
          newlineIdx = buffer.indexOf("\n");
        }
      });
      serverStdout.on("close", () => {
        transport.onclose?.();
      });
      serverStdout.on("error", (err) => {
        transport.onerror?.(err);
      });
    },
    async send(message: JSONRPCMessage) {
      serverStdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      serverStdin.end();
      transport.onclose?.();
    },
  };
  return transport;
}

describe("@cleanroom/mcp-server (F1-15)", () => {
  let tempDir: string;
  let demoServer: DemoServerHandle | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cleanroom-mcp-f1-15-"));
  });

  afterEach(async () => {
    if (demoServer) {
      await demoServer.close();
      demoServer = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1. integração completa via Client + InMemoryTransport: lista ferramentas, valida manifesto, executa job na demo-app, consulta regras/evidências/screenshot e obtém relatório", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { startDemoServer } = (await import(demoModuleUrl)) as DemoAppModule;
    demoServer = await startDemoServer(0);

    const dataDir = join(tempDir, "data");
    const runtime = createMcpJobService({
      cwd: tempDir,
      env: {
        CLEANROOM_DATA_DIR: dataDir,
        CLEANROOM_LLM_PROVIDER: "fake",
        CLEANROOM_LOG_LEVEL: "silent",
      },
      fetch: globalThis.fetch,
    });

    const mcpHandle = createCleanroomMcpServer({
      service: runtime.service,
      logger: runtime.logger,
      dataDir: runtime.dataDir,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-mcp-client", version: "0.1.0" }, { capabilities: {} });

    await mcpHandle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // 1) Lista todas as ferramentas Fase 1 e valida descrições clean room
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([...MCP_TOOL_NAMES].sort());

      for (const tool of listed.tools) {
        expect(tool.description?.toLowerCase()).toContain("clean room");
      }
      const startTool = listed.tools.find((t) => t.name === "cleanroom_start_job");
      expect(startTool?.description?.toLowerCase()).toContain("inválido");

      // 2) cleanroom_init_manifest gera YAML sem iniciar job
      const initResult = await client.callTool({
        name: "cleanroom_init_manifest",
        arguments: {
          url: demoServer.baseUrl,
          ownership: "own",
          goals: ["Descobrir validações do formulário de projeto"],
        },
      });
      expect(initResult.isError).not.toBe(true);
      const initPayload = JSON.parse(
        getTextContent(initResult as { content: Array<{ type: string; text?: string }> }),
      ) as { yaml: string };
      expect(initPayload.yaml).toContain("ownership: own");

      const emptyJobsResult = await client.callTool({
        name: "cleanroom_list_jobs",
        arguments: {},
      });
      const emptyJobs = JSON.parse(
        getTextContent(emptyJobsResult as { content: Array<{ type: string; text?: string }> }),
      ) as JobSummary[];
      expect(emptyJobs).toEqual([]);

      // 3) cleanroom_validate_manifest (válido e inválido)
      const validCheck = await client.callTool({
        name: "cleanroom_validate_manifest",
        arguments: { yaml: initPayload.yaml },
      });
      const validPayload = JSON.parse(
        getTextContent(validCheck as { content: Array<{ type: string; text?: string }> }),
      ) as { ok: boolean; issues: unknown[] };
      expect(validPayload.ok).toBe(true);
      expect(validPayload.issues).toEqual([]);

      const invalidYaml = "version: 1\njob:\n  name: INVALID!\n";
      const invalidCheck = await client.callTool({
        name: "cleanroom_validate_manifest",
        arguments: { yaml: invalidYaml },
      });
      expect(invalidCheck.isError).not.toBe(true);
      const invalidPayload = JSON.parse(
        getTextContent(invalidCheck as { content: Array<{ type: string; text?: string }> }),
      ) as { ok: boolean; issues: Array<{ path: string; message: string }> };
      expect(invalidPayload.ok).toBe(false);
      expect(invalidPayload.issues.length).toBeGreaterThan(0);

      // 4) cleanroom_start_job recusa manifesto inválido
      const rejectedStart = await client.callTool({
        name: "cleanroom_start_job",
        arguments: { yaml: invalidYaml },
      });
      expect(rejectedStart.isError).toBe(true);
      const rejectedPayload = JSON.parse(
        getTextContent(rejectedStart as { content: Array<{ type: string; text?: string }> }),
      ) as { error: { code: string } };
      expect(rejectedPayload.error.code).toBe("MANIFEST_INVALID");

      // 5) Inicia job real na demo-app
      const templateYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
      const demoManifestYaml = templateYaml.replaceAll("http://localhost:4173", demoServer.baseUrl);

      const startResult = await client.callTool({
        name: "cleanroom_start_job",
        arguments: { yaml: demoManifestYaml },
      });
      expect(startResult.isError).not.toBe(true);
      const { jobId } = JSON.parse(
        getTextContent(startResult as { content: Array<{ type: string; text?: string }> }),
      ) as { jobId: string };
      expect(jobId).toMatch(/^cr-/);

      // Aguarda conclusão consultando cleanroom_status via MCP
      let status!: JobStatus;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const statusRes = await client.callTool({
          name: "cleanroom_status",
          arguments: { jobId },
        });
        status = JSON.parse(
          getTextContent(statusRes as { content: Array<{ type: string; text?: string }> }),
        ) as JobStatus;
        if (
          status.state === "completed" ||
          status.state === "failed" ||
          status.state === "blocked"
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 30));
      }

      expect(status.state).toBe("completed");
      expect(status.counters.evidence).toBeGreaterThan(0);
      expect(status.counters.rules).toBeGreaterThan(0);
      expect(demoServer.getCreatedProjectsCount()).toBe(0);

      // 6) cleanroom_list_jobs com filtro
      const jobsRes = await client.callTool({
        name: "cleanroom_list_jobs",
        arguments: { state: "completed", limit: 10 },
      });
      const completedJobs = JSON.parse(
        getTextContent(jobsRes as { content: Array<{ type: string; text?: string }> }),
      ) as JobSummary[];
      expect(completedJobs.some((j) => j.jobId === jobId && j.state === "completed")).toBe(true);

      // 7) cleanroom_list_rules
      const rulesRes = await client.callTool({
        name: "cleanroom_list_rules",
        arguments: { jobId },
      });
      const rules = JSON.parse(
        getTextContent(rulesRes as { content: Array<{ type: string; text?: string }> }),
      ) as BusinessRule[];
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0]?.id).toMatch(/^BR-/);

      const firstRule = rules[0];
      if (firstRule) {
        const filteredRulesRes = await client.callTool({
          name: "cleanroom_list_rules",
          arguments: {
            jobId,
            module: firstRule.module,
            confidence: firstRule.confidence,
          },
        });
        const filteredRules = JSON.parse(
          getTextContent(filteredRulesRes as { content: Array<{ type: string; text?: string }> }),
        ) as BusinessRule[];
        expect(filteredRules.length).toBeGreaterThan(0);
        expect(
          filteredRules.every(
            (r) => r.module === firstRule.module && r.confidence === firstRule.confidence,
          ),
        ).toBe(true);
      }

      // 8) cleanroom_list_evidence (paginação e filtro por kind, sem blobs)
      const evPage1Res = await client.callTool({
        name: "cleanroom_list_evidence",
        arguments: { jobId, kind: "screenshot", limit: 2 },
      });
      const evPage1 = JSON.parse(
        getTextContent(evPage1Res as { content: Array<{ type: string; text?: string }> }),
      ) as Page<Evidence>;
      expect(evPage1.items.length).toBeGreaterThan(0);
      expect(evPage1.items.every((e) => e.kind === "screenshot")).toBe(true);

      if (evPage1.nextCursor) {
        const evPage2Res = await client.callTool({
          name: "cleanroom_list_evidence",
          arguments: {
            jobId,
            kind: "screenshot",
            limit: 2,
            cursor: evPage1.nextCursor,
          },
        });
        const evPage2 = JSON.parse(
          getTextContent(evPage2Res as { content: Array<{ type: string; text?: string }> }),
        ) as Page<Evidence>;
        expect(evPage2.items.length).toBeGreaterThan(0);
        expect(evPage2.items[0]?.id).not.toBe(evPage1.items[0]?.id);
      }

      // 9) cleanroom_get_evidence para screenshot retorna image content base64 PNG <= 1 MB
      const screenshotId = evPage1.items[0]?.id ?? "";
      expect(screenshotId).not.toBe("");
      const getEvRes = await client.callTool({
        name: "cleanroom_get_evidence",
        arguments: { jobId, evidenceId: screenshotId },
      });
      const evContents = getEvRes.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      const evMeta = JSON.parse(getTextContent({ content: evContents })) as Evidence;
      expect(evMeta.id).toBe(screenshotId);

      const imagePart = evContents.find((item) => item.type === "image");
      expect(imagePart).toBeDefined();
      expect(imagePart?.mimeType).toBe("image/png");
      const pngBytes = Buffer.from(imagePart?.data ?? "", "base64");
      expect(pngBytes.byteLength).toBeGreaterThan(8);
      expect(pngBytes.byteLength).toBeLessThanOrEqual(MAX_SCREENSHOT_IMAGE_BYTES);
      // Assinatura PNG: 89 50 4E 47 0D 0A 1A 0A
      expect(pngBytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      // 10) cleanroom_get_report (markdown e json)
      const reportMdRes = await client.callTool({
        name: "cleanroom_get_report",
        arguments: { jobId, format: "markdown" },
      });
      const reportMd = JSON.parse(
        getTextContent(reportMdRes as { content: Array<{ type: string; text?: string }> }),
      ) as { content: string; truncated: boolean };
      expect(reportMd.truncated).toBe(false);
      expect(reportMd.content).toContain("BR-001");

      const reportJsonRes = await client.callTool({
        name: "cleanroom_get_report",
        arguments: { jobId, format: "json" },
      });
      const reportJson = JSON.parse(
        getTextContent(reportJsonRes as { content: Array<{ type: string; text?: string }> }),
      ) as { content: string };
      const parsedIndex = JSON.parse(reportJson.content) as { job: { id: string } };
      expect(parsedIndex.job.id).toBe(jobId);
    } finally {
      await client.close();
      await mcpHandle.close();
      await runtime.close();
    }
  }, 30_000);

  it("2. trunca relatório Markdown > 200 KB com aviso indicando REST e omite imagem inline se screenshot > 1 MB", async () => {
    const dataDir = join(tempDir, "limits-data");
    const db = openDatabase({ dataDir });
    const service = createJobService({
      db,
      dataDir,
      phases: DEFAULT_PHASE_ORDER.map(
        (id): Phase => ({
          id,
          async run() {
            return { status: "ok", stats: {} };
          },
        }),
      ),
    });

    const manifestYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
    const { jobId } = await service.start(manifestYaml);
    await service.waitForJob(jobId);

    // Grava relatório markdown > 200 KB com caracteres UTF-8 multibyte
    const reportPath = join(dataDir, "jobs", jobId, "report", "report.md");
    await mkdir(dirname(reportPath), { recursive: true });
    const repeatingLine = "Ação de validação com acentuação çãõ — regra clean room.\n";
    const bigMarkdown = repeatingLine.repeat(4_200); // ~247 KB
    expect(Buffer.byteLength(bigMarkdown, "utf8")).toBeGreaterThan(MAX_REPORT_MARKDOWN_BYTES);
    await writeFile(reportPath, bigMarkdown, "utf8");

    // Cria screenshot > 1 MB
    const oversizedBuf = Buffer.alloc(MAX_SCREENSHOT_IMAGE_BYTES + 128, 0xaa);
    const bigScreenshot = service.evidence.put({
      jobId,
      kind: "screenshot",
      phase: "explore",
      summary: "Oversized screenshot",
      blob: oversizedBuf,
    });

    const mcpHandle = createCleanroomMcpServer({
      service,
      logger: createStderrLogger({ level: "silent" }),
      dataDir,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "limits-test-client", version: "0.1.0" },
      { capabilities: {} },
    );

    await mcpHandle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const reportRes = await client.callTool({
        name: "cleanroom_get_report",
        arguments: { jobId, format: "markdown" },
      });
      const reportPayload = JSON.parse(
        getTextContent(reportRes as { content: Array<{ type: string; text?: string }> }),
      ) as { content: string; truncated: boolean; originalBytes: number; maxBytes: number };

      expect(reportPayload.truncated).toBe(true);
      expect(reportPayload.maxBytes).toBe(MAX_REPORT_MARKDOWN_BYTES);
      expect(reportPayload.originalBytes).toBeGreaterThan(MAX_REPORT_MARKDOWN_BYTES);
      expect(Buffer.byteLength(reportPayload.content, "utf8")).toBeLessThanOrEqual(
        MAX_REPORT_MARKDOWN_BYTES,
      );
      expect(reportPayload.content).not.toContain("\uFFFD");
      expect(reportPayload.content).toContain("truncado em 200 KB");
      expect(reportPayload.content).toContain(`/v1/jobs/${jobId}/report?format=md`);

      const directTruncate = truncateReportMarkdown(bigMarkdown, jobId);
      expect(directTruncate.truncated).toBe(true);
      expect(Buffer.byteLength(directTruncate.content, "utf8")).toBeLessThanOrEqual(
        MAX_REPORT_MARKDOWN_BYTES,
      );

      const evRes = await client.callTool({
        name: "cleanroom_get_evidence",
        arguments: { jobId, evidenceId: bigScreenshot.id },
      });
      const evContents = evRes.content as Array<{ type: string; text?: string }>;
      expect(evContents.some((c) => c.type === "image")).toBe(false);
      const textCombined = evContents.map((c) => c.text ?? "").join("\n");
      expect(textCombined).toContain("excede o limite de 1 MB");
    } finally {
      await client.close();
      await mcpHandle.close();
      db.close();
    }
  });

  it("3. suporta cleanroom_cancel_job e cleanroom_resume_job via MCP", async () => {
    const dataDir = join(tempDir, "lifecycle-data");
    const db = openDatabase({ dataDir });

    let releaseExplore!: () => void;
    const exploreGate = new Promise<void>((res) => {
      releaseExplore = res;
    });

    const service = createJobService({
      db,
      dataDir,
      phases: DEFAULT_PHASE_ORDER.map(
        (id): Phase => ({
          id,
          async run(ctx) {
            if (id === "explore") {
              ctx.saveCheckpoint({ step: 1 });
              await exploreGate;
            }
            return { status: "ok", stats: { step: 1 } };
          },
        }),
      ),
    });

    const mcpHandle = createCleanroomMcpServer({
      service,
      logger: createStderrLogger({ level: "silent" }),
      dataDir,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lifecycle-client", version: "0.1.0" }, { capabilities: {} });
    await mcpHandle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const manifestYaml = await readFile(DEMO_MANIFEST_PATH, "utf8");
      const startRes = await client.callTool({
        name: "cleanroom_start_job",
        arguments: { yaml: manifestYaml },
      });
      const { jobId } = JSON.parse(
        getTextContent(startRes as { content: Array<{ type: string; text?: string }> }),
      ) as { jobId: string };

      const cancelRes = await client.callTool({
        name: "cleanroom_cancel_job",
        arguments: { jobId, reason: "Cancelado via MCP" },
      });
      const cancelPayload = JSON.parse(
        getTextContent(cancelRes as { content: Array<{ type: string; text?: string }> }),
      ) as { ok: boolean; jobId: string };
      expect(cancelPayload).toEqual({ ok: true, jobId });

      const cancelledStatus = JSON.parse(
        getTextContent(
          (await client.callTool({
            name: "cleanroom_status",
            arguments: { jobId },
          })) as { content: Array<{ type: string; text?: string }> },
        ),
      ) as JobStatus;
      expect(cancelledStatus.state).toBe("cancelled");

      // Simula job interrompido no meio (`running` sem runner ativo) e retoma via cleanroom_resume_job
      const interrupted = service.store.createJob({
        id: "cr-20261122-mcp-resume-1",
        name: "demo-app-local",
        manifest: {},
        manifestYaml,
      });
      service.store.transition(interrupted.id, "validating_manifest");
      service.store.transition(interrupted.id, "running", {
        manifest: parseManifestYaml(manifestYaml),
      });

      releaseExplore();
      const resumeRes = await client.callTool({
        name: "cleanroom_resume_job",
        arguments: { jobId: interrupted.id },
      });
      expect(resumeRes.isError).not.toBe(true);
      await service.waitForJob(interrupted.id);

      const resumedStatus = JSON.parse(
        getTextContent(
          (await client.callTool({
            name: "cleanroom_status",
            arguments: { jobId: interrupted.id },
          })) as { content: Array<{ type: string; text?: string }> },
        ),
      ) as JobStatus;
      expect(resumedStatus.state).toBe("completed");
    } finally {
      releaseExplore();
      await client.close();
      await mcpHandle.close();
      db.close();
    }
  });

  it("4. transporte stdio garante stdout exclusivamente JSON-RPC e logs pino exclusivamente em stderr", async () => {
    const serverStdin = new PassThrough();
    const serverStdout = new PassThrough();
    const serverStderr = new PassThrough();

    const stdoutLines: string[] = [];
    let stdoutBuf = "";
    serverStdout.on("data", (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length > 0) {
          stdoutLines.push(line);
        }
        idx = stdoutBuf.indexOf("\n");
      }
    });

    let stderrText = "";
    serverStderr.on("data", (chunk: Buffer | string) => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    const started = await startMcpStdioServer({
      cwd: tempDir,
      env: {
        CLEANROOM_DATA_DIR: join(tempDir, "stdio-data"),
        CLEANROOM_LLM_PROVIDER: "fake",
        CLEANROOM_LOG_LEVEL: "info",
      },
      stdin: serverStdin,
      stdout: serverStdout,
      stderr: serverStderr,
    });

    const clientTransport = createStreamClientTransport(serverStdin, serverStdout);
    const client = new Client(
      { name: "stdio-test-client", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(MCP_TOOL_NAMES.length);

      // Dispara erro proposital para verificar que o log pino vai para stderr e nunca para stdout
      const badCall = await client.callTool({
        name: "cleanroom_status",
        arguments: { jobId: "cr-nao-existe" },
      });
      expect(badCall.isError).toBe(true);
    } finally {
      await client.close();
      await started.close();
      await started.closed;
    }

    // Cada linha enviada em stdout deve ser um JSON-RPC válido (zero logs pino em stdout)
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }

    // stderr recebeu os logs estruturados do pino (incluindo nome do servidor e aviso do erro)
    expect(stderrText).toContain(MCP_SERVER_NAME);
    expect(stderrText).toContain("MCP stdio pronto");
    expect(stderrText).toContain("cleanroom_status");
  });
});
