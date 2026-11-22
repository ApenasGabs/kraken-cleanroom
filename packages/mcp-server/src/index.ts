import { pathToFileURL } from "node:url";
import { ANALYZERS_PHASE_ID } from "@cleanroom/analyzers";
import type { PhaseId } from "@cleanroom/core";
import { EXPLORER_PHASE_ID } from "@cleanroom/explorer";
import { SYNTHESIZER_PHASE_ID } from "@cleanroom/synthesizer";
import { VALIDATOR_PHASE_ID } from "@cleanroom/validator";
import { startMcpStdioServer } from "./server.js";

export {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  createStderrLogger,
  createPhase1Pipeline,
  createMcpJobService,
  type McpRuntimeOptions,
  type McpJobServiceHandle,
} from "./runtime.js";

export {
  MAX_REPORT_MARKDOWN_BYTES,
  MAX_SCREENSHOT_IMAGE_BYTES,
  MCP_TOOL_NAMES,
  truncateReportMarkdown,
  createCleanroomMcpServer,
  startMcpStdioServer,
  type McpToolName,
  type TruncatedReportResult,
  type EvidenceBlobReader,
  type CreateCleanroomMcpServerOptions,
  type CleanroomMcpServerHandle,
  type StartMcpStdioServerOptions,
  type StartedMcpStdioServer,
} from "./server.js";

export const REGISTERED_PHASE_MODULES: readonly PhaseId[] = [
  EXPLORER_PHASE_ID,
  ANALYZERS_PHASE_ID,
  SYNTHESIZER_PHASE_ID,
  VALIDATOR_PHASE_ID,
] as const;

async function runStdioEntrypoint(argv: readonly string[]): Promise<void> {
  if (argv.includes("--http")) {
    process.stderr.write("Erro: transporte HTTP ainda não disponível na Fase 1. Use --stdio.\n");
    process.exitCode = 1;
    return;
  }

  const started = await startMcpStdioServer();
  const onSignal = (): void => {
    void started.close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await started.closed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runStdioEntrypoint(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Erro fatal no servidor MCP: ${message}\n`);
    process.exitCode = 1;
  });
}
