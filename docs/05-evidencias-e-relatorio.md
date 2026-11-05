# 05 - Evidências, achados e relatório

## 1. Princípio

**Evidência ou não aconteceu.** O relatório é uma *view* sobre dados estruturados (`Evidence` -> `Finding` -> `BusinessRule`). Toda afirmação do relatório é rastreável até um artefato observado.

## 2. Tipos (em `packages/core/src/types`)

```ts
export type EvidenceKind =
  | "http_response" | "robots" | "tech_signature"
  | "screenshot" | "dom_snapshot" | "a11y_snapshot"
  | "state" | "transition"
  | "form_schema" | "form_probe"
  | "network_call"
  | "doc_section" | "pricing_plan"
  | "bundle_route" | "bundle_string" | "feature_flag"
  | "email_received"          // fase 2
  | "validation_run";         // fase 3

export interface Evidence {
  id: string;               // "ev_" + ulid
  jobId: string;
  kind: EvidenceKind;
  phase: PhaseId;
  sha256: string;           // hash do conteúdo canônico (dedup)
  blobPath?: string;        // relativo ao diretório do job
  url?: string;
  stateId?: string;
  summary: string;          // <= 300 chars, legível, usado no prompt do LLM
  data: Record<string, unknown>; // payload estruturado específico do kind
  createdAt: string;        // ISO
}

export type Confidence = "observed" | "inferred" | "hypothesis";

export interface Finding {
  id: string;               // "fd_" + ulid
  jobId: string;
  module: string;
  category: "feature" | "validation" | "permission" | "limit" | "state" | "integration" | "pricing" | "ux";
  statement: string;        // afirmação atômica, comportamental, sem código
  confidence: Confidence;
  evidenceIds: string[];    // >= 1, obrigatório
  fingerprint: string;      // para dedup
}

export interface BusinessRule {
  id: string;               // "BR-001"
  module: string;
  title: string;
  trigger: string;          // quando
  condition: string;        // se
  effect: string;           // então
  confidence: Confidence;
  findingIds: string[];
  evidenceIds: string[];
  validation?: { status: "confirmed" | "contradicted" | "inconclusive"; runEvidenceId: string };
}

export interface DomainEntity {
  name: string;
  attributes: { name: string; type: string; required: boolean; notes?: string; evidenceIds: string[] }[];
  relations: { to: string; kind: "1-1" | "1-n" | "n-n"; evidenceIds: string[] }[];
}
```

## 3. Schema SQLite

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error TEXT, llm_tokens_in INTEGER DEFAULT 0, llm_tokens_out INTEGER DEFAULT 0
);
CREATE TABLE phases (
  job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL,
  status TEXT NOT NULL, checkpoint_json TEXT, started_at TEXT, finished_at TEXT, stats_json TEXT,
  PRIMARY KEY (job_id, phase)
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
  phase TEXT NOT NULL, sha256 TEXT NOT NULL, blob_path TEXT, url TEXT, state_id TEXT,
  summary TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (job_id, kind, sha256)
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, module TEXT NOT NULL, category TEXT NOT NULL,
  statement TEXT NOT NULL, confidence TEXT NOT NULL, fingerprint TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL, UNIQUE (job_id, fingerprint)
);
CREATE TABLE rules (
  job_id TEXT NOT NULL, id TEXT NOT NULL, module TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY (job_id, id)
);
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  message TEXT NOT NULL, live_url TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, ts TEXT NOT NULL,
  phase TEXT, type TEXT NOT NULL, data_json TEXT
);
CREATE INDEX idx_evidence_job_kind ON evidence(job_id, kind);
CREATE INDEX idx_events_job ON events(job_id, id);
```

Migrações: arquivos SQL numerados em `packages/core/migrations/NNN_name.sql`, aplicados na inicialização, versão em `PRAGMA user_version`.

## 4. Regras de confiança

| Situação | Confiança |
|---|---|
| Mensagem de validação vista após probe; resposta HTTP observada; elemento visível | `observed` |
| Deduzido combinando evidências (ex.: enum de status na API + botão que só aparece em um status) | `inferred` |
| Só em string de bundle ou doc, sem observação na UI/rede | `hypothesis` |
| Validator confirmou | sobe para `observed` |
| Validator contradisse | vai para seção "Lacunas e contradições", nunca é apagado |

## 5. Prompting do synthesizer

- Prompt de sistema fixo em `packages/synthesizer/prompts/system.md`, contendo:
  - Contexto do manifesto (ownership, basis, goals).
  - Instrução clean room: descrever comportamento; **proibido** reproduzir código, CSS, textos longos (> 20 palavras literais) ou nomes internos de variáveis.
  - Instrução de evidência: cada item precisa citar `evidenceIds` recebidos; não inventar ids.
  - Formato JSON estrito (schema zod convertido com `zod-to-json-schema`).
- Entrada: evidências serializadas por `summary` + campos-chave de `data`, nunca blobs.
- Pós-processamento: validar ids citados existem; descartar itens sem suporte; registrar taxa de descarte em `events` (alerta se > 20%).

## 6. Estrutura do relatório

Template completo em [templates/report-template.md](templates/report-template.md). Seções:

1. Sumário executivo (o que o produto faz, em 5 linhas; maiores achados; cobertura)
2. Visão do produto (proposta, personas, planos e limites)
3. Mapa funcional (módulos -> funcionalidades, com screenshots)
4. Modelo de domínio (diagrama ER mermaid + tabela)
5. Catálogo de regras de negócio (`BR-NNN`)
6. Máquinas de estado (mermaid `stateDiagram-v2`)
7. Fluxos principais (mermaid `sequenceDiagram`)
8. Contrato de API inferido (resumo + link para `openapi.yaml`)
9. Papéis e permissões (matriz)
10. Validações e mensagens (campo x regra x mensagem resumida)
11. Integrações externas detectadas
12. Critérios de aceite (links para `.feature`)
13. Lacunas, hipóteses e contradições
14. Apêndice: cobertura (páginas visitadas, limites atingidos), metodologia e manifesto resumido

## 7. Critérios de qualidade do relatório (checados por teste)

- Nenhuma regra sem `evidenceIds`.
- Nenhum bloco de código copiado do alvo (heurística: nenhum trecho do relatório com ≥ 120 caracteres consecutivos idêntico a um blob de `bundle_string`/`dom_snapshot`/`doc_section`).
- Todo screenshot referenciado existe em `report/assets/`.
- Mermaid válido (validar com `@mermaid-js/mermaid-cli` no CI ou parser leve).
