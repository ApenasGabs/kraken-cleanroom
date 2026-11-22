import {
  type CleanroomConfig,
  type CleanroomJobService,
  DEFAULT_PHASE_ORDER,
  type LlmClient,
  type PhaseId,
  type SqliteDatabase,
} from "@cleanroom/core";
import type { CdpConnector } from "@cleanroom/explorer";
import { createMcpJobService, createPhase1Pipeline } from "@cleanroom/mcp-server";

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

export { createPhase1Pipeline };

/**
 * Cria o `CleanroomJobService` conectado ao SQLite em `CLEANROOM_DATA_DIR` e às fases reais da Fase 1.
 */
export function createCliJobService(options: CliPipelineOptions = {}): CliJobServiceHandle {
  const handle = createMcpJobService(options);
  return {
    service: handle.service,
    db: handle.db,
    config: handle.config,
    dataDir: handle.dataDir,
    close: () => {
      if (handle.db.open) {
        handle.db.close();
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
