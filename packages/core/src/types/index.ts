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
