# AGENTS.md - Guia obrigatório para agentes (Paperclip, Antigravity, Kraken) e humanos

Leia este arquivo **inteiro** antes de qualquer alteração neste repositório.

## 1. O que é este projeto

`kraken-cleanroom` é um serviço que **estuda uma aplicação alvo** (via UI, tráfego de rede da própria sessão, bundles JS públicos e documentação pública) e produz uma **especificação funcional limpa** com regras de negócio rastreáveis a evidências. O objetivo final é permitir reimplementar funcionalidades em outra aplicação sem copiar código (metodologia *clean room*).

## 2. Ordem de leitura obrigatória

1. [`docs/01-visao-e-escopo.md`](docs/01-visao-e-escopo.md)
2. [`docs/02-arquitetura.md`](docs/02-arquitetura.md)
3. [`docs/03-manifesto-cleanroom-yaml.md`](docs/03-manifesto-cleanroom-yaml.md)
4. [`docs/04-pipeline-e-fases.md`](docs/04-pipeline-e-fases.md)
5. [`docs/05-evidencias-e-relatorio.md`](docs/05-evidencias-e-relatorio.md)
6. [`docs/09-padroes-de-engenharia.md`](docs/09-padroes-de-engenharia.md)
7. [`docs/10-seguranca-e-etica.md`](docs/10-seguranca-e-etica.md)
8. [`docs/11-roadmap-e-backlog.md`](docs/11-roadmap-e-backlog.md) - **sua fonte de tarefas**

Os demais (`06`, `07`, `08`) são lidos quando a tarefa tocar contas/e-mail, MCP/CLI ou integrações/deploy.

## 3. Regras de ouro (violação = PR rejeitado)

1. **Nunca comitar segredos.** Repo é **público**. Tokens (Browserless, Paperclip, LLM, Cloudflare) só via variáveis de ambiente; documente em `.env.example` com placeholders. Não commitar IPs/tokens reais em testes ou fixtures.
2. **Clean room.** Nenhum código, CSS, imagem, ícone ou texto longo do alvo vai para o relatório ou para o repo. Fixtures de teste usam **apps de demonstração próprios ou sites de teste públicos** feitos para isso (ver §7).
3. **Manifesto primeiro.** Todo código que interage com um alvo deve receber um `Manifest` já validado e checar `methods.*` / `limits.*` antes de agir. Não existe "modo sem manifesto".
4. **Sem bypass de controles.** Proibido implementar resolução automática de CAPTCHA, evasão de anti-bot, fingerprint spoofing, rotação de proxies para driblar bloqueio, ou acesso a áreas fora do escopo. Bloqueios viram `HumanHandoff` ou `JobBlocked`.
5. **Escopo pequeno por PR.** Uma story do backlog por PR (ou menos). PRs > ~600 linhas de diff de código (excluindo lockfile/fixtures) devem ser quebrados.
6. **Teste junto.** Toda lógica pura (parsers, schema, síntese de evidência) tem teste unitário Vitest. Código de browser tem teste contra fixture local (servidor HTTP de demo dentro de `fixtures/`).
7. **Contratos tipados.** Tipos compartilhados vivem em `packages/core/src/types`. Não duplicar tipos entre pacotes.
8. **Não inventar escopo.** Se a story for ambígua, comente na issue do Paperclip pedindo esclarecimento ao **Pai do Kraken** em vez de supor.

## 4. Stack (decidida - não trocar sem ADR)

- Node.js **22 LTS**, TypeScript **5.x** com `strict: true`, ESM (`"type": "module"`)
- **pnpm** workspaces (monorepo)
- `zod` (schemas/validação), `yaml` (parse do manifesto)
- `playwright-core` (conexão CDP remota ao Browserless - **não** baixar browsers localmente)
- `@modelcontextprotocol/sdk` (servidor MCP)
- `better-sqlite3` (jobs/evidências) - arquivos grandes (screenshots, HAR) em disco, referenciados por hash
- `commander` (CLI), `pino` (logs JSON)
- Vitest (testes), Biome (lint + format), `tsup` (build)

Justificativa: o gargalo é I/O (browser remoto, LLM, rede, humano), não CPU. Detalhes em `docs/02-arquitetura.md` §6.

## 5. Layout do monorepo

```
packages/
  core/         manifest schema, tipos, job runner, evidence store, LLM client
  explorer/     Playwright/CDP: crawl, state graph, screenshots, HAR, form probing
  analyzers/    har-to-openapi, docs-harvester, bundle-analyzer
  synthesizer/  evidências → domínio/regras/relatório
  validator/    re-teste de regras inferidas
  mcp-server/   ferramentas cleanroom_*
  cli/          binário `cleanroom`
workers/
  email-inbox/  Cloudflare Email Worker (fase 2)
fixtures/
  demo-app/     app de demonstração própria para testes E2E do explorer
docs/
examples/
docker/
```

## 6. Comandos padrão (devem existir a partir da story F0-01)

```sh
pnpm install
pnpm build          # tsup em todos os pacotes
pnpm typecheck      # tsc --noEmit -r
pnpm lint           # biome check .
pnpm test           # vitest run
pnpm cleanroom --help
```

Antes de abrir PR rode **typecheck + lint + test + build**. Se algo não puder rodar (ex.: sem acesso ao Browserless no CI), diga explicitamente no PR.

## 7. Alvos permitidos para testes automatizados

- `fixtures/demo-app` (nossa app de demo, servida localmente nos testes)
- Sites públicos criados para prática de automação, ex.: `https://demo.playwright.dev/todomvc`, `https://the-internet.herokuapp.com` - respeitando rate limit de 1 req/s
- **Nunca** usar sites reais de terceiros em testes/CI.

## 8. Ambiente de execução (homelab)

- Browserless (Chrome remoto) roda no servidor Dell. URL via `CLEANROOM_BROWSER_WS_ENDPOINT` (inclui token - **não comitar**).
- O serviço final roda em container no mesmo Dell (ver `docs/08-integracoes-e-deploy.md`).
- **Não** rodar Chrome localmente na máquina `gabisa`.

## 9. Fluxo de trabalho no Paperclip

- **Pai do Kraken** refina o backlog (`docs/11`), cria sub-issues por story e delega.
- **Kraken Forge** implementa: branch `feat/<story-id>-<slug>` (ex.: `feat/F1-03-har-capture`), Conventional Commits, PR para `main` usando o template.
- **Kraken Sentinel** revisa PR, roda a suíte, valida contra os critérios de aceite da story e, quando houver UI/relatório, inspeciona o output.
- Comentários de code review (humanos e bots) devem ser endereçados ou justificados antes do merge.
- Ao terminar uma story: atualizar o checkbox em `docs/11-roadmap-e-backlog.md` no mesmo PR.

## 10. Definition of Done

- [ ] Critérios de aceite da story atendidos e demonstrados no PR
- [ ] typecheck, lint, test e build passando
- [ ] Sem segredos, sem conteúdo copiado de terceiros
- [ ] Docs atualizados quando comportamento/contrato mudar
- [ ] Checkbox da story marcado no roadmap
