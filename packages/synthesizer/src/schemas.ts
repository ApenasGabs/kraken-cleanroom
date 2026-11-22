import { CONFIDENCE_LEVELS, DOMAIN_RELATION_KINDS, FINDING_CATEGORIES } from "@cleanroom/core";
import { type ZodTypeAny, z } from "zod";

export const RawModuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  stateIds: z.array(z.string()).default([]),
  endpoints: z.array(z.string()).default([]),
  docSections: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export const ClusterModulesOutputSchema = z.object({
  modules: z.array(RawModuleSchema),
});

export const RawFindingSchema = z.object({
  module: z.string().min(1),
  category: z.enum(FINDING_CATEGORIES),
  statement: z.string().min(1),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidenceIds: z.array(z.string()).default([]),
});

export const ExtractFindingsOutputSchema = z.object({
  findings: z.array(RawFindingSchema),
});

export const RawBusinessRuleSchema = z.object({
  module: z.string().min(1),
  title: z.string().min(1),
  trigger: z.string().min(1),
  condition: z.string().min(1),
  effect: z.string().min(1),
  confidence: z.enum(CONFIDENCE_LEVELS),
  findingIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export const ConsolidateRulesOutputSchema = z.object({
  rules: z.array(RawBusinessRuleSchema),
});

export const RawDomainAttributeSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().default(false),
  notes: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});

export const RawDomainRelationSchema = z.object({
  to: z.string().min(1),
  kind: z.enum(DOMAIN_RELATION_KINDS),
  evidenceIds: z.array(z.string()).default([]),
});

export const RawDomainEntitySchema = z.object({
  name: z.string().min(1),
  attributes: z.array(RawDomainAttributeSchema).default([]),
  relations: z.array(RawDomainRelationSchema).default([]),
});

export const InferDomainOutputSchema = z.object({
  entities: z.array(RawDomainEntitySchema),
});

export const RawStateMachineTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  trigger: z.string().min(1),
  guard: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});

export const RawStateMachineSchema = z.object({
  entity: z.string().min(1),
  states: z.array(z.string().min(1)).default([]),
  initialState: z.string().optional(),
  terminalStates: z.array(z.string()).optional(),
  transitions: z.array(RawStateMachineTransitionSchema).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export const RawFlowStepSchema = z.object({
  order: z.number().int().positive(),
  actor: z.string().min(1),
  action: z.string().min(1),
  outcome: z.string().min(1),
  evidenceIds: z.array(z.string()).default([]),
});

export const RawFlowSchema = z.object({
  name: z.string().min(1),
  module: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(RawFlowStepSchema).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export const InferBehaviorOutputSchema = z.object({
  stateMachines: z.array(RawStateMachineSchema).default([]),
  flows: z.array(RawFlowSchema).default([]),
});

export const ReportNarrativeHighlightSchema = z.object({
  text: z.string().min(1),
  ruleIds: z.array(z.string()).default([]),
});

export const ReportNarrativePersonaSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
});

export const ReportNarrativeModuleFeatureSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidenceIds: z.array(z.string()).default([]),
});

export const ReportNarrativeModuleSummarySchema = z.object({
  moduleName: z.string().min(1),
  summary: z.string().min(1),
  features: z.array(ReportNarrativeModuleFeatureSchema).default([]),
});

export const ReportNarrativeApiPurposeSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  purpose: z.string().min(1),
});

export const ReportNarrativeOutputSchema = z.object({
  productName: z.string().min(1),
  executiveNarrative: z.string().min(1),
  highlights: z.array(ReportNarrativeHighlightSchema).default([]),
  valueProposition: z.string().min(1),
  personas: z.array(ReportNarrativePersonaSchema).default([]),
  moduleSummaries: z.array(ReportNarrativeModuleSummarySchema).default([]),
  permissionsMatrixMarkdown: z.string().min(1),
  apiPurposes: z.array(ReportNarrativeApiPurposeSchema).default([]),
});

export type ClusterModulesOutput = z.infer<typeof ClusterModulesOutputSchema>;
export type ExtractFindingsOutput = z.infer<typeof ExtractFindingsOutputSchema>;
export type ConsolidateRulesOutput = z.infer<typeof ConsolidateRulesOutputSchema>;
export type InferDomainOutput = z.infer<typeof InferDomainOutputSchema>;
export type InferBehaviorOutput = z.infer<typeof InferBehaviorOutputSchema>;
export type ReportNarrativeOutput = z.infer<typeof ReportNarrativeOutputSchema>;

interface ZodDefLike {
  typeName?: string;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  values?: readonly string[];
  value?: unknown;
  valueType?: ZodTypeAny;
  options?: readonly ZodTypeAny[];
  checks?: readonly { kind?: string; value?: unknown }[];
}

function getDef(schema: ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def?: ZodDefLike })._def ?? {};
}

function isOptionalSchema(schema: ZodTypeAny): boolean {
  const def = getDef(schema);
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}

/**
 * Converte um schema Zod em JSON Schema enxuto para inclusão no prompt do synthesizer (`docs/05` §5).
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = getDef(schema);
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case "ZodNullable": {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      const innerType = inner.type;
      if (typeof innerType === "string") {
        return { ...inner, type: [innerType, "null"] };
      }
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const isInt = def.checks?.some((c) => c.kind === "int") ?? false;
      return { type: isInt ? "integer" : "number" };
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values ?? [])] };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodArray":
      return {
        type: "array",
        items: def.type ? zodToJsonSchema(def.type) : {},
      };
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : true,
      };
    case "ZodUnion":
      return {
        anyOf: (def.options ?? []).map((opt) => zodToJsonSchema(opt)),
      };
    case "ZodObject": {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(fieldSchema);
        if (!isOptionalSchema(fieldSchema)) {
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}
