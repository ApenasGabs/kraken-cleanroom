# 01 - Visão e escopo

## 1. Problema

Queremos acoplar em aplicações próprias funcionalidades que já existem em outros produtos. Hoje isso exige horas de exploração manual, anotações soltas e muito "achismo" sobre regras de negócio. Pedir para uma IA "olhar o site" gera respostas rasas e sem evidência.

## 2. Solução

Um pipeline autônomo que, dado um **manifesto de autorização**, explora o alvo de forma sistemática, **coleta evidências**, infere regras de negócio, **re-testa** o que inferiu e entrega uma especificação reimplementável.

## 3. Usuários

| Persona | Uso |
|---|---|
| Gabriel (dono do homelab) | Dispara análises pelo KrakenBridge-Web ou CLI, resolve handoffs, lê relatórios |
| Pai do Kraken (agente Paperclip) | Orquestra jobs, faz gap analysis com repos próprios, quebra backlog |
| Kraken Forge (agente) | Implementa features a partir **apenas** do relatório (sala limpa) |
| Kraken Sentinel (agente) | Valida regras inferidas e revisa PRs deste repo |

## 4. Escopo por tipo de alvo

| Tipo | Métodos | Fase |
|---|---|---|
| Web pública sem login | UI comportamental, HAR, docs, bundles | **MVP (Fase 1)** |
| Web com cadastro (conta própria) | + contas de teste, inbox, handoff | Fase 2 |
| Repositório próprio | Análise de código-fonte (não precisa clean room interno) | Fase 4 |
| App próprio mobile/desktop | REA (análise de binário) - **só `ownership: own`** | Fora do MVP |

## 5. Fora de escopo (explícito)

- Burlar login, paywall, CAPTCHA, rate limit, anti-bot ou termos de uso
- Copiar código, design system, assets ou textos do alvo
- Análise de binários de terceiros
- Testes de segurança/pentest do alvo
- Scraping em massa de dados de usuários do alvo
- Criação de múltiplas contas falsas

## 6. Métricas de sucesso

| Métrica | Meta MVP |
|---|---|
| Cobertura de telas alcançáveis sem login | ≥ 80% das rotas descobertas pelo crawl visitadas |
| Regras com evidência vinculada | 100% (regra sem evidência é bug) |
| Regras `observed` re-testadas com sucesso (Fase 3) | ≥ 90% |
| Tempo de um job MVP em site médio (~50 telas) | ≤ 45 min |
| Relatório utilizável pelo Forge sem consultar o alvo | Validado manualmente em 2 alvos piloto |

## 7. Exemplo de uso ponta a ponta

1. `cleanroom init https://demo.playwright.dev/todomvc` gera `cleanroom.yaml` preenchido com defaults seguros.
2. Usuário revisa/edita e roda `cleanroom run cleanroom.yaml`.
3. Pipeline explora, captura, analisa, sintetiza, valida.
4. Saída em `jobs/<jobId>/report/report.md` + `evidence/` + `openapi.yaml` + `features/*.feature`.
5. Via Paperclip, o relatório é anexado à issue e o Pai do Kraken gera backlog de acoplamento.
