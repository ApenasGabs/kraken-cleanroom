import type { EvidenceStore } from "../evidence-store.js";
import type {
  AnyZodSchema,
  LlmClient,
  LlmGenerateResult,
  LlmMessage,
  LlmOptions,
  LlmRole,
  LlmTokenSink,
  LlmUsage,
  LlmUsageCallback,
  LlmUsageEvent,
} from "../llm-client.js";
import type { Logger } from "../logger.js";
import type { Manifest } from "../manifest.js";
import type { ScopeGuard } from "../scope-guard.js";

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

export const CONFIDENCE_LEVELS = ["observed", "inferred", "hypothesis"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const DEFAULT_PHASE_ORDER: readonly PhaseId[] = [
  "intake",
  "explore",
  "capture",
  "analyze",
  "synthesize",
  "validate",
  "report",
] as const;

export const EVIDENCE_KINDS = [
  "http_response",
  "robots",
  "tech_signature",
  "screenshot",
  "dom_snapshot",
  "a11y_snapshot",
  "state",
  "transition",
  "form_schema",
  "form_probe",
  "network_call",
  "doc_section",
  "pricing_plan",
  "bundle_route",
  "bundle_string",
  "feature_flag",
  "email_received",
  "validation_run",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  id: string;
  jobId: string;
  kind: EvidenceKind;
  phase: PhaseId;
  sha256: string;
  blobPath?: string;
  url?: string;
  stateId?: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export const FINDING_CATEGORIES = [
  "feature",
  "validation",
  "permission",
  "limit",
  "state",
  "integration",
  "pricing",
  "ux",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Finding {
  id: string;
  jobId: string;
  module: string;
  category: FindingCategory;
  statement: string;
  confidence: Confidence;
  evidenceIds: string[];
  fingerprint: string;
}

export const RULE_VALIDATION_STATUSES = ["confirmed", "contradicted", "inconclusive"] as const;

export type RuleValidationStatus = (typeof RULE_VALIDATION_STATUSES)[number];

export interface RuleValidation {
  status: RuleValidationStatus;
  runEvidenceId: string;
}

export interface BusinessRule {
  id: string;
  module: string;
  title: string;
  trigger: string;
  condition: string;
  effect: string;
  confidence: Confidence;
  findingIds: string[];
  evidenceIds: string[];
  validation?: RuleValidation;
}

export const DOMAIN_RELATION_KINDS = ["1-1", "1-n", "n-n"] as const;

export type DomainRelationKind = (typeof DOMAIN_RELATION_KINDS)[number];

export interface DomainAttribute {
  name: string;
  type: string;
  required: boolean;
  notes?: string;
  evidenceIds: string[];
}

export interface DomainRelation {
  to: string;
  kind: DomainRelationKind;
  evidenceIds: string[];
}

export interface DomainEntity {
  name: string;
  attributes: DomainAttribute[];
  relations: DomainRelation[];
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Job / Phase contracts (docs/02 §4, docs/04, docs/07 §1)
// ---------------------------------------------------------------------------

export const JOB_STATES: readonly JobState[] = [
  "created",
  "validating_manifest",
  "rejected",
  "running",
  "awaiting_human",
  "blocked",
  "failed",
  "completed",
  "cancelled",
] as const;

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "rejected",
  "blocked",
  "failed",
  "completed",
  "cancelled",
] as const;

export const PHASE_STATUSES = ["pending", "running", "done", "skipped", "failed"] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const HANDOFF_KINDS = [
  "captcha",
  "sms_otp",
  "payment_approval",
  "manual_login",
  "other",
] as const;

export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** Pedido de intervenção humana devolvido por uma fase (docs/06). */
export interface HandoffRequest {
  kind: HandoffKind;
  message: string;
  liveUrl?: string;
  timeoutMin: number;
}

export type HandoffStatus = "pending" | "resolved" | "cancelled";

export interface HandoffRecord {
  id: string;
  jobId: string;
  kind: HandoffKind;
  status: HandoffStatus;
  message: string;
  liveUrl?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** Espelho da linha `jobs` do SQLite. */
export interface JobRecord {
  id: string;
  name: string;
  state: JobState;
  manifest: Manifest;
  createdAt: string;
  updatedAt: string;
  error?: string;
  llmTokensIn: number;
  llmTokensOut: number;
}

export interface PhaseRecord {
  jobId: string;
  phase: PhaseId;
  status: PhaseStatus;
  checkpoint?: unknown;
  startedAt?: string;
  finishedAt?: string;
  stats?: Record<string, number>;
}

/** Evento de progresso emitido pelo runner ou pelas fases. Persistido em `events`. */
export interface JobEvent {
  type: string;
  phase?: PhaseId;
  data?: Record<string, unknown>;
}

export interface StoredJobEvent extends JobEvent {
  id: number;
  jobId: string;
  ts: string;
}

export type PhaseResult =
  | { status: "ok"; stats: Record<string, number> }
  | { status: "awaiting_human"; handoff: HandoffRequest }
  | { status: "blocked"; reason: string };

export interface PhaseContext {
  job: JobRecord;
  manifest: Manifest;
  guard: ScopeGuard;
  evidence: EvidenceStore;
  llm: LlmClient;
  log: Logger;
  /** Timeout global / cancelamento. Fases devem abortar limpo quando sinalizado. */
  signal: AbortSignal;
  /** Último checkpoint salvo para esta fase (undefined na primeira execução). */
  checkpoint: unknown;
  /** Persiste checkpoint em `phases.checkpoint_json` (chamar a cada N itens). */
  saveCheckpoint(checkpoint: unknown): void;
  emit(event: JobEvent): void;
  // `browser` (F1-03) será adicionado quando o contrato existir.
}

export interface Phase {
  id: PhaseId;
  /** Permite à fase se desligar conforme o manifesto (ex.: `methods.publicDocs: false`). */
  isEnabled?(manifest: Manifest): boolean;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

export interface JobStatus {
  jobId: string;
  state: JobState;
  currentPhase?: PhaseId;
  phases: { id: PhaseId; status: PhaseStatus; stats?: Record<string, number> }[];
  counters: { pages: number; evidence: number; findings: number; rules: number };
  pendingHandoff?: { id: string; kind: string; message: string; liveUrl?: string };
  llm: { tokensIn: number; tokensOut: number };
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface JobSummary {
  jobId: string;
  name: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type {
  TargetType,
  OwnershipType,
  FormSubmissionMode,
  AccountStrategy,
  AccountIdentity,
  ChallengeAction,
  PaymentAction,
  ReportSection,
  ManifestMethod,
  ManifestInput,
  Manifest,
} from "../manifest.js";

export type {
  RobotsPolicy,
  ScopeGuardOptions,
  ScopeGuard,
} from "../scope-guard.js";

export type {
  AnyZodSchema,
  LlmClient,
  LlmGenerateResult,
  LlmMessage,
  LlmOptions,
  LlmRole,
  LlmTokenSink,
  LlmUsage,
  LlmUsageCallback,
  LlmUsageEvent,
};
