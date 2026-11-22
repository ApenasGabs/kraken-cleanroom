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
  ReportNarrativeHighlightSchema,
  ReportNarrativePersonaSchema,
  ReportNarrativeModuleFeatureSchema,
  ReportNarrativeModuleSummarySchema,
  ReportNarrativeApiPurposeSchema,
  ReportNarrativeOutputSchema,
  zodToJsonSchema,
  type ClusterModulesOutput,
  type ExtractFindingsOutput,
  type ConsolidateRulesOutput,
  type InferDomainOutput,
  type InferBehaviorOutput,
  type ReportNarrativeOutput,
} from "./schemas.js";

export {
  DEFAULT_MAX_BATCH_TOKENS,
  resolveSystemPromptPath,
  loadSystemPromptTemplate,
  formatManifestContext,
  buildSynthesizerSystemPrompt,
  buildReportNarrativeSystemPrompt,
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

export {
  sanitizeMermaidIdentifier,
  sanitizeMermaidLabel,
  generateErMermaid,
  generateStateMachineMermaid,
  generateFlowSequenceMermaid,
  extractMermaidBlocks,
  validateMermaidSyntax,
  validateMarkdownMermaidBlocks,
  type MermaidValidationResult,
  type MarkdownMermaidCheckResult,
} from "./report-mermaid.js";

export {
  resolveReportTemplatePath,
  loadReportTemplate,
  filterReportMarkdownSections,
  renderReportTemplate,
} from "./report-renderer.js";

export {
  DEFAULT_ANTI_COPY_MIN_CHARS,
  ANTI_COPY_EVIDENCE_KINDS,
  collectAntiCopyCorpus,
  findLiteralCopyViolations,
  extractReferencedAssetFilenames,
  verifyReportQuality,
  type AntiCopyCorpusEntry,
  type VerifyReportQualityInput,
} from "./report-quality.js";

export {
  runReportPhase,
  createReportPhase,
  reportPhase,
  type ReportOptions,
  type ReportStats,
  type ReportPhaseResult,
} from "./report.js";
