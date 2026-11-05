# 04 - Pipeline e fases

Cada fase é um módulo com contrato fixo:

```ts
export interface Phase {
  id: PhaseId; // "intake" | "explore" | "capture" | "analyze" | "synthesize" | "validate" | "report"
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

export interface PhaseContext {
  job: JobRecord;
  manifest: Manifest;
  guard: ScopeGuard;
  evidence: EvidenceStore;
  llm: LlmClient;
  browser?: BrowserSession;  // fornecido pelo runner para fases que precisam
  log: Logger;
  signal: AbortSignal;        // timeout global / cancelamento
  emit(event: JobEvent): void;
}

export type PhaseResult =
  | { status: "ok"; stats: Record<string, number> }
  | { status: "awaiting_human"; handoff: HandoffRequest }
  | { status: "blocked"; reason: string };
```

Regras para toda fase:

- **Idempotente**: rodar de novo não duplica evidências (dedup por hash) nem achados (dedup por `fingerprint`).
- **Retomável**: grava checkpoint em `phases.checkpoint` (JSON) a cada N itens.
- **Respeita `signal`**: aborta limpo.
- Toda ação no alvo passa por `guard`.

---

## Fase 1: `intake`

**Objetivo:** reconhecer o alvo e preparar o job.

| Entrada | Saída |
|---|---|
| manifesto | `target.type` refinado, `robots.txt`, `sitemap.xml`, tecnologias detectadas, URLs semente |

Passos:
1. `GET` da URL de entrada (fetch simples, sem browser). Registrar status, headers relevantes (sem cookies).
2. Buscar `/robots.txt` e sitemaps declarados; extrair URLs dentro de `allowedOrigins`.
3. Detectar SPA vs SSR (heurística: HTML com `<div id="root|app|__next">` vazio + bundles grandes = SPA).
4. Detectar tecnologias por assinaturas (Next.js `__NEXT_DATA__`, Nuxt `__NUXT__`, React, Vue, Angular, Flutter Web `flutter_bootstrap.js`). Registrar como evidência `kind: tech_signature`.
5. Montar fila de sementes: entrada + sitemap + `docsUrls`.

Critério de pronto: evidências `http_response`, `robots`, `tech_signature` persistidas; sementes no checkpoint.

## Fase 2: `explore`

**Objetivo:** descobrir o espaço de estados da UI.

| Entrada | Saída |
|---|---|
| sementes, guard | `graph/state-graph.json`, screenshots, snapshots DOM reduzidos |

### Algoritmo (BFS com prioridade)

1. Conectar via `chromium.connectOverCDP(CLEANROOM_BROWSER_WS_ENDPOINT)`; um `BrowserContext` por job com viewport desktop.
2. Para cada estado na fila:
   1. `guard.throttle()`; navegar ou repetir a sequência de ações que leva ao estado.
   2. Esperar `networkidle` (timeout 10s) + 500 ms de estabilização.
   3. Calcular **fingerprint do estado**: hash de (URL normalizada sem query de tracking) + (estrutura do DOM: árvore de tags/roles dos elementos interativos visíveis, sem texto). Estados com mesmo fingerprint são o mesmo nó.
   4. Se novo: screenshot nas viewports do manifesto, snapshot DOM reduzido (remover `<script>`, `<style>`, atributos `data-*` longos, texto acima de 200 caracteres truncado) e **árvore de acessibilidade** (`page.accessibility.snapshot()` ou `ariaSnapshot`).
   5. Extrair **ações candidatas**: links (`a[href]`), botões, `[role=button|tab|menuitem]`, inputs, selects. Classificar cada uma: `navigate`, `open-overlay`, `submit-form`, `toggle`, `destructive`, `external`.
   6. Enfileirar ações não destrutivas e dentro do escopo; prioridade: navegação principal (nav/header) > abas/menus > links de conteúdo > paginação (limitar a 2 páginas por lista).
3. Arestas do grafo: `{ from, to, action: { kind, selector, label } }`.
4. Parar em `maxPages`, `maxDepth` ou `maxDurationMin`.

### Classificação de destrutivo

Rótulo/aria/texto do botão ou action do form casando (case-insensitive, pt/en) com: `excluir|deletar|remover|apagar|cancelar assinatura|delete|remove|destroy|unsubscribe|sair|logout|sign out|publicar|publish|enviar convite|invite|pagar|pay|comprar|buy|checkout`. Na dúvida, tratar como destrutivo.

### Form probing (`limits.formSubmission`)

- `none`: só registra o formulário (campos, tipos, atributos `required`, `pattern`, `min/max`, `maxlength`).
- `validation-only` (default): para cada campo, testar uma bateria de valores inválidos (vazio, muito longo, formato errado, negativo, data passada) **um de cada vez**, disparar blur/submit e capturar mensagens de validação exibidas e respostas de rede 4xx. **Não** concluir uma submissão válida.
- `full`: permitido só com `ownership: own` ou conta de teste; submete dados sintéticos válidos.

Cada probe gera evidência `form_probe` com `{ field, input, observedMessage, httpStatus? }`.

## Fase 3: `capture`

**Objetivo:** gravar tráfego de rede e sanitizar.

- Habilitar HAR no contexto desde o início do `explore` (`recordHar` com `content: "embed"` para JSON, `omit` para binários).
- Ao final, **sanitizar** antes de persistir: remover headers `cookie`, `set-cookie`, `authorization`, `x-api-key`, `x-csrf-token`; mascarar valores de query/body cujo nome case com `token|secret|password|session|key|auth`; truncar bodies acima de 256 KB.
- Indexar requisições `fetch/xhr` como evidências `network_call` com `{ method, urlTemplate, status, reqShape, resShape }` (shape = esqueleto de tipos JSON, sem valores).

## Fase 4: `analyze`

Três analisadores independentes, rodando em paralelo:

### 4.1 `harToOpenApi`
- Agrupar chamadas por método + **template de path** (segmentos numéricos/UUID/hash viram `{id}`).
- Mesclar shapes de request/response por endpoint; inferir tipos, campos opcionais (ausentes em alguma amostra), enums (≤ 8 valores distintos de string curta).
- Gerar `analysis/openapi.yaml` (OpenAPI 3.1) com `x-cleanroom-evidence: [evidenceIds]` em cada operação.
- Detectar: esquema de auth (bearer/cookie), paginação (`page`, `cursor`, `offset`, `limit`), padrão de erro (`{error, message, code}`).

### 4.2 `docsHarvester`
- Para cada `docsUrls` e páginas de doc descobertas (`/help`, `/docs`, `/pricing`, `/terms`, `/changelog`), baixar, converter para markdown (Readability + turndown), segmentar por heading.
- Armazenar como evidência `doc_section`. **Não** copiar o texto para o relatório: o synthesizer só usa como fonte para resumir.
- Pricing: extrair tabela de planos (nome, preço, limites) como evidência estruturada `pricing_plan`.

### 4.3 `bundleAnalyzer`
- Listar scripts carregados (do HAR). Para cada bundle JS público:
  - Extrair **rotas** (padrões de router: `path: "/..."`, `createBrowserRouter`, `<Route path=`), **strings de UI e mensagens de erro** (literais com 3-200 caracteres, filtrando ruído), chaves i18n, **feature flags** (`flag`, `feature`, `isEnabled(`), endpoints literais (`/api/...`).
  - Se houver source map público referenciado, usar **apenas** para mapear nomes de módulos/rotas; não armazenar fontes.
- Persistir `analysis/strings.json` e evidências `bundle_route`, `bundle_string`, `feature_flag`. O bundle bruto **não** é armazenado.

## Fase 5: `synthesize`

**Objetivo:** transformar evidências em conhecimento estruturado. Detalhes em [05-evidencias-e-relatorio.md](05-evidencias-e-relatorio.md).

Pipeline interno (cada etapa = chamada LLM com saída validada por zod, com retry até 2x em caso de JSON inválido):

1. **Clusterização em módulos**: agrupar estados do grafo + endpoints + seções de doc em módulos funcionais (ex.: "Autenticação", "Projetos", "Faturamento").
2. **Achados por módulo**: para cada módulo, enviar evidências compactadas (no máximo ~30k tokens por chamada, paginando) e pedir `Finding[]`.
3. **Consolidação em regras**: deduplicar achados (embedding opcional ou fingerprint textual normalizado) e promover a `BusinessRule` com id `BR-NNN` estável (ordem: módulo, depois criação).
4. **Domínio**: inferir entidades/atributos/relacionamentos a partir de shapes de API + formulários + labels.
5. **Máquinas de estado**: a partir de enums de status em respostas + transições observadas.
6. **Gherkin**: gerar cenários a partir das regras `observed` e `inferred`.

Regra dura: **todo** `Finding` e `BusinessRule` gerado sem `evidenceIds` válidos é descartado e logado como `synthesis_unsupported_claim`.

## Fase 6: `validate` (Fase 3 do roadmap)

- Para cada regra com cenário testável (ex.: "campo X > 100 caracteres mostra erro Y"), gerar um **plano de verificação** declarativo (sequência de ações + asserção) e executá-lo via explorer, respeitando o guard.
- Resultado: `confirmed` (sobe para `observed`), `contradicted` (vai para lacunas, com evidência nova), `inconclusive`.

## Fase 7: `report`

- Renderizar [templates/report-template.md](templates/report-template.md) com dados estruturados (não pedir ao LLM para escrever o documento inteiro de uma vez).
- LLM escreve apenas trechos narrativos curtos (visão do produto, resumo de módulo) a partir dos dados.
- Copiar screenshots usados para `report/assets/`.
- Gerar `report/features/<modulo>.feature`.
- Gerar `report/index.json` (máquina) com o mesmo conteúdo estruturado, para consumo pelo Paperclip/KrakenBridge.
