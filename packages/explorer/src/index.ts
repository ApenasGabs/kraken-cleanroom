import type { PhaseId } from "@cleanroom/core";

export const INTAKE_PHASE_ID: PhaseId = "intake";
export const EXPLORER_PHASE_ID: PhaseId = "explore";

export {
  BrowserSession,
  withBrowserSession,
  normalizeViewport,
  resolveViewportsList,
  selectDesktopViewport,
  sanitizeCdpText,
  type ViewportSize,
  type ViewportInput,
  type CdpConnectOptions,
  type CdpConnector,
  type BrowserSessionOptions,
} from "./browser-session.js";

export {
  runIntakePhase,
  createIntakePhase,
  intakePhase,
  sanitizeResponseHeaders,
  normalizeSeedUrl,
  isUrlInAllowedOrigins,
  extractSitemapsFromRobots,
  parseSitemapXml,
  detectTechSignatures,
  detectRenderingMode,
  type RenderingMode,
  type TechSignature,
  type RenderingDetectionResult,
  type IntakeCheckpoint,
  type IntakeRunResult,
  type IntakePhaseOptions,
  type ParsedSitemapXml,
} from "./intake.js";
