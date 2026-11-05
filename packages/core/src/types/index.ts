export type PhaseId =
  | "intake"
  | "explore"
  | "capture"
  | "analyze"
  | "synthesize"
  | "validate"
  | "report";

export type JobState =
  | "created"
  | "validating_manifest"
  | "rejected"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type Confidence = "observed" | "inferred" | "hypothesis";

export const DEFAULT_PHASE_ORDER: readonly PhaseId[] = [
  "intake",
  "explore",
  "capture",
  "analyze",
  "synthesize",
  "validate",
  "report",
] as const;
