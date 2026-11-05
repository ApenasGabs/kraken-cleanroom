import { ANALYZERS_PHASE_ID } from "@cleanroom/analyzers";
import { CORE_VERSION, type PhaseId } from "@cleanroom/core";
import { EXPLORER_PHASE_ID } from "@cleanroom/explorer";
import { SYNTHESIZER_PHASE_ID } from "@cleanroom/synthesizer";
import { VALIDATOR_PHASE_ID } from "@cleanroom/validator";

export const MCP_SERVER_NAME = "kraken-cleanroom";
export const MCP_SERVER_VERSION = CORE_VERSION;
export const REGISTERED_PHASE_MODULES: readonly PhaseId[] = [
  EXPLORER_PHASE_ID,
  ANALYZERS_PHASE_ID,
  SYNTHESIZER_PHASE_ID,
  VALIDATOR_PHASE_ID,
] as const;
