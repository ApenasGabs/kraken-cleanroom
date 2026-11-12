import { JobConflictError } from "./errors.js";
import { TERMINAL_JOB_STATES } from "./types/index.js";
import type { JobState } from "./types/index.js";

/**
 * Transições permitidas da máquina de estados do job (docs/02 §4).
 *
 * Além do diagrama:
 * - `running -> cancelled`: cancelamento explícito durante a execução.
 * - `created|validating_manifest -> cancelled`: cancelamento antes de começar.
 */
export const JOB_STATE_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  created: ["validating_manifest", "cancelled"],
  validating_manifest: ["rejected", "running", "cancelled"],
  rejected: [],
  running: ["awaiting_human", "blocked", "failed", "completed", "cancelled"],
  awaiting_human: ["running", "cancelled"],
  blocked: [],
  failed: [],
  completed: [],
  cancelled: [],
};

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_STATE_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobState, to: JobState, jobId?: string): void {
  if (!canTransitionJob(from, to)) {
    throw new JobConflictError(
      `Transição de estado inválida${jobId !== undefined ? ` no job ${jobId}` : ""}: ${from} -> ${to}.`,
      { details: { from, to, ...(jobId !== undefined ? { jobId } : {}) } },
    );
  }
}
