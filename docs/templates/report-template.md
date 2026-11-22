<!--
Template do relatório clean room. Renderizado por @cleanroom/synthesizer.
Placeholders: {{campo}}; blocos repetidos: {{#each lista}} ... {{/each}}.
Regra: nenhum trecho de código, CSS ou texto literal longo do alvo.
-->
# Relatório clean room: {{product.name}}

| Campo | Valor |
|---|---|
| Alvo | {{target.url}} |
| Job | `{{job.id}}` |
| Gerado em | {{job.finishedAt}} |
| Ownership | {{manifest.ownership}} |
| Métodos | {{manifest.methodsEnabled}} |
| Cobertura | {{coverage.pagesVisited}} estados, {{coverage.endpoints}} endpoints, {{coverage.docSections}} seções de doc |
| Regras | {{stats.rules.total}} ({{stats.rules.observed}} observed, {{stats.rules.inferred}} inferred, {{stats.rules.hypothesis}} hypothesis) |

## 1. Sumário executivo

{{summary.narrative}}

**Principais achados**
{{#each summary.highlights}}
- {{this.text}} ({{this.ruleIds}})
{{else}}
- _Nenhum destaque consolidado nesta execução._
{{/each}}

## 2. Visão do produto

{{product.valueProposition}}

### Personas
{{#each product.personas}}
- **{{this.name}}**: {{this.goal}}
{{else}}
- _Nenhuma persona específica identificada._
{{/each}}

### Planos e limites
| Plano | Preço | Limites | Evidência |
|---|---|---|---|
{{#each pricing.plans}}
| {{this.name}} | {{this.price}} | {{this.limits}} | {{this.evidenceIds}} |
{{else}}
| - | - | _Nenhum plano de preços observado_ | - |
{{/each}}

## 3. Mapa funcional

{{#each modules}}
### 3.{{@index1}} {{this.name}}

{{this.summary}}

| Funcionalidade | Descrição | Confiança | Evidência |
|---|---|---|---|
{{#each this.features}}
| {{this.name}} | {{this.description}} | {{this.confidence}} | {{this.evidenceIds}} |
{{/each}}

{{#if this.screenshot}}
![{{this.name}}](assets/{{this.screenshot}})
{{/if}}
{{/each}}

## 4. Modelo de domínio

```mermaid
{{domain.erMermaid}}
```

{{#each domain.entities}}
### {{this.name}}
| Atributo | Tipo | Obrigatório | Notas |
|---|---|---|---|
{{#each this.attributes}}
| {{this.name}} | {{this.type}} | {{this.required}} | {{this.notes}} |
{{/each}}
{{/each}}

## 5. Catálogo de regras de negócio

{{#each rules}}
### {{this.id}}: {{this.title}}
- **Módulo:** {{this.module}}
- **Quando:** {{this.trigger}}
- **Se:** {{this.condition}}
- **Então:** {{this.effect}}
- **Confiança:** {{this.confidence}}{{#if this.validation}} (validação: {{this.validation.status}}){{/if}}
- **Evidências:** {{this.evidenceIds}}
{{/each}}

## 6. Máquinas de estado

{{#each stateMachines}}
### {{this.entity}}
```mermaid
{{this.mermaid}}
```
{{else}}
_Nenhuma máquina de estados inferida nesta execução._
{{/each}}

## 7. Fluxos principais

{{#each flows}}
### {{this.name}}
{{this.description}}
```mermaid
{{this.mermaid}}
```
{{else}}
_Nenhum fluxo principal inferido nesta execução._
{{/each}}

## 8. Contrato de API inferido

Arquivo completo: [`openapi.yaml`](../analysis/openapi.yaml)

| Método | Path | Propósito | Auth | Evidência |
|---|---|---|---|---|
{{#each api.operations}}
| {{this.method}} | `{{this.path}}` | {{this.purpose}} | {{this.auth}} | {{this.evidenceIds}} |
{{else}}
| - | `-` | _Nenhuma operação de API observada_ | - | - |
{{/each}}

## 9. Papéis e permissões

{{permissions.matrixMarkdown}}

## 10. Validações e mensagens

| Formulário | Campo | Regra | Mensagem (resumo) | Evidência |
|---|---|---|---|---|
{{#each validations}}
| {{this.form}} | {{this.field}} | {{this.rule}} | {{this.messageSummary}} | {{this.evidenceIds}} |
{{else}}
| - | - | - | _Nenhuma validação observada_ | - |
{{/each}}

## 11. Integrações externas detectadas

{{#each integrations}}
- **{{this.name}}** ({{this.category}}): {{this.signal}} [{{this.evidenceIds}}]
{{else}}
_Nenhuma integração externa detectada._
{{/each}}

## 12. Critérios de aceite

{{#each features}}
- [`{{this.file}}`](features/{{this.file}}): {{this.scenarioCount}} cenários
{{else}}
_Nenhum arquivo `.feature` gerado neste job (geração Gherkin prevista para a Fase 3)._
{{/each}}

## 13. Lacunas, hipóteses e contradições

{{#each gaps}}
- **{{this.kind}}**: {{this.text}} [{{this.evidenceIds}}]
{{else}}
_Nenhuma lacuna, hipótese ou contradição pendente registrada._
{{/each}}

## Apêndice A: cobertura e metodologia

- Limites atingidos: {{coverage.limitsHit}}
- Duração: {{job.durationMin}} min · Tokens LLM: {{job.llmTokensIn}} in / {{job.llmTokensOut}} out
- Fases executadas: {{job.phases}}
- Metodologia: exploração comportamental, captura da própria sessão, documentação pública e metadados de bundles públicos. Nenhum código do alvo foi copiado.
