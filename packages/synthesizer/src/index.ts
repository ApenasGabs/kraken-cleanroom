import type { PhaseId } from "@cleanroom/core";

export const SYNTHESIZER_PHASE_ID: PhaseId = "synthesize";

export {
  RawModuleSchema,
  ClusterModulesOutputSchema,
  RawFindingSchema,
  ExtractFindingsOutputSchema,
  RawBusinessRuleSchema,
  ConsolidateRulesOutputSchema,
  RawDomainAttributeSchema,
  RawDomainRelationSchema,
  RawDomainEntitySchema,
  InferDomainOutputSchema,
  RawStateMachineTransitionSchema,
  RawStateMachineSchema,
  RawFlowStepSchema,
  RawFlowSchema,
  InferBehaviorOutputSchema,
  zodToJsonSchema,
  type ClusterModulesOutput,
  type ExtractFindingsOutput,
  type ConsolidateRulesOutput,
  type InferDomainOutput,
  type InferBehaviorOutput,
} from "./schemas.js";

export {
  DEFAULT_MAX_BATCH_TOKENS,
  resolveSystemPromptPath,
  loadSystemPromptTemplate,
  formatManifestContext,
  buildSynthesizerSystemPrompt,
  serializeEvidenceForPrompt,
  estimateTokens,
  paginateEvidenceBatches,
  type CompactEvidenceEntry,
} from "./prompts.js";

export {
  HIGH_DISCARD_RATE_THRESHOLD,
  normalizeTextForFingerprint,
  computeFindingFingerprint,
  deduplicateFindings,
  filterSupportedEvidenceIds,
  assignStableRuleIds,
  ClaimValidationTracker,
  type UnsupportedClaimType,
} from "./validation.js";

export {
  runSynthesizePhase,
  synthesize,
  createSynthesizePhase,
  synthesizePhase,
  type SynthesizerOptions,
  type SynthesizerCheckpoint,
  type SynthesizerStats,
  type SynthesizerResult,
} from "./pipeline.js";
