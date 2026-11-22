import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { createAnalyzePhase } from "@cleanroom/analyzers";
import {
  CORE_VERSION,
  type CleanroomConfig,
  type CleanroomJobService,
  type LlmClient,
  type Logger,
  type Phase,
  type PhaseId,
  type SqliteDatabase,
  createJobService,
  createLlmClientFromConfig,
  createLogger,
  loadConfig,
  openDatabase,
} from "@cleanroom/core";
import {
  type CdpConnector,
  createCapturePhase,
  createExplorePhase,
  createIntakePhase,
} from "@cleanroom/explorer";
import {
  createReportPhase,
  createSynthesizePhase,
  createSynthesizerFakeLlmClient,
} from "@cleanroom/synthesizer";

export const MCP_SERVER_NAME = "kraken-cleanroom";
export const MCP_SERVER_VERSION = CORE_VERSION;

export interface McpRuntimeOptions {
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
  enabledPhases?: readonly PhaseId[] | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  cdpConnector?: CdpConnector | undefined;
  llmClient?: LlmClient | undefined;
  logger?: Logger | undefined;
  stderr?: Writable | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface McpJobServiceHandle {
  service: CleanroomJobService;
  db: SqliteDatabase;
  config: CleanroomConfig;
  dataDir: string;
  logger: Logger;
  close: () => Promise<void>;
}

/**
 * Cria um logger `pino` que escreve exclusivamente no stream de erro (`stderr`),
 * garantindo que o canal `stdout` permaneça limpo para JSON-RPC no transporte `stdio`.
 */
export function createStderrLogger(options?: {
  name?: string | undefined;
  stderr?: Writable | undefined;
  level?: CleanroomConfig["logLevel"] | undefined;
}): Logger {
  const targetStream = options?.stderr ?? process.stderr;
  const destination = {
    write(chunk: string): void {
      targetStream.write(chunk);
    },
  };
  return createLogger(
    {
      name: options?.name ?? MCP_SERVER_NAME,
      ...(options?.level !== undefined ? { level: options.level } : {}),
    },
    destination,
  );
}

function needsRealLlm(enabledPhases?: readonly PhaseId[] | undefined): boolean {
  if (!enabledPhases) {
    return true;
  }
  return enabledPhases.includes("synthesize") || enabledPhases.includes("report");
}

function resolveLlmClient(config: CleanroomConfig, options: McpRuntimeOptions): LlmClient {
  if (options.llmClient !== undefined) {
    return options.llmClient;
  }
  if (config.llmProvider === "fake" || !needsRealLlm(options.enabledPhases)) {
    return createSynthesizerFakeLlmClient();
  }
  return createLlmClientFromConfig(config);
}

/**
 * Monta as fases reais da Fase 1 (`intake`, `explore`, `capture`, `analyze`, `synthesize`, `report`).
 */
export function createPhase1Pipeline(
  config: CleanroomConfig,
  options?: Pick<McpRuntimeOptions, "fetch" | "cdpConnector">,
): Phase[] {
  const fetchFn = options?.fetch;
  const intake = createIntakePhase(fetchFn ? { fetch: fetchFn } : undefined);

  const exploreSessionOpts =
    config.browserWsEndpoint !== undefined || options?.cdpConnector !== undefined
      ? {
          wsEndpoint: config.browserWsEndpoint ?? "ws://local-fetch-adapter:9222",
          ...(options?.cdpConnector !== undefined ? { cdpConnector: options.cdpConnector } : {}),
        }
      : undefined;

  const explore = createExplorePhase({
    ...(fetchFn ? { fetch: fetchFn } : {}),
    ...(exploreSessionOpts ? { sessionOptions: exploreSessionOpts } : {}),
  });

  const capture = createCapturePhase();
  const analyze = createAnalyzePhase(fetchFn ? { fetch: fetchFn } : undefined);
  const synthesize = createSynthesizePhase();
  const report = createReportPhase();

  return [intake, explore, capture, analyze, synthesize, report];
}

/**
 * Cria o `CleanroomJobService` conectado ao SQLite em `CLEANROOM_DATA_DIR`,
 * com logger direcionado a `stderr` / arquivo do job (nunca `stdout`).
 */
export function createMcpJobService(options: McpRuntimeOptions = {}): McpJobServiceHandle {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(env, {
    requireBrowser: false,
    requireLlm: false,
  });

  const dataDir = resolve(cwd, config.dataDir);
  const db = openDatabase({ dataDir });
  const logger =
    options.logger ??
    createStderrLogger({
      name: MCP_SERVER_NAME,
      stderr: options.stderr,
      level: config.logLevel,
    });
  const llm = resolveLlmClient(config, options);
  const phases = createPhase1Pipeline(config, {
    fetch: options.fetch,
    cdpConnector: options.cdpConnector,
  });

  const service = createJobService({
    db,
    dataDir,
    phases,
    llm,
    // JobRunner cria pino.destination em `jobs/<jobId>/logs/job.ndjson` quando `logger` não é sobrescrito,
    // mantendo logs de execução isolados por job e nunca escrevendo em `stdout`.
    timeoutMs: options.timeoutMs,
    now: options.now,
  });

  let closed = false;

  return {
    service,
    db,
    config,
    dataDir,
    logger,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (db.open) {
        const running = await service.list({ state: "running", limit: 100 });
        for (const item of running) {
          if (service.isActive(item.jobId)) {
            await service.cancel(item.jobId, "Servidor MCP encerrado.").catch(() => undefined);
          }
        }
        db.close();
      }
    },
  };
}
