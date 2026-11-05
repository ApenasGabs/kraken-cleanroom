# 09 - Padrões de engenharia

## 1. TypeScript

- `tsconfig.base.json` na raiz: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: "NodeNext"`, `target: "ES2023"`, `verbatimModuleSyntax`.
- Cada pacote estende a base; `composite: true` com project references para `tsc -b`.
- Proibido `any` explícito (Biome `noExplicitAny: error`). Use `unknown` + zod.
- Erros: classes que estendem `CleanroomError` com `code` estável (`MANIFEST_INVALID`, `METHOD_NOT_ALLOWED`, `OUT_OF_SCOPE`, `BROWSER_UNAVAILABLE`, `LLM_INVALID_OUTPUT`, `JOB_NOT_FOUND`...).
- Sem estado global mutável; dependências injetadas via `PhaseContext`/fábricas.

## 2. Estilo e ferramentas

- Biome para lint e formatação (2 espaços, aspas duplas, ponto e vírgula, largura 100).
- Nomes: arquivos `kebab-case.ts`; tipos `PascalCase`; funções `camelCase`.
- Imports internos entre pacotes por nome (`@cleanroom/core`), nunca caminho relativo cruzando pacote.
- Um arquivo de barril `src/index.ts` por pacote exportando só a API pública.

## 3. Testes

| Tipo | Onde | Ferramenta | Roda no CI |
|---|---|---|---|
| Unitário | `packages/*/src/**/*.test.ts` | Vitest | sim |
| Integração (sem browser) | `packages/*/test/` | Vitest + fixtures HAR/HTML em `fixtures/` | sim |
| E2E explorer | `packages/explorer/test/e2e/` | Vitest + `fixtures/demo-app` + Browserless | só com `CLEANROOM_BROWSER_WS_ENDPOINT` definido (`describe.skipIf`) |
| Golden do relatório | `packages/synthesizer/test/golden/` | snapshot de `report.md` gerado de evidências fixas com `LlmClient` fake | sim |

- `LlmClient` tem implementação `FakeLlmClient` determinística para testes (respostas gravadas em fixtures JSON).
- Cobertura mínima de linhas: 80% em `core` e `analyzers`.
- `fixtures/demo-app`: app estática + mini API (Hono) **criada por nós** com telas, formulário com validações conhecidas, lista paginada, enum de status e uma página de pricing. É o alvo de referência: os testes afirmam que o pipeline descobre exatamente as regras que plantamos (ver `fixtures/demo-app/EXPECTED.md`).

## 4. Git e PRs

- Branch: `feat/<story-id>-<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
- Conventional Commits: `feat(explorer): capture HAR per job`.
- PR usa `.github/pull_request_template.md`: contexto, story, o que mudou, como verificar, riscos, modelo de IA usado, checklist.
- `main` protegida: merge só com CI verde e 1 review (Sentinel ou humano). Squash merge.

## 5. CI (GitHub Actions)

`.github/workflows/ci.yml` (story F0-02):
- Node 22, pnpm com cache.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Job `secrets-scan` com `gitleaks`.
- E2E com browser **não** roda no CI público (sem acesso ao homelab).

## 6. Logging

- `pino` com `redact: ["*.password", "*.token", "*.authorization", "*.cookie", "headers.cookie", "headers.authorization"]` e função que remove `token=` de URLs.
- Nível default `info`; `CLEANROOM_LOG_LEVEL` sobrescreve.

## 7. Dependências

- Antes de adicionar dependência: verificar manutenção (commit < 12 meses), licença permissiva (MIT/Apache/BSD/ISC) e tamanho. Justificar no PR.
- Proibidas: bibliotecas de evasão anti-bot (`puppeteer-extra-plugin-stealth` e similares), solvers de CAPTCHA.
