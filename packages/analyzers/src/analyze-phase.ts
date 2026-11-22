import type { Manifest, Phase, PhaseContext, PhaseId, PhaseResult } from "@cleanroom/core";
import { type BundleAnalyzerOptions, bundleAnalyzer } from "./bundle-analyzer.js";
import { type DocsHarvesterOptions, docsHarvester } from "./docs-harvester.js";
import { type HarToOpenApiOptions, harToOpenApi } from "./har-to-openapi.js";

export interface AnalyzePhaseCheckpoint {
  harToOpenApi?: unknown;
  docsHarvester?: unknown;
  bundleAnalyzer?: unknown;
}

export interface AnalyzePhaseOptions {
  phaseId?: PhaseId | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  harToOpenApi?: HarToOpenApiOptions | undefined;
  docsHarvester?: DocsHarvesterOptions | undefined;
  bundleAnalyzer?: BundleAnalyzerOptions | undefined;
}

function asCompositeCheckpoint(raw: unknown): AnalyzePhaseCheckpoint {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      ...(obj.harToOpenApi !== undefined ? { harToOpenApi: obj.harToOpenApi } : {}),
      ...(obj.docsHarvester !== undefined ? { docsHarvester: obj.docsHarvester } : {}),
      ...(obj.bundleAnalyzer !== undefined ? { bundleAnalyzer: obj.bundleAnalyzer } : {}),
    };
  }
  return {};
}

function createScopedContext(
  ctx: PhaseContext,
  key: keyof AnalyzePhaseCheckpoint,
  checkpointState: AnalyzePhaseCheckpoint,
): PhaseContext {
  return {
    job: ctx.job,
    manifest: ctx.manifest,
    guard: ctx.guard,
    evidence: ctx.evidence,
    llm: ctx.llm,
    log: ctx.log.child({ analyzer: key }),
    signal: ctx.signal,
    checkpoint: checkpointState[key],
    saveCheckpoint: (subCheckpoint: unknown) => {
      checkpointState[key] = subCheckpoint;
      ctx.saveCheckpoint({ ...checkpointState });
    },
    emit: (event) => ctx.emit(event),
  };
}

export function isAnalyzePhaseEnabled(manifest: Manifest): boolean {
  if (manifest.target.type === "repo") {
    return false;
  }
  return (
    manifest.methods.networkHar === true ||
    manifest.methods.publicDocs === true ||
    manifest.methods.staticBundles === true
  );
}

/**
 * Executa os três analisadores da Fase 4 (`harToOpenApi`, `docsHarvester`, `bundleAnalyzer`)
 * em paralelo (`docs/04` §4), isolando checkpoints por sub-analisador e consolidando estatísticas.
 */
export async function runAnalyzePhase(
  ctx: PhaseContext,
  options?: AnalyzePhaseOptions,
): Promise<PhaseResult> {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  const checkpointState = asCompositeCheckpoint(ctx.checkpoint);

  const harCtx = createScopedContext(ctx, "harToOpenApi", checkpointState);
  const docsCtx = createScopedContext(ctx, "docsHarvester", checkpointState);
  const bundleCtx = createScopedContext(ctx, "bundleAnalyzer", checkpointState);

  const docsOptions: DocsHarvesterOptions = {
    phaseId,
    ...(options?.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options?.docsHarvester ?? {}),
  };
  const bundleOptions: BundleAnalyzerOptions = {
    phaseId,
    ...(options?.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options?.bundleAnalyzer ?? {}),
  };
  const harOptions: HarToOpenApiOptions = {
    phaseId,
    ...(options?.harToOpenApi ?? {}),
  };

  const [harResult, docsResult, bundleResult] = await Promise.all([
    harToOpenApi(harCtx, harOptions),
    docsHarvester(docsCtx, docsOptions),
    bundleAnalyzer(bundleCtx, bundleOptions),
  ]);

  const stats: Record<string, number> = {
    openApiPaths: harResult.pathsCount,
    openApiOperations: harResult.operationsCount,
    callsAnalyzed: harResult.stats.callsAnalyzed,
    docPagesVisited: docsResult.stats.pagesVisited,
    docSections: docsResult.stats.docSections,
    pricingPlans: docsResult.stats.pricingPlans,
    bundlesAnalyzed: bundleResult.stats.bundlesAnalyzed,
    bundleRoutes: bundleResult.stats.routes,
    bundleEndpoints: bundleResult.stats.endpoints,
    bundleStrings: bundleResult.stats.strings,
    featureFlags: bundleResult.stats.featureFlags,
  };

  ctx.emit({
    type: "analyze_completed",
    phase: phaseId,
    data: stats,
  });

  return { status: "ok", stats };
}

export function createAnalyzePhase(options?: AnalyzePhaseOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "analyze";
  return {
    id: phaseId,
    isEnabled: isAnalyzePhaseEnabled,
    run: (ctx) => runAnalyzePhase(ctx, options),
  };
}

export const analyzePhase: Phase = createAnalyzePhase();
