# 07 - MCP, CLI e API REST

Os três expõem o **mesmo** núcleo (`@cleanroom/core` `JobService`). Nenhuma lógica de negócio fica em `cli` ou `mcp-server`: eles só fazem parsing e formatação.

## 1. `JobService` (contrato interno)

```ts
interface JobService {
  validateManifest(yaml: string): Promise<{ ok: true; manifest: Manifest } | { ok: false; issues: ManifestIssue[] }>;
  initManifest(url: string, overrides?: Partial<Manifest>): Promise<string>; // retorna YAML com defaults seguros
  start(manifestYaml: string): Promise<{ jobId: string }>;
  status(jobId: string): Promise<JobStatus>;
  list(filter?: { state?: JobState; limit?: number }): Promise<JobSummary[]>;
  cancel(jobId: string, reason?: string): Promise<void>;
  resume(jobId: string): Promise<void>;
  resolveHandoff(jobId: string, handoffId: string, note?: string): Promise<void>;
  getReport(jobId: string, format: "markdown" | "json"): Promise<string>;
  listEvidence(jobId: string, filter?: { kind?: EvidenceKind; limit?: number; cursor?: string }): Promise<Page<Evidence>>;
  getEvidence(jobId: string, evidenceId: string): Promise<Evidence & { blobUrl?: string }>;
  listRules(jobId: string, filter?: { module?: string; confidence?: Confidence }): Promise<BusinessRule[]>;
}

interface JobStatus {
  jobId: string; state: JobState; currentPhase?: PhaseId;
  phases: { id: PhaseId; status: "pending" | "running" | "done" | "skipped" | "failed"; stats?: Record<string, number> }[];
  counters: { pages: number; evidence: number; findings: number; rules: number };
  pendingHandoff?: { id: string; kind: string; message: string; liveUrl?: string };
  llm: { tokensIn: number; tokensOut: number };
  startedAt: string; updatedAt: string; error?: string;
}
```

## 2. Ferramentas MCP

Servidor: `@cleanroom/mcp-server`, nome `kraken-cleanroom`, transportes **stdio** (dev/Antigravity) e **Streamable HTTP** em `/mcp` (serviço no Dell). Todos os inputs validados por zod.

| Ferramenta | Input | Output | Notas |
|---|---|---|---|
| `cleanroom_init_manifest` | `{ url, ownership?, goals? }` | `{ yaml }` | Não inicia job |
| `cleanroom_validate_manifest` | `{ yaml }` | `{ ok, issues[] }` | |
| `cleanroom_start_job` | `{ yaml }` | `{ jobId }` | Recusa manifesto inválido |
| `cleanroom_status` | `{ jobId }` | `JobStatus` | |
| `cleanroom_list_jobs` | `{ state?, limit? }` | `JobSummary[]` | |
| `cleanroom_cancel_job` | `{ jobId, reason? }` | `{ ok }` | |
| `cleanroom_resume_job` | `{ jobId }` | `{ ok }` | |
| `cleanroom_handoff_resolve` | `{ jobId, handoffId, note? }` | `{ ok }` | |
| `cleanroom_get_report` | `{ jobId, format }` | `{ content }` | Markdown pode ser grande: truncar em 200 KB com aviso e indicar REST |
| `cleanroom_list_rules` | `{ jobId, module?, confidence? }` | `BusinessRule[]` | |
| `cleanroom_list_evidence` | `{ jobId, kind?, limit?, cursor? }` | `Page<Evidence>` | Sem blobs |
| `cleanroom_get_evidence` | `{ jobId, evidenceId }` | `Evidence` | Screenshot retornado como `image` content (PNG, máx. 1 MB) |

Descrições das ferramentas devem deixar claro o propósito clean room e que o job só roda com manifesto válido.

## 3. CLI `cleanroom`

```
cleanroom init <url> [-o cleanroom.yaml] [--ownership own|third-party|client-authorized]
cleanroom validate <manifest>
cleanroom run <manifest> [--phases intake,explore,...] [--detach]
cleanroom status <jobId> [--json] [--watch]
cleanroom list [--state running] [--json]
cleanroom resume <jobId>
cleanroom cancel <jobId> [--reason "..."]
cleanroom handoff resolve <jobId> <handoffId> [--note "..."]
cleanroom report <jobId> [--format md|json] [--open]
cleanroom evidence <jobId> [--kind screenshot] [--limit 20]
cleanroom serve [--mcp-stdio | --http --port 4870]
```

- `run` sem `--detach` mostra progresso por fase (barra simples + contadores) e retorna código 0 em `completed`, 2 em `awaiting_human`, 3 em `blocked`, 1 em erro.
- `--json` em todos os comandos de leitura para consumo por agentes.

## 4. API REST (Fase 2)

Base `/v1`, JSON, auth por header `Authorization: Bearer ${CLEANROOM_API_TOKEN}` (exceto `/v1/inbox/messages`, que usa HMAC).

| Método | Rota | Equivalente |
|---|---|---|
| POST | `/v1/manifests/validate` | validateManifest |
| POST | `/v1/jobs` | start |
| GET | `/v1/jobs` | list |
| GET | `/v1/jobs/:id` | status |
| POST | `/v1/jobs/:id/cancel` | cancel |
| POST | `/v1/jobs/:id/resume` | resume |
| POST | `/v1/jobs/:id/handoffs/:hid/resolve` | resolveHandoff |
| GET | `/v1/jobs/:id/report?format=md\|json` | getReport |
| GET | `/v1/jobs/:id/rules` | listRules |
| GET | `/v1/jobs/:id/evidence` | listEvidence |
| GET | `/v1/jobs/:id/evidence/:eid/blob` | blob (screenshot/HAR sanitizado) |
| GET | `/v1/jobs/:id/events` (SSE) | stream de progresso |
| POST | `/v1/inbox/messages` | ingestão do Email Worker |
| GET | `/health` | healthcheck |

Framework: **Hono** em `@hono/node-server` (leve e tipado). Erros no formato `{ error: { code, message, details? } }` com status 400/401/403/404/409/422/500.
