export {
  DEFAULT_PHASE_ORDER,
  type Confidence,
  type JobState,
  type PhaseId,
} from "./types/index.js";

export {
  CLEANROOM_ERROR_CODES,
  CleanroomError,
  ConfigError,
  ManifestError,
  MethodNotAllowedError,
  OutOfScopeError,
  DestructiveActionError,
  BrowserUnavailableError,
  LlmInvalidOutputError,
  LlmUnavailableError,
  JobNotFoundError,
  JobConflictError,
  JobBlockedError,
  EvidenceNotFoundError,
  HandoffNotFoundError,
  UnauthorizedError,
  isCleanroomError,
  type CleanroomErrorCode,
  type CleanroomErrorOptions,
  type SerializedCleanroomError,
  type ErrorEnvelope,
  type ConfigIssue,
  type ManifestIssueDetail,
} from "./errors.js";

export {
  LLM_PROVIDERS,
  LOG_LEVELS,
  loadConfig,
  assertBrowserConfig,
  assertLlmConfig,
  type LlmProvider,
  type LogLevel,
  type CleanroomConfig,
  type LoadConfigOptions,
} from "./config.js";

export {
  REDACT_PATHS,
  createLogger,
  redactUrlTokens,
  sanitizeLogValue,
  type Logger,
  type CreateLoggerOptions,
} from "./logger.js";

export {
  TARGET_TYPES,
  OWNERSHIP_TYPES,
  FORM_SUBMISSION_MODES,
  ACCOUNT_STRATEGIES,
  ACCOUNT_IDENTITIES,
  CHALLENGE_ACTIONS,
  PAYMENT_ACTIONS,
  REPORT_SECTIONS,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_REPORT_VIEWPORTS,
  MANIFEST_METHODS,
  manifestSchema,
  mergeForbiddenPaths,
  parseManifestObject,
  parseManifestYaml,
  loadManifest,
  type TargetType,
  type OwnershipType,
  type FormSubmissionMode,
  type AccountStrategy,
  type AccountIdentity,
  type ChallengeAction,
  type PaymentAction,
  type ReportSection,
  type ManifestMethod,
  type ManifestInput,
  type Manifest,
  type LoadManifestOptions,
} from "./manifest.js";

export {
  parseRobotsTxt,
  isAllowedByRobots,
  createScopeGuard,
  type RobotsPolicy,
  type ScopeGuardOptions,
  type ScopeGuard,
} from "./scope-guard.js";

export const CORE_VERSION = "0.1.0";
