## Story

<!-- ex.: F1-04 Explorer: crawler, fingerprint de estado e state graph. ID da issue no Paperclip (ex.: APE-43 — NUNCA incluir IPs/URLs internas do homelab). -->

## Contexto / thinking path

<!-- Por que esta mudança, como se encaixa na arquitetura (docs/02) e no pipeline (docs/04). -->

## O que mudou

-

## Como verificar

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

<!-- Passos extras: E2E com Browserless (CLEANROOM_BROWSER_WS_ENDPOINT), comando da CLI, output esperado. -->

## Critérios de aceite da story

- [ ]

## Riscos

<!-- O que pode quebrar. Toca ScopeGuard, classificação de ações destrutivas, sanitização de HAR, handoff ou contas (docs/10 §6)? Se sim, exige revisão explícita do Sentinel com comentário "security-reviewed". -->

## Modelo de IA usado

<!-- provedor, modelo, ou "Nenhum: autoria humana" -->

## Checklist (AGENTS.md §10 & docs/10 §6)

- [ ] Critérios de aceite da story atendidos e demonstrados no PR
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` passando
- [ ] Sem segredos, IPs internos ou tokens (`gitleaks` verde)
- [ ] Sem código, CSS, assets ou conteúdo copiado de terceiros (metodologia *clean room*)
- [ ] Docs atualizados quando comportamento ou contrato mudar
- [ ] Checkbox da story marcado em `docs/11-roadmap-e-backlog.md`
- [ ] Se tocar `ScopeGuard`, classificação de ações destrutivas, sanitização de HAR, handoff ou contas: revisão explícita `"security-reviewed"` do Sentinel (`docs/10` §6)
