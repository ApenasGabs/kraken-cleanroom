# Documentação - kraken-cleanroom

| # | Documento | Quando ler |
|---|---|---|
| 01 | [Visão e escopo](01-visao-e-escopo.md) | Sempre, primeiro |
| 02 | [Arquitetura](02-arquitetura.md) | Sempre |
| 03 | [Manifesto `cleanroom.yaml`](03-manifesto-cleanroom-yaml.md) | Sempre - é o contrato de autorização |
| 04 | [Pipeline e fases](04-pipeline-e-fases.md) | Ao implementar qualquer fase do job |
| 05 | [Evidências e relatório](05-evidencias-e-relatorio.md) | Ao tocar Evidence Store, synthesizer, validator |
| 06 | [Contas de teste e e-mail](06-contas-e-email.md) | Ao tocar login/cadastro/inbox/handoff |
| 07 | [MCP, CLI e API](07-mcp-cli-api.md) | Ao tocar `mcp-server` ou `cli` |
| 08 | [Integrações e deploy](08-integracoes-e-deploy.md) | Paperclip, KrakenBridge, Docker, Dell |
| 09 | [Padrões de engenharia](09-padroes-de-engenharia.md) | Sempre |
| 10 | [Segurança e ética](10-seguranca-e-etica.md) | Sempre |
| 11 | [Roadmap e backlog](11-roadmap-e-backlog.md) | Fonte das tarefas |
| - | [Template do relatório](templates/report-template.md) | Synthesizer |
| - | [Exemplo de manifesto](../examples/cleanroom.example.yaml) | Referência |

## Glossário

| Termo | Significado |
|---|---|
| **Alvo (target)** | Aplicação sendo estudada |
| **Job** | Uma execução completa do pipeline sobre um alvo, identificada por `jobId` (`cr-YYYYMMDD-<slug>-<rand4>`) |
| **Manifesto** | `cleanroom.yaml` - declara autorização, métodos permitidos, limites e handoffs |
| **Fase (phase)** | Etapa do pipeline com entrada/saída definidas (intake, explore, capture, analyze, synthesize, validate, report) |
| **Evidência** | Artefato observado (screenshot, entrada HAR, trecho de DOM, string, página de doc) com hash e metadados |
| **Achado (finding)** | Afirmação derivada de 1+ evidências (ex.: "campo e-mail é obrigatório") com confiança |
| **Regra de negócio (BR)** | Achado consolidado no formato gatilho/condição/efeito, id `BR-NNN` |
| **Confiança** | `observed` (visto diretamente) · `inferred` (deduzido de evidências) · `hypothesis` (suspeita não confirmada) |
| **Handoff humano** | Pausa do job aguardando ação humana (CAPTCHA, SMS, aprovação de pagamento) |
| **Sala suja / sala limpa** | Quem vê o alvo (pipeline) / quem implementa só a partir da spec |
