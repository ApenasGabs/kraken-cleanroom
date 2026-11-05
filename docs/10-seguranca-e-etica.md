# 10 - Segurança e ética

Este documento é normativo. Em conflito com qualquer outro, este vence.

## 1. Limites do que o sistema faz

| Permitido | Proibido |
|---|---|
| Navegar como um usuário comum, dentro de `allowedOrigins` | Acessar paths de `forbiddenPaths` ou bloqueados no `robots.txt` (quando `respectRobotsTxt`) |
| Gravar o tráfego da **própria** sessão | Interceptar tráfego de outros usuários ou do servidor |
| Ler JS entregue publicamente ao browser e extrair metadados | Armazenar ou redistribuir o código do alvo |
| Ler docs públicas e resumir | Copiar textos longos ou assets |
| Disparar validações com dados inválidos (`validation-only`) | Fuzzing agressivo, injeção (SQLi/XSS), testes de carga ou de segurança |
| Uma conta com identidade real do dono | Contas falsas, múltiplas contas, identidades sintéticas |
| Handoff humano em CAPTCHA, SMS e pagamento | Resolver ou contornar CAPTCHA, anti-bot ou proof-of-work |
| Rate limit conservador (default 1 rps) | Rotação de proxies/IPs, fingerprint spoofing, stealth plugins |
| Parar quando bloqueado (`blocked`) | Insistir após 403/429 repetidos |

## 2. Comportamento ao ser bloqueado

- HTTP 429: respeitar `Retry-After`; após 3 ocorrências, reduzir `rateLimitRps` pela metade; após 6, `blocked`.
- HTTP 403 em navegação principal ou página de desafio anti-bot: `blocked` com motivo. Não tentar de novo automaticamente.
- Detecção de desafio (Cloudflare challenge, reCAPTCHA, hCaptcha, Turnstile): `handoff` se o manifesto permitir, senão `blocked`.

## 3. Clean room

- O relatório descreve **comportamento observável**. Não contém código, CSS, nomes internos de variáveis, ícones, imagens (exceto screenshots como evidência de estudo, armazenados localmente) nem textos literais longos.
- Screenshots ficam no diretório do job e não são publicados fora do homelab.
- Quem implementa a reimplementação (Forge) recebe **apenas** `report.md`, `index.json`, `openapi.yaml` (inferido) e `.feature`. Não recebe HAR, DOM ou bundles.

## 4. Dados pessoais (LGPD)

- Não coletar dados pessoais de terceiros. Se o alvo exibir dados de outros usuários (ex.: listas públicas), o snapshot DOM é truncado e o synthesizer recebe instrução de não registrar nomes, e-mails ou telefones.
- Dados do próprio dono (conta de teste) ficam só no diretório do job com permissão restrita e são apagados após `retainDays`.

## 5. Segredos

- Repo público: nenhum segredo, IP interno ou token em código, testes ou docs. Use `.env.example` com placeholders.
- `gitleaks` no CI.
- Logs redigidos (ver `09` §6).

## 6. Revisão obrigatória

PRs que tocam `ScopeGuard`, classificação de ações destrutivas, sanitização de HAR, handoff ou contas exigem revisão explícita do Sentinel com comentário "security-reviewed".
