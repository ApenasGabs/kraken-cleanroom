import type { DomainEntity, DomainRelationKind, FlowSpec, StateMachineSpec } from "@cleanroom/core";

export interface MermaidValidationResult {
  valid: boolean;
  kind?:
    | "erDiagram"
    | "stateDiagram-v2"
    | "stateDiagram"
    | "sequenceDiagram"
    | "flowchart"
    | "graph";
  errors: string[];
}

export interface MarkdownMermaidCheckResult {
  valid: boolean;
  blockCount: number;
  errors: string[];
}

const ER_RELATION_OPERATOR_REGEX =
  /^(\|\||\|o|o\||\}\||\|\{|\}o|o\{|1)(--|\.\.)(\|\||\|o|o\||\}\||\|\{|\}o|o\{|1)$/;

const ER_ATTRIBUTE_REGEX =
  /^[A-Za-z_][A-Za-z0-9_<>~*-]*\s+[A-Za-z_][A-Za-z0-9_-]*(?:\s+(?:PK|FK|UK)(?:,(?:PK|FK|UK))*)?(?:\s+"[^"]*")?$/;

const ER_ENTITY_OPEN_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*(?:\["[^"]+"\])?\s*\{$/;
const ER_STANDALONE_ENTITY_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ER_RELATION_LINE_REGEX =
  /^([A-Za-z_][A-Za-z0-9_-]*)\s+([^\s]+)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(?:"[^"]*"|[^\s].*)$/;

const STATE_ID_TOKEN = "(?:\\[\\*\\]|[A-Za-z_][A-Za-z0-9_-]*)";
const STATE_TRANSITION_REGEX = new RegExp(
  `^${STATE_ID_TOKEN}\\s*-->\\s*${STATE_ID_TOKEN}(?:\\s*:\\s*\\S.*)?$`,
);
const STATE_ALIAS_REGEX = /^state\s+"[^"]+"\s+as\s+[A-Za-z_][A-Za-z0-9_-]*$/;
const STATE_COMPOSITE_OPEN_REGEX =
  /^(?:state\s+(?:"[^"]+"\s+as\s+)?[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*)\s*\{$/;
const STATE_STEREOTYPE_REGEX = /^state\s+[A-Za-z_][A-Za-z0-9_-]*\s+<<(?:choice|fork|join)>>$/;

const SEQ_PARTICIPANT_REGEX = /^(?:participant|actor)\s+[A-Za-z_][A-Za-z0-9_-]*(?:\s+as\s+.+)?$/;
const SEQ_MESSAGE_REGEX =
  /^[A-Za-z_][A-Za-z0-9_-]*\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))[+-]?\s*[A-Za-z_][A-Za-z0-9_-]*\s*:\s*\S.*$/;
const SEQ_BLOCK_OPEN_REGEX = /^(?:loop|alt|opt|par|critical|break|rect)\b/i;

/**
 * Converte um nome arbitrário em identificador seguro para nós/participantes Mermaid.
 */
export function sanitizeMermaidIdentifier(raw: string, fallback = "Item"): string {
  const normalized = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) {
    return fallback;
  }
  return /^[A-Za-z_]/.test(normalized) ? normalized : `N_${normalized}`;
}

/**
 * Sanitiza textos usados em rótulos e mensagens Mermaid para não quebrar a sintaxe.
 */
export function sanitizeMermaidLabel(raw: string, fallback = "evento"): string {
  const cleaned = raw
    .replace(/\r?\n+/g, " ")
    .replace(/[:"`;{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 140) : fallback;
}

function sanitizeErAttributeType(rawType: string): string {
  const cleaned = rawType
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\|/g, "_or_")
    .replace(/[^A-Za-z0-9_<>*-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) {
    return "string";
  }
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `t_${cleaned}`;
}

function mapRelationToErOperator(kind: DomainRelationKind): string {
  switch (kind) {
    case "1-1":
      return "||--||";
    case "1-n":
      return "||--o{";
    case "n-n":
      return "}o--o{";
  }
}

/**
 * Gera bloco Mermaid `erDiagram` válido a partir de `DomainEntity[]` (`docs/05` §6).
 */
export function generateErMermaid(entities: readonly DomainEntity[]): string {
  if (entities.length === 0) {
    return [
      "erDiagram",
      "  DomainEmpty {",
      '    string note "Nenhuma entidade de dominio inferida"',
      "  }",
    ].join("\n");
  }

  const lines: string[] = ["erDiagram"];
  const entityIds = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const entity of entities) {
    let id = sanitizeMermaidIdentifier(entity.name, "Entity");
    while (usedIds.has(id)) {
      id = `${id}_${usedIds.size + 1}`;
    }
    usedIds.add(id);
    entityIds.set(entity.name.trim().toLowerCase(), id);
  }

  for (const entity of entities) {
    const entityId = entityIds.get(entity.name.trim().toLowerCase()) ?? "Entity";
    if (entity.attributes.length === 0) {
      lines.push(`  ${entityId} {`);
      lines.push('    string id "entidade inferida"');
      lines.push("  }");
      continue;
    }

    lines.push(`  ${entityId} {`);
    const seenAttrs = new Set<string>();
    for (const attr of entity.attributes) {
      let attrName = sanitizeMermaidIdentifier(attr.name, "field");
      if (seenAttrs.has(attrName)) {
        attrName = `${attrName}_${seenAttrs.size + 1}`;
      }
      seenAttrs.add(attrName);
      const attrType = sanitizeErAttributeType(attr.type);
      const commentParts: string[] = [];
      if (attr.required) {
        commentParts.push("required");
      }
      if (attrType !== attr.type.trim()) {
        commentParts.push(sanitizeMermaidLabel(attr.type));
      }
      if (attr.notes) {
        commentParts.push(sanitizeMermaidLabel(attr.notes));
      }
      const commentSuffix =
        commentParts.length > 0 ? ` "${sanitizeMermaidLabel(commentParts.join(" - "))}"` : "";
      lines.push(`    ${attrType} ${attrName}${commentSuffix}`);
    }
    lines.push("  }");
  }

  for (const entity of entities) {
    const fromId = entityIds.get(entity.name.trim().toLowerCase()) ?? "Entity";
    for (const rel of entity.relations) {
      const targetKey = rel.to.trim().toLowerCase();
      const toId = entityIds.get(targetKey) ?? sanitizeMermaidIdentifier(rel.to, "Target");
      const operator = mapRelationToErOperator(rel.kind);
      lines.push(`  ${fromId} ${operator} ${toId} : "${rel.kind}"`);
    }
  }

  return lines.join("\n");
}

/**
 * Gera bloco Mermaid `stateDiagram-v2` válido a partir de `StateMachineSpec` (`docs/05` §6).
 */
export function generateStateMachineMermaid(sm: StateMachineSpec): string {
  const lines: string[] = ["stateDiagram-v2"];
  const stateIdByRaw = new Map<string, string>();
  const usedIds = new Set<string>();

  const registerState = (rawState: string): string => {
    const trimmed = rawState.trim();
    const key = trimmed.toLowerCase();
    const existing = stateIdByRaw.get(key);
    if (existing !== undefined) {
      return existing;
    }
    let candidate = sanitizeMermaidIdentifier(trimmed, "state");
    while (usedIds.has(candidate)) {
      candidate = `${candidate}_${usedIds.size + 1}`;
    }
    usedIds.add(candidate);
    stateIdByRaw.set(key, candidate);
    if (candidate !== trimmed) {
      lines.push(`  state "${sanitizeMermaidLabel(trimmed, candidate)}" as ${candidate}`);
    } else if (sm.transitions.length === 0) {
      lines.push(`  state "${candidate}" as ${candidate}`);
    }
    return candidate;
  };

  for (const st of sm.states) {
    registerState(st);
  }
  if (sm.initialState !== undefined) {
    const initId = registerState(sm.initialState);
    lines.push(`  [*] --> ${initId}`);
  } else if (sm.states.length > 0 && sm.transitions.length === 0) {
    const firstId = registerState(sm.states[0] ?? "initial");
    lines.push(`  [*] --> ${firstId}`);
  }

  for (const tr of sm.transitions) {
    const fromId = registerState(tr.from);
    const toId = registerState(tr.to);
    const triggerText = sanitizeMermaidLabel(tr.trigger, "transicao");
    const guardText = tr.guard ? ` (${sanitizeMermaidLabel(tr.guard)})` : "";
    lines.push(`  ${fromId} --> ${toId} : ${triggerText}${guardText}`);
  }

  for (const term of sm.terminalStates ?? []) {
    const termId = registerState(term);
    lines.push(`  ${termId} --> [*]`);
  }

  if (lines.length === 1) {
    lines.push("  [*] --> idle");
  }

  return lines.join("\n");
}

/**
 * Gera bloco Mermaid `sequenceDiagram` válido a partir de `FlowSpec` (`docs/05` §6).
 */
export function generateFlowSequenceMermaid(flow: FlowSpec): string {
  const lines: string[] = ["sequenceDiagram"];
  const participantAliasByActor = new Map<string, string>();
  const usedAliases = new Set<string>(["System"]);

  const getActorAlias = (actorName: string): string => {
    const clean = actorName.trim() || "Usuario";
    const key = clean.toLowerCase();
    const existing = participantAliasByActor.get(key);
    if (existing !== undefined) {
      return existing;
    }
    let alias = sanitizeMermaidIdentifier(clean, "Actor");
    while (usedAliases.has(alias)) {
      alias = `${alias}_${usedAliases.size + 1}`;
    }
    usedAliases.add(alias);
    participantAliasByActor.set(key, alias);
    return alias;
  };

  const sortedSteps = [...flow.steps].sort((a, b) => a.order - b.order);
  for (const step of sortedSteps) {
    getActorAlias(step.actor);
  }

  if (participantAliasByActor.size === 0) {
    getActorAlias("Usuario");
  }

  for (const [key, alias] of participantAliasByActor.entries()) {
    const originalActor =
      sortedSteps.find((s) => (s.actor.trim() || "Usuario").toLowerCase() === key)?.actor.trim() ??
      "Usuario";
    lines.push(`  participant ${alias} as ${sanitizeMermaidLabel(originalActor, alias)}`);
  }
  lines.push("  participant System as Aplicacao");

  if (sortedSteps.length === 0) {
    const firstAlias = [...participantAliasByActor.values()][0] ?? "Usuario";
    lines.push(`  ${firstAlias}->>System: ${sanitizeMermaidLabel(flow.description, flow.name)}`);
    lines.push(`  System-->>${firstAlias}: Fluxo concluido`);
    return lines.join("\n");
  }

  for (const step of sortedSteps) {
    const alias = getActorAlias(step.actor);
    lines.push(`  ${alias}->>System: ${sanitizeMermaidLabel(step.action, "acao")}`);
    lines.push(`  System-->>${alias}: ${sanitizeMermaidLabel(step.outcome, "resultado")}`);
  }

  return lines.join("\n");
}

/**
 * Extrai todos os blocos ```mermaid ... ``` de um documento Markdown, sinalizando fences não fechadas.
 */
export function extractMermaidBlocks(markdown: string): {
  blocks: string[];
  unclosedFence: boolean;
} {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let inMermaid = false;
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inMermaid) {
      if (/^```mermaid(?:\s|$)/i.test(trimmed)) {
        inMermaid = true;
        current = [];
      }
    } else if (/^```(?:\s*$)/.test(trimmed)) {
      blocks.push(current.join("\n"));
      inMermaid = false;
      current = [];
    } else {
      current.push(line);
    }
  }

  return { blocks, unclosedFence: inMermaid };
}

function validateErDiagram(lines: readonly string[]): string[] {
  const errors: string[] = [];
  let braceDepth = 0;
  let bodyItems = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (braceDepth > 0) {
      if (line === "}") {
        braceDepth -= 1;
        continue;
      }
      if (line.includes("{") || line.includes("}")) {
        errors.push(`erDiagram linha ${i + 2}: chave inesperada dentro de entidade ("${line}").`);
        continue;
      }
      if (!ER_ATTRIBUTE_REGEX.test(line)) {
        errors.push(`erDiagram linha ${i + 2}: atributo inválido ("${line}").`);
      }
      continue;
    }

    if (line === "}") {
      errors.push(`erDiagram linha ${i + 2}: "}" sem bloco de entidade aberto.`);
      continue;
    }
    if (/^direction\s+(?:TB|BT|LR|RL)$/i.test(line)) {
      continue;
    }
    if (ER_ENTITY_OPEN_REGEX.test(line)) {
      braceDepth += 1;
      bodyItems += 1;
      continue;
    }
    const relMatch = ER_RELATION_LINE_REGEX.exec(line);
    if (relMatch !== null) {
      const operator = relMatch[2] ?? "";
      if (!ER_RELATION_OPERATOR_REGEX.test(operator)) {
        errors.push(
          `erDiagram linha ${i + 2}: operador de cardinalidade inválido ("${operator}").`,
        );
      }
      bodyItems += 1;
      continue;
    }
    if (ER_STANDALONE_ENTITY_REGEX.test(line)) {
      bodyItems += 1;
      continue;
    }
    errors.push(`erDiagram linha ${i + 2}: instrução inválida ("${line}").`);
  }

  if (braceDepth !== 0) {
    errors.push("erDiagram: bloco de entidade '{' não foi fechado com '}'.");
  }
  if (bodyItems === 0) {
    errors.push("erDiagram: diagrama vazio (nenhuma entidade ou relacionamento).");
  }
  return errors;
}

function validateStateDiagram(lines: readonly string[]): string[] {
  const errors: string[] = [];
  let braceDepth = 0;
  let bodyItems = 0;
  let inNote = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (inNote) {
      if (/^end\s+note$/i.test(line)) {
        inNote = false;
      }
      continue;
    }
    if (/^note\s+(?:left|right)\s+of\b/i.test(line)) {
      if (!line.includes(":")) {
        inNote = true;
      }
      continue;
    }
    if (line === "}") {
      if (braceDepth === 0) {
        errors.push(`stateDiagram linha ${i + 2}: "}" sem bloco composto aberto.`);
      } else {
        braceDepth -= 1;
      }
      continue;
    }
    if (line === "--") {
      continue;
    }
    if (/^direction\s+(?:TB|BT|LR|RL)$/i.test(line)) {
      continue;
    }
    if (/^(?:classDef|class)\s+\S+/.test(line)) {
      continue;
    }
    if (STATE_COMPOSITE_OPEN_REGEX.test(line)) {
      braceDepth += 1;
      bodyItems += 1;
      continue;
    }
    if (STATE_ALIAS_REGEX.test(line) || STATE_STEREOTYPE_REGEX.test(line)) {
      bodyItems += 1;
      continue;
    }
    if (STATE_TRANSITION_REGEX.test(line)) {
      bodyItems += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*\S.*$/.test(line)) {
      bodyItems += 1;
      continue;
    }
    errors.push(`stateDiagram linha ${i + 2}: instrução inválida ("${line}").`);
  }

  if (inNote) {
    errors.push("stateDiagram: bloco 'note' não foi fechado com 'end note'.");
  }
  if (braceDepth !== 0) {
    errors.push("stateDiagram: estado composto '{' não foi fechado com '}'.");
  }
  if (bodyItems === 0) {
    errors.push("stateDiagram: diagrama vazio (nenhum estado ou transição).");
  }
  return errors;
}

function validateSequenceDiagram(lines: readonly string[]): string[] {
  const errors: string[] = [];
  let blockDepth = 0;
  let bodyItems = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^(?:autonumber|title\s+\S.*)$/i.test(line)) {
      continue;
    }
    if (
      /^(?:activate|deactivate|destroy|create)\s+[A-Za-z_][A-Za-z0-9_-]*(?:\s+.*)?$/i.test(line)
    ) {
      continue;
    }
    if (/^Note\s+(?:left of|right of|over)\s+.+:\s*\S.*$/i.test(line)) {
      bodyItems += 1;
      continue;
    }
    if (/^box\b/i.test(line)) {
      blockDepth += 1;
      continue;
    }
    if (SEQ_BLOCK_OPEN_REGEX.test(line)) {
      blockDepth += 1;
      continue;
    }
    if (/^(?:else|and|option)\b/i.test(line)) {
      if (blockDepth === 0) {
        errors.push(`sequenceDiagram linha ${i + 2}: "${line}" fora de bloco alt/par/opt.`);
      }
      continue;
    }
    if (/^end$/i.test(line)) {
      if (blockDepth === 0) {
        errors.push(`sequenceDiagram linha ${i + 2}: "end" sem bloco aberto.`);
      } else {
        blockDepth -= 1;
      }
      continue;
    }
    if (SEQ_PARTICIPANT_REGEX.test(line)) {
      bodyItems += 1;
      continue;
    }
    if (SEQ_MESSAGE_REGEX.test(line)) {
      bodyItems += 1;
      continue;
    }
    errors.push(`sequenceDiagram linha ${i + 2}: instrução inválida ("${line}").`);
  }

  if (blockDepth !== 0) {
    errors.push("sequenceDiagram: bloco (loop/alt/opt/par/box) não foi fechado com 'end'.");
  }
  if (bodyItems === 0) {
    errors.push("sequenceDiagram: diagrama vazio (nenhum participante ou mensagem).");
  }
  return errors;
}

/**
 * Parser/validador sintático leve de blocos Mermaid (`erDiagram`, `stateDiagram-v2`,
 * `sequenceDiagram`, `flowchart`/`graph`) conforme `docs/05` §7.
 */
export function validateMermaidSyntax(diagram: string): MermaidValidationResult {
  const meaningfulLines = diagram
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));

  if (meaningfulLines.length === 0) {
    return { valid: false, errors: ["Bloco Mermaid vazio."] };
  }

  const header = meaningfulLines[0] ?? "";
  const body = meaningfulLines.slice(1);

  if (header === "erDiagram") {
    const errors = validateErDiagram(body);
    return { valid: errors.length === 0, kind: "erDiagram", errors };
  }
  if (header === "stateDiagram-v2" || header === "stateDiagram") {
    const errors = validateStateDiagram(body);
    return { valid: errors.length === 0, kind: header, errors };
  }
  if (header === "sequenceDiagram") {
    const errors = validateSequenceDiagram(body);
    return { valid: errors.length === 0, kind: "sequenceDiagram", errors };
  }
  if (/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)$/i.test(header)) {
    const kind = header.toLowerCase().startsWith("flowchart") ? "flowchart" : "graph";
    if (body.length === 0) {
      return { valid: false, kind, errors: [`${kind}: diagrama sem nós ou arestas.`] };
    }
    return { valid: true, kind, errors: [] };
  }

  return {
    valid: false,
    errors: [`Cabeçalho Mermaid não suportado ou inválido: "${header}".`],
  };
}

/**
 * Extrai e valida sintaticamente todos os blocos ` ```mermaid ` de um relatório Markdown.
 */
export function validateMarkdownMermaidBlocks(markdown: string): MarkdownMermaidCheckResult {
  const { blocks, unclosedFence } = extractMermaidBlocks(markdown);
  const errors: string[] = [];

  if (unclosedFence) {
    errors.push("Bloco ```mermaid aberto sem fechamento ```.");
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i] ?? "";
    const check = validateMermaidSyntax(block);
    if (!check.valid) {
      for (const err of check.errors) {
        errors.push(`Bloco Mermaid #${i + 1}: ${err}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    blockCount: blocks.length,
    errors,
  };
}
