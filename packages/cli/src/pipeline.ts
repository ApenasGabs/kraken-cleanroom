import { resolve } from "node:path";
import { createAnalyzePhase } from "@cleanroom/analyzers";
import {
  type CleanroomConfig,
  type CleanroomJobService,
  DEFAULT_PHASE_ORDER,
  type LlmClient,
  type Phase,
  type PhaseId,
  type SqliteDatabase,
  createJobService,
  createLlmClientFromConfig,
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

export interface CliPipelineOptions {
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
  enabledPhases?: readonly PhaseId[] | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  cdpConnector?: CdpConnector | undefined;
  llmClient?: LlmClient | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface CliJobServiceHandle {
  service: CleanroomJobService;
  db: SqliteDatabase;
  config: CleanroomConfig;
  dataDir: string;
  close: () => void;
}

function needsRealLlm(enabledPhases?: readonly PhaseId[] | undefined): boolean {
  if (!enabledPhases) {
    return true;
  }
  return enabledPhases.includes("synthesize") || enabledPhases.includes("report");
}

function resolveLlmClient(config: CleanroomConfig, options: CliPipelineOptions): LlmClient {
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
  options?: Pick<CliPipelineOptions, "fetch" | "cdpConnector">,
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
 * Cria o `CleanroomJobService` conectado ao SQLite em `CLEANROOM_DATA_DIR` e às fases reais da Fase 1.
 */
export function createCliJobService(options: CliPipelineOptions = {}): CliJobServiceHandle {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(env, {
    requireBrowser: false,
    requireLlm: false,
  });

  const dataDir = resolve(cwd, config.dataDir);
  const db = openDatabase({ dataDir });
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
    timeoutMs: options.timeoutMs,
    now: options.now,
  });

  return {
    service,
    db,
    config,
    dataDir,
    close: () => {
      if (db.open) {
        db.close();
      }
    },
  };
}

export function parsePhasesOption(rawPhases: string): PhaseId[] {
  const items = rawPhases
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (items.length === 0) {
    throw new Error("A opção --phases exige ao menos uma fase válida.");
  }

  const validSet = new Set<string>(DEFAULT_PHASE_ORDER);
  const invalid = items.filter((item) => !validSet.has(item));
  if (invalid.length > 0) {
    throw new Error(
      `Fase(s) inválida(s) em --phases: ${invalid.join(", ")}. Valores aceitos: ${DEFAULT_PHASE_ORDER.join(", ")}.`,
    );
  }

  return [...new Set(items)] as PhaseId[];
}
