# 03 - Manifesto `cleanroom.yaml`

O manifesto é o **contrato de autorização** de um job. É normativo: código que interage com o alvo **deve** consultá-lo. Nenhum job inicia sem manifesto válido.

## 1. Exemplo completo

Ver [`examples/cleanroom.example.yaml`](../examples/cleanroom.example.yaml).

## 2. Referência de campos

### Raiz

| Campo | Tipo | Obrigatório | Default | Descrição |
|---|---|---|---|---|
| `version` | `1` | sim | - | Versão do schema |
| `job.name` | string (slug, 3-40, `[a-z0-9-]`) | sim | - | Usado no `jobId` |
| `job.description` | string | não | - | Objetivo do estudo, em linguagem natural |
| `job.goals` | string[] | não | `[]` | Perguntas que o relatório precisa responder (ex.: "Como funciona o limite do plano free?") |

### `target`

| Campo | Tipo | Obrigatório | Default | Descrição |
|---|---|---|---|---|
| `target.url` | URL https | sim (exceto `type: repo`) | - | Ponto de entrada |
| `target.type` | `web-spa` \| `web-ssr` \| `web-unknown` \| `repo` | sim | `web-unknown` | Intake pode refinar `web-unknown` |
| `target.allowedOrigins` | string[] (origins) | não | `[origin de url]` | Origens que o explorer pode navegar. Requisições a outras origens são **registradas** mas não navegadas |
| `target.docsUrls` | URL[] | não | `[]` | Central de ajuda, pricing, termos, changelog, docs de API |
| `target.repo` | string | se `type: repo` | - | `owner/name` ou caminho local |

### `ownership` e `authorization`

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `ownership` | `own` \| `third-party` \| `client-authorized` | sim | Relação com o alvo |
| `authorization.basis` | string (min 10) | sim | Justificativa em texto (ex.: "Conta própria, uso normal, plano free") |
| `authorization.tosReviewed` | boolean | sim | Precisa ser `true` para `third-party` |
| `authorization.evidence` | string \| null | se `client-authorized` | Referência a contrato/e-mail de autorização |

### `methods`

| Campo | Default | Regra de validação |
|---|---|---|
| `behavioralUi` | `true` | - |
| `networkHar` | `true` | Captura só o tráfego gerado pela própria sessão |
| `publicDocs` | `true` | - |
| `staticBundles` | `true` | Só JS entregue publicamente ao browser; armazenar **metadados**, não o bundle |
| `binaryAnalysis` | `false` | **Erro** se `true` e `ownership != own` |
| `sourceRepo` | `false` | Exige `target.repo` |
| `authenticatedSession` | `false` | Exige `accounts` (fase 2) |

### `limits`

| Campo | Tipo | Default | Descrição |
|---|---|---|---|
| `maxPages` | int 1-2000 | `150` | Teto de estados/páginas visitados |
| `maxDepth` | int 1-20 | `6` | Profundidade máxima a partir da entrada |
| `maxDurationMin` | int 5-480 | `60` | Timeout global |
| `rateLimitRps` | number 0.1-5 | `1` | Navegações + ações por segundo |
| `maxAccounts` | int 0-1 | `0` | Contas criadas pelo job (máx. 1 por política) |
| `forbiddenPaths` | glob[] | `["**/logout", "**/delete*", "**/admin/**", "**/checkout/**"]` | Nunca navegar/clicar |
| `destructiveActions` | boolean | `false` | Se `false`, explorer não submete formulários classificados como destrutivos (excluir, cancelar assinatura, enviar convite, publicar) |
| `formSubmission` | `none` \| `validation-only` \| `full` | `validation-only` | `validation-only`: dispara validação client-side/server-side com dados inválidos, sem concluir criação de recursos |
| `respectRobotsTxt` | boolean | `true` | Se `true`, paths bloqueados por `robots.txt` ficam fora |

### `accounts` (fase 2)

| Campo | Tipo | Descrição |
|---|---|---|
| `accounts.strategy` | `none` \| `provided` \| `signup` | `provided`: credenciais já existentes no cofre; `signup`: job cria conta |
| `accounts.emailAlias` | `auto` \| string | `auto` gera `cr-<jobId>@<CLEANROOM_INBOX_DOMAIN>` |
| `accounts.credentialRef` | string | Referência ao cofre (nunca a senha) |
| `accounts.identity` | `owner` | Única opção: identidade real do dono. Não há suporte a identidades falsas |

### `humanInTheLoop`

| Campo | Valores | Default |
|---|---|---|
| `captcha` | `handoff` \| `abort` | `handoff` |
| `smsOtp` | `handoff` \| `abort` | `handoff` |
| `payments` | `require-approval` \| `abort` | `abort` |
| `handoffTimeoutMin` | int | `30` |

Não existe valor `auto` para nenhum desses campos. Isso é intencional.

### `cleanup`

| Campo | Default | Descrição |
|---|---|---|
| `deleteAccountAtEnd` | `true` | Executa fluxo de exclusão de conta ao final (se `signup`) |
| `purgeHarSecrets` | `true` | Remove `Cookie`, `Set-Cookie`, `Authorization`, tokens em query/body antes de persistir |
| `retainDays` | `90` | Retenção dos dados brutos do job |

### `report`

| Campo | Default | Descrição |
|---|---|---|
| `language` | `pt-BR` | Idioma do relatório |
| `viewports` | `[[375,812],[768,1024],[1440,900]]` | Viewports dos screenshots |
| `include` | todas | Seções do template a incluir |

## 3. Regras de validação cruzadas (implementar no zod com `superRefine`)

1. `ownership == third-party` exige `authorization.tosReviewed == true`.
2. `methods.binaryAnalysis == true` exige `ownership == own`.
3. `ownership == client-authorized` exige `authorization.evidence` não vazio.
4. `methods.authenticatedSession == true` exige `accounts.strategy != none`.
5. `accounts.strategy == signup` exige `limits.maxAccounts == 1`.
6. `target.url` deve estar em `target.allowedOrigins`.
7. `forbiddenPaths` padrão **sempre** é mesclado (usuário pode adicionar, não remover `logout`).

## 4. Uso em código

```ts
import { loadManifest } from "@cleanroom/core";

const manifest = await loadManifest("cleanroom.yaml"); // lança ManifestError com issues formatadas
const guard = createScopeGuard(manifest);               // em @cleanroom/core

guard.assertMethod("networkHar");             // lança MethodNotAllowedError
guard.canNavigate("https://app.x.com/admin"); // false por forbiddenPaths
await guard.throttle();                        // respeita rateLimitRps
```

`ScopeGuard` é o **único** caminho para decidir se uma ação é permitida. Explorer e validator não fazem checagens próprias espalhadas.

## 5. Contexto para LLM

O synthesizer injeta no prompt de sistema um resumo do manifesto (`ownership`, `authorization.basis`, `methods` ativos, `job.goals`). Isso dá ao modelo o contexto honesto do estudo e deixa explícito que o objetivo é especificação comportamental.
