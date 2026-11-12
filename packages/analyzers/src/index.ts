import type { PhaseId } from "@cleanroom/core";

export const ANALYZERS_PHASE_ID: PhaseId = "analyze";

export {
  DEFAULT_DOC_PATHS,
  decodeHtmlEntities,
  extractMainContent,
  htmlToMarkdown,
  extractPricingPlans,
  extractDocSections,
  discoverDocCandidateUrls,
  docsHarvester,
  runDocsHarvester,
  createDocsHarvesterPhase,
  type BillingPeriod,
  type DocSectionData,
  type PricingPlanData,
  type ExtractedDocSection,
  type DocsHarvesterCheckpoint,
  type DocsHarvesterOptions,
  type DocsHarvesterStats,
  type DocsHarvesterResult,
} from "./docs-harvester.js";
