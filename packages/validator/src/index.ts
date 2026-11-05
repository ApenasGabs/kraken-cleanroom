import type { PhaseId } from "@cleanroom/core";
import { EXPLORER_PHASE_ID } from "@cleanroom/explorer";

export const VALIDATOR_PHASE_ID: PhaseId = "validate";
export const VALIDATOR_PREREQUISITE_PHASE: PhaseId = EXPLORER_PHASE_ID;
