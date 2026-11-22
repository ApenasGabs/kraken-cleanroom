import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BusinessRule,
  type DomainAttribute,
  type DomainEntity,
  type DomainRelation,
  type Evidence,
  type Finding,
  type FindingsDocument,
  type FlowSpec,
  type FlowStep,
  type Phase,
  type PhaseContext,
  type PhaseId,
  type PhaseResult,
  type StateMachineSpec,
  type StateMachineTransition,
  type SynthesisStats,
  type SynthesizedModule,
  createFindingId,
} from "@cleanroom/core";
import {
  DEFAULT_MAX_BATCH_TOKENS,
  buildSynthesizerSystemPrompt,
  paginateEvidenceBatches,
  serializeEvidenceForPrompt,
} from "./prompts.js";
import {
  ClusterModulesOutputSchema,
  ConsolidateRulesOutputSchema,
  ExtractFindingsOutputSchema,
  InferBehaviorOutputSchema,
  InferDomainOutputSchema,
} from "./schemas.js";
import {
  ClaimValidationTracker,
  HIGH_DISCARD_RATE_THRESHOLD,
  assignStableRuleIds,
  computeFindingFingerprint,
  deduplicateFindings,
} from "./validation.js";

export interface SynthesizerOptions {
  phaseId?: PhaseId | undefined;
  maxTokensPerBatch?: number | undefined;
  systemPromptTemplate?: string | undefined;
  outputPath?: string | undefined;
}

export interface SynthesizerCheckpoint {
  stage: "modules" | "findings" | "rules" | "domain" | "behavior" | "done";
  modules?: SynthesizedModule[];
  completedModuleIndex?: number;
  findings?: Finding[];
  rules?: BusinessRule[];
  entities?: DomainEntity[];
  stateMachines?: StateMachineSpec[];
  flows?: FlowSpec[];
  unsupportedClaimsDiscarded?: number;
  totalClaimsEvaluated?: number;
}

export interface SynthesizerStats extends Record<string, number> {
  modules: number;
  findings: number;
  rules: number;
  entities: number;
  stateMachines: number;
  flows: number;
  unsupportedClaimsDiscarded: number;
  totalClaimsEvaluated: number;
  discardRatePercent: number;
}

export interface SynthesizerResult {
  document: FindingsDocument;
  outputPath: string;
  stats: SynthesizerStats;
}

function isSynthesizerCheckpoint(value: unknown): value is SynthesizerCheckpoint {
  return (
    value !== null &&
    typeof value === "object" &&
    "stage" in value &&
    typeof (value as { stage: unknown }).stage === "string"
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Execução da fase synthesize abortada.");
  }
}

function matchEvidencesForModule(
  mod: SynthesizedModule,
  allEvidences: readonly Evidence[],
): Evidence[] {
  const idSet = new Set(mod.evidenceIds);
  const stateSet = new Set(mod.stateIds);
  const endpointSet = new Set(mod.endpoints);

  const matched = allEvidences.filter((ev) => {
    if (idSet.has(ev.id)) return true;
    if (ev.stateId !== undefined && stateSet.has(ev.stateId)) return true;
    if (ev.url !== undefined) {
      for (const ep of endpointSet) {
        if (ev.url.includes(ep)) return true;
      }
    }
    const pathTemplate = ev.data.pathTemplate;
    if (typeof pathTemplate === "string" && endpointSet.has(pathTemplate)) {
      return true;
    }
    return false;
  });

  return matched.length > 0 ? matched : [...allEvidences];
}

function buildCompactRulesContext(rules: readonly BusinessRule[]): unknown[] {
  return rules.map((r) => ({
    id: r.id,
    module: r.module,
    title: r.title,
    trigger: r.trigger,
    condition: r.condition,
    effect: r.effect,
    confidence: r.confidence,
    evidenceIds: r.evidenceIds,
  }));
}

function selectDomainRelevantEvidence(evidences: readonly Evidence[]): Evidence[] {
  const preferredKinds = new Set([
    "network_call",
    "form_schema",
    "form_probe",
    "pricing_plan",
    "doc_section",
    "state",
    "dom_snapshot",
    "a11y_snapshot",
    "bundle_route",
    "feature_flag",
  ]);
  const selected = evidences.filter((e) => preferredKinds.has(e.kind));
  return selected.length > 0 ? selected : [...evidences];
}

function selectBehaviorRelevantEvidence(evidences: readonly Evidence[]): Evidence[] {
  const preferredKinds = new Set([
    "state",
    "transition",
    "network_call",
    "form_schema",
    "form_probe",
    "dom_snapshot",
    "a11y_snapshot",
    "doc_section",
    "bundle_route",
    "feature_flag",
    "robots",
  ]);
  const selected = evidences.filter((e) => preferredKinds.has(e.kind));
  return selected.length > 0 ? selected : [...evidences];
}

/**
 * Executa a Fase 5 (`synthesize`, etapas 1 a 5 de `docs/04`) sobre as evidências persistidas no
 * `EvidenceStore` do job, validando `evidenceIds` contra o store e persistindo `findings`, `rules`
 * e `jobs/<jobId>/findings.json`.
 */
export async function runSynthesizePhase(
  ctx: PhaseContext,
  options?: SynthesizerOptions,
): Promise<SynthesizerResult> {
  const phaseId: PhaseId = options?.phaseId ?? "synthesize";
  const maxBatchTokens = options?.maxTokensPerBatch ?? DEFAULT_MAX_BATCH_TOKENS;
  const template = options?.systemPromptTemplate;
  const jobId = ctx.job.id;
  const outputPath =
    options?.outputPath ?? join(ctx.evidence.resolveJobDir(jobId), "findings.json");

  assertNotAborted(ctx.signal);

  const allEvidences = ctx.evidence.listAll(jobId);
  const validEvidenceIds = ctx.evidence.filterExistingIds(
    jobId,
    allEvidences.map((e) => e.id),
  );
  const tracker = new ClaimValidationTracker(validEvidenceIds, (event) => {
    ctx.emit({ ...event, phase: phaseId });
  });

  const cp = isSynthesizerCheckpoint(ctx.checkpoint) ? ctx.checkpoint : undefined;
  if (cp !== undefined) {
    tracker.discarded = cp.unsupportedClaimsDiscarded ?? 0;
    tracker.totalEvaluated = cp.totalClaimsEvaluated ?? 0;
  }

  if (allEvidences.length === 0) {
    const emptyStats: SynthesisStats = {
      modules: 0,
      findings: 0,
      rules: 0,
      entities: 0,
      stateMachines: 0,
      flows: 0,
      unsupportedClaimsDiscarded: 0,
      totalClaimsEvaluated: 0,
      discardRatePercent: 0,
    };
    const emptyDoc: FindingsDocument = {
      version: 1,
      jobId,
      generatedAt: new Date().toISOString(),
      modules: [],
      findings: [],
      rules: [],
      domain: { entities: [] },
      stateMachines: [],
      flows: [],
      features: [],
      stats: emptyStats,
    };
    ctx.evidence.saveRules(jobId, []);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(emptyDoc, null, 2)}\n`, "utf8");
    ctx.emit({ type: "synthesize_completed", phase: phaseId, data: emptyStats });
    return { document: emptyDoc, outputPath, stats: emptyStats };
  }

  // -------------------------------------------------------------------------
  // Etapa 1: Clusterização em módulos funcionais
  // -------------------------------------------------------------------------
  let modules: SynthesizedModule[];
  if (cp?.modules !== undefined && cp.stage !== "modules") {
    modules = cp.modules;
  } else {
    assertNotAborted(ctx.signal);
    const moduleBatches = paginateEvidenceBatches(allEvidences, maxBatchTokens);
    const batchesToCluster =
      moduleBatches.length > 0 ? moduleBatches : [allEvidences.map(serializeEvidenceForPrompt)];
    const systemPrompt = buildSynthesizerSystemPrompt(
      ctx.manifest,
      ClusterModulesOutputSchema,
      template,
    );

    const byModuleName = new Map<string, SynthesizedModule>();
    for (let bIdx = 0; bIdx < batchesToCluster.length; bIdx += 1) {
      assertNotAborted(ctx.signal);
      const batch = batchesToCluster[bIdx];
      if (batch === undefined) continue;

      const res = await ctx.llm.generateObject(
        ClusterModulesOutputSchema,
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              task: "Etapa 1: Agrupe os estados, endpoints, formulários e seções de documentação em módulos funcionais coesos.",
              batch: { index: bIdx + 1, total: batchesToCluster.length },
              evidences: batch,
            }),
          },
        ],
        { schemaName: "synthesize_modules", signal: ctx.signal, jobId },
      );

      for (const rawMod of res.data.modules) {
        const check = tracker.validateClaim("module", rawMod.name, rawMod.evidenceIds);
        if (!check.supported) {
          continue;
        }
        const cleanName = rawMod.name.trim();
        const key = cleanName.toLowerCase();
        const existing = byModuleName.get(key);
        if (existing === undefined) {
          byModuleName.set(key, {
            name: cleanName,
            description: rawMod.description.trim(),
            stateIds: [...new Set(rawMod.stateIds)],
            endpoints: [...new Set(rawMod.endpoints)],
            docSections: [...new Set(rawMod.docSections)],
            evidenceIds: check.evidenceIds,
          });
        } else {
          byModuleName.set(key, {
            name: existing.name,
            description: existing.description || rawMod.description.trim(),
            stateIds: [...new Set([...existing.stateIds, ...rawMod.stateIds])],
            endpoints: [...new Set([...existing.endpoints, ...rawMod.endpoints])],
            docSections: [...new Set([...existing.docSections, ...rawMod.docSections])],
            evidenceIds: [...new Set([...existing.evidenceIds, ...check.evidenceIds])],
          });
        }
      }
    }

    modules = [...byModuleName.values()];

    ctx.saveCheckpoint({
      stage: "findings",
      modules,
      completedModuleIndex: -1,
      findings: [],
      unsupportedClaimsDiscarded: tracker.discarded,
      totalClaimsEvaluated: tracker.totalEvaluated,
    } satisfies SynthesizerCheckpoint);
  }

  // -------------------------------------------------------------------------
  // Etapa 2: Extração de Finding[] por módulo (lotes <= ~30k tokens)
  // -------------------------------------------------------------------------
  let findings: Finding[];
  const resumeAtFinding = cp?.stage === "findings" || cp?.stage === "modules" || cp === undefined;
  if (!resumeAtFinding && cp?.findings !== undefined) {
    findings = cp.findings;
  } else {
    const accumulated: Finding[] = [...(cp?.findings ?? [])];
    const startModuleIdx = (cp?.completedModuleIndex ?? -1) + 1;
    const systemPrompt = buildSynthesizerSystemPrompt(
      ctx.manifest,
      ExtractFindingsOutputSchema,
      template,
    );

    const targetModules =
      modules.length > 0
        ? modules
        : [
            {
              name: "Geral",
              description: "Comportamento geral observado",
              stateIds: [],
              endpoints: [],
              docSections: [],
              evidenceIds: allEvidences.map((e) => e.id),
            },
          ];

    for (let modIdx = startModuleIdx; modIdx < targetModules.length; modIdx += 1) {
      const mod = targetModules[modIdx];
      if (mod === undefined) continue;
      assertNotAborted(ctx.signal);
      const moduleEvidences = matchEvidencesForModule(mod, allEvidences);
      const batches = paginateEvidenceBatches(moduleEvidences, maxBatchTokens);

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx += 1) {
        assertNotAborted(ctx.signal);
        const batch = batches[batchIdx];
        if (batch === undefined) continue;

        const res = await ctx.llm.generateObject(
          ExtractFindingsOutputSchema,
          [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: JSON.stringify({
                task: `Etapa 2: Extraia achados comportamentais atômicos (Finding[]) para o módulo "${mod.name}".`,
                module: mod,
                batch: { index: batchIdx + 1, total: batches.length },
                evidences: batch,
              }),
            },
          ],
          { schemaName: "synthesize_findings", signal: ctx.signal, jobId },
        );

        for (const rawFinding of res.data.findings) {
          const check = tracker.validateClaim(
            "finding",
            `${rawFinding.module}: ${rawFinding.statement}`,
            rawFinding.evidenceIds,
          );
          if (!check.supported) {
            continue;
          }
          const modName = rawFinding.module.trim() || mod.name;
          const statement = rawFinding.statement.trim();
          accumulated.push({
            id: createFindingId(),
            jobId,
            module: modName,
            category: rawFinding.category,
            statement,
            confidence: rawFinding.confidence,
            evidenceIds: check.evidenceIds,
            fingerprint: computeFindingFingerprint(modName, rawFinding.category, statement),
          });
        }
      }

      ctx.saveCheckpoint({
        stage: "findings",
        modules,
        completedModuleIndex: modIdx,
        findings: accumulated,
        unsupportedClaimsDiscarded: tracker.discarded,
        totalClaimsEvaluated: tracker.totalEvaluated,
      } satisfies SynthesizerCheckpoint);
    }

    const deduplicated = deduplicateFindings(accumulated);
    findings = ctx.evidence.saveFindings(jobId, deduplicated);

    ctx.saveCheckpoint({
      stage: "rules",
      modules,
      findings,
      unsupportedClaimsDiscarded: tracker.discarded,
      totalClaimsEvaluated: tracker.totalEvaluated,
    } satisfies SynthesizerCheckpoint);
  }

  // -------------------------------------------------------------------------
  // Etapa 3: Consolidação em BusinessRule[] com IDs estáveis BR-001, BR-002...
  // -------------------------------------------------------------------------
  let rules: BusinessRule[];
  if (
    cp?.rules !== undefined &&
    (cp.stage === "domain" || cp.stage === "behavior" || cp.stage === "done")
  ) {
    rules = cp.rules;
  } else {
    assertNotAborted(ctx.signal);
    const validFindingIds = new Set(findings.map((f) => f.id));
    const systemPrompt = buildSynthesizerSystemPrompt(
      ctx.manifest,
      ConsolidateRulesOutputSchema,
      template,
    );

    const res = await ctx.llm.generateObject(
      ConsolidateRulesOutputSchema,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            task: "Etapa 3: Consolide os achados deduplicados em regras de negócio estruturadas (trigger/condition/effect) com rastreabilidade.",
            modules: modules.map((m) => ({ name: m.name, description: m.description })),
            findings,
          }),
        },
      ],
      { schemaName: "synthesize_rules", signal: ctx.signal, jobId },
    );

    const validRawRules: Omit<BusinessRule, "id">[] = [];
    for (const rawRule of res.data.rules) {
      const check = tracker.validateClaim("rule", rawRule.title, rawRule.evidenceIds);
      if (!check.supported) {
        continue;
      }
      const validFds = [...new Set(rawRule.findingIds.filter((id) => validFindingIds.has(id)))];
      validRawRules.push({
        module: rawRule.module.trim(),
        title: rawRule.title.trim(),
        trigger: rawRule.trigger.trim(),
        condition: rawRule.condition.trim(),
        effect: rawRule.effect.trim(),
        confidence: rawRule.confidence,
        findingIds: validFds,
        evidenceIds: check.evidenceIds,
      });
    }

    rules = assignStableRuleIds(validRawRules);
    ctx.evidence.saveRules(jobId, rules);

    ctx.saveCheckpoint({
      stage: "domain",
      modules,
      findings,
      rules,
      unsupportedClaimsDiscarded: tracker.discarded,
      totalClaimsEvaluated: tracker.totalEvaluated,
    } satisfies SynthesizerCheckpoint);
  }

  // -------------------------------------------------------------------------
  // Etapa 4: Inferência de DomainEntity[] (atributos, tipos, relacionamentos)
  // -------------------------------------------------------------------------
  let entities: DomainEntity[];
  if (cp?.entities !== undefined && (cp.stage === "behavior" || cp.stage === "done")) {
    entities = cp.entities;
  } else {
    assertNotAborted(ctx.signal);
    const domainEvidences = selectDomainRelevantEvidence(allEvidences);
    const domainBatches = paginateEvidenceBatches(domainEvidences, maxBatchTokens);
    const systemPrompt = buildSynthesizerSystemPrompt(
      ctx.manifest,
      InferDomainOutputSchema,
      template,
    );

    const res = await ctx.llm.generateObject(
      InferDomainOutputSchema,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            task: "Etapa 4: Infira as entidades de domínio (DomainEntity[]), seus atributos, tipos, obrigatoriedade e relacionamentos a partir dos shapes de API, formulários, regras e documentação.",
            rules: buildCompactRulesContext(rules),
            evidences: domainBatches[0] ?? [],
          }),
        },
      ],
      { schemaName: "synthesize_domain", signal: ctx.signal, jobId },
    );

    entities = [];
    for (const rawEntity of res.data.entities) {
      const attributes: DomainAttribute[] = [];
      for (const attr of rawEntity.attributes) {
        const check = tracker.validateClaim(
          "domain_attribute",
          `${rawEntity.name}.${attr.name}`,
          attr.evidenceIds,
        );
        if (!check.supported) continue;
        attributes.push({
          name: attr.name.trim(),
          type: attr.type.trim(),
          required: attr.required,
          ...(attr.notes !== undefined ? { notes: attr.notes.trim() } : {}),
          evidenceIds: check.evidenceIds,
        });
      }

      const relations: DomainRelation[] = [];
      for (const rel of rawEntity.relations) {
        const check = tracker.validateClaim(
          "domain_relation",
          `${rawEntity.name}->${rel.to}`,
          rel.evidenceIds,
        );
        if (!check.supported) continue;
        relations.push({
          to: rel.to.trim(),
          kind: rel.kind,
          evidenceIds: check.evidenceIds,
        });
      }

      if (attributes.length > 0 || relations.length > 0) {
        entities.push({
          name: rawEntity.name.trim(),
          attributes,
          relations,
        });
      }
    }

    ctx.saveCheckpoint({
      stage: "behavior",
      modules,
      findings,
      rules,
      entities,
      unsupportedClaimsDiscarded: tracker.discarded,
      totalClaimsEvaluated: tracker.totalEvaluated,
    } satisfies SynthesizerCheckpoint);
  }

  // -------------------------------------------------------------------------
  // Etapa 5: Máquinas de estado (stateMachines) e fluxos principais (flows)
  // -------------------------------------------------------------------------
  let stateMachines: StateMachineSpec[];
  let flows: FlowSpec[];
  if (cp?.stateMachines !== undefined && cp?.flows !== undefined && cp.stage === "done") {
    stateMachines = cp.stateMachines;
    flows = cp.flows;
  } else {
    assertNotAborted(ctx.signal);
    const behaviorEvidences = selectBehaviorRelevantEvidence(allEvidences);
    const behaviorBatches = paginateEvidenceBatches(behaviorEvidences, maxBatchTokens);
    const systemPrompt = buildSynthesizerSystemPrompt(
      ctx.manifest,
      InferBehaviorOutputSchema,
      template,
    );

    const res = await ctx.llm.generateObject(
      InferBehaviorOutputSchema,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            task: "Etapa 5: Infira as máquinas de estado (stateMachines) e os fluxos principais (flows) com rastreabilidade a evidências.",
            entities: entities.map((e) => e.name),
            rules: buildCompactRulesContext(rules),
            evidences: behaviorBatches[0] ?? [],
          }),
        },
      ],
      { schemaName: "synthesize_behavior", signal: ctx.signal, jobId },
    );

    stateMachines = [];
    for (const rawSm of res.data.stateMachines) {
      const smCheck = tracker.validateClaim("state_machine", rawSm.entity, rawSm.evidenceIds);
      if (!smCheck.supported) continue;

      const transitions: StateMachineTransition[] = [];
      for (const tr of rawSm.transitions) {
        const trCheck = tracker.validateClaim(
          "state_transition",
          `${rawSm.entity}: ${tr.from}->${tr.to}`,
          tr.evidenceIds,
        );
        if (!trCheck.supported) continue;
        transitions.push({
          from: tr.from.trim(),
          to: tr.to.trim(),
          trigger: tr.trigger.trim(),
          ...(tr.guard !== undefined ? { guard: tr.guard.trim() } : {}),
          evidenceIds: trCheck.evidenceIds,
        });
      }

      stateMachines.push({
        entity: rawSm.entity.trim(),
        states: [...new Set(rawSm.states.map((s) => s.trim()))],
        ...(rawSm.initialState !== undefined ? { initialState: rawSm.initialState.trim() } : {}),
        ...(rawSm.terminalStates !== undefined
          ? { terminalStates: rawSm.terminalStates.map((s) => s.trim()) }
          : {}),
        transitions,
        evidenceIds: smCheck.evidenceIds,
      });
    }

    flows = [];
    for (const rawFlow of res.data.flows) {
      const flowCheck = tracker.validateClaim("flow", rawFlow.name, rawFlow.evidenceIds);
      if (!flowCheck.supported) continue;

      const steps: FlowStep[] = [];
      for (const step of rawFlow.steps) {
        const stepCheck = tracker.validateClaim(
          "flow_step",
          `${rawFlow.name}#${step.order}`,
          step.evidenceIds,
        );
        if (!stepCheck.supported) continue;
        steps.push({
          order: step.order,
          actor: step.actor.trim(),
          action: step.action.trim(),
          outcome: step.outcome.trim(),
          evidenceIds: stepCheck.evidenceIds,
        });
      }

      steps.sort((a, b) => a.order - b.order);

      flows.push({
        name: rawFlow.name.trim(),
        module: rawFlow.module.trim(),
        description: rawFlow.description.trim(),
        steps,
        evidenceIds: flowCheck.evidenceIds,
      });
    }

    ctx.saveCheckpoint({
      stage: "done",
      modules,
      findings,
      rules,
      entities,
      stateMachines,
      flows,
      unsupportedClaimsDiscarded: tracker.discarded,
      totalClaimsEvaluated: tracker.totalEvaluated,
    } satisfies SynthesizerCheckpoint);
  }

  // -------------------------------------------------------------------------
  // Pós-processamento: taxa de descarte (alerta se > 20%) + findings.json
  // -------------------------------------------------------------------------
  const discardRate = tracker.getDiscardRate();
  const discardRatePercent = tracker.getDiscardRatePercent();
  ctx.emit({
    type: "synthesis_discard_summary",
    phase: phaseId,
    data: {
      discarded: tracker.discarded,
      totalEvaluated: tracker.totalEvaluated,
      discardRate,
      discardRatePercent,
    },
  });

  if (discardRate > HIGH_DISCARD_RATE_THRESHOLD) {
    ctx.log.warn(
      {
        phase: phaseId,
        discarded: tracker.discarded,
        totalEvaluated: tracker.totalEvaluated,
        discardRatePercent,
      },
      "Taxa de descarte de claims sem evidência acima de 20%",
    );
    ctx.emit({
      type: "synthesis_high_discard_alert",
      phase: phaseId,
      data: {
        discarded: tracker.discarded,
        totalEvaluated: tracker.totalEvaluated,
        discardRatePercent,
      },
    });
  }

  const stats: SynthesizerStats = {
    modules: modules.length,
    findings: findings.length,
    rules: rules.length,
    entities: entities.length,
    stateMachines: stateMachines.length,
    flows: flows.length,
    unsupportedClaimsDiscarded: tracker.discarded,
    totalClaimsEvaluated: tracker.totalEvaluated,
    discardRatePercent,
  };

  const document: FindingsDocument = {
    version: 1,
    jobId,
    generatedAt: new Date().toISOString(),
    modules,
    findings,
    rules,
    domain: { entities },
    stateMachines,
    flows,
    // Nota de escopo MVP (docs/11): Gherkin `.feature` pertence à Fase 3 (F3-03).
    features: [],
    stats,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  ctx.emit({ type: "synthesize_completed", phase: phaseId, data: stats });
  return { document, outputPath, stats };
}

export const synthesize = runSynthesizePhase;

export function createSynthesizePhase(options?: SynthesizerOptions): Phase {
  const phaseId: PhaseId = options?.phaseId ?? "synthesize";
  return {
    id: phaseId,
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const result = await runSynthesizePhase(ctx, options);
      return { status: "ok", stats: result.stats };
    },
  };
}

export const synthesizePhase: Phase = createSynthesizePhase();
