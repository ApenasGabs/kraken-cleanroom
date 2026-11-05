# EXPECTED.md — Ground Truth de Regras de Negócio da `demo-app`

Este documento relaciona as **12 regras de negócio plantadas** deliberadamente em `fixtures/demo-app`. Ele serve como *ground truth* para avaliar a precisão do pipeline do `kraken-cleanroom` (`explorer`, `analyzers`, `synthesizer` e `validator`).

---

## Catálogo de Regras Plantadas (`BR-001` a `BR-012`)

### 1. Validações de Criação de Projeto (`/projects/new` e `POST /api/projects`)

| ID | Módulo | Regra (Gatilho / Condição / Efeito) | Evidências Esperadas |
|---|---|---|---|
| **BR-001** | Projetos | **Nome obrigatório e tamanho (3–60 caracteres):** Ao submeter um novo projeto, se `name` estiver vazio ou tiver menos de 3 ou mais de 60 caracteres (após `trim`), a criação é rejeitada com HTTP `400`/`422` (`NAME_REQUIRED` / `NAME_LENGTH_INVALID`) e mensagem `"O nome do projeto deve ter entre 3 e 60 caracteres."`. | `form_schema`, `form_probe`, `network_call`, `doc_section`, `bundle_string` |
| **BR-002** | Projetos | **Orçamento não-negativo (`budget >= 0`):** Ao submeter um novo projeto, se `budget` estiver ausente, não for numérico ou for menor que `0`, a criação é rejeitada com HTTP `400`/`422` (`BUDGET_REQUIRED` / `BUDGET_MIN_ZERO`) e mensagem `"O orçamento deve ser um valor numérico maior ou igual a 0."`. | `form_schema`, `form_probe`, `network_call`, `doc_section`, `bundle_string` |
| **BR-003** | Projetos | **Data de entrega estritamente futura (`targetDate > hoje`):** Ao submeter um novo projeto, se `targetDate` estiver ausente, em formato inválido ou for menor/igual à data atual (`YYYY-MM-DD`), a criação é rejeitada com HTTP `400`/`422` (`TARGET_DATE_REQUIRED` / `TARGET_DATE_MUST_BE_FUTURE`) e mensagem `"A data de entrega deve ser uma data futura."`. | `form_schema`, `form_probe`, `network_call`, `doc_section`, `bundle_string` |

### 2. Limites de Plano (`/pricing` e `POST /api/projects`)

| ID | Módulo | Regra (Gatilho / Condição / Efeito) | Evidências Esperadas |
|---|---|---|---|
| **BR-004** | Faturamento / Planos | **Limite do Plano Free (máximo de 3 projetos não arquivados):** No plano `free` (R$ 0/mês), a conta pode manter no máximo **3 projetos** em estado `draft` ou `active`. Tentar criar um 4º projeto não arquivado retorna HTTP `422` (`PLAN_LIMIT_REACHED`). | `pricing_plan`, `doc_section`, `network_call`, `bundle_string` |
| **BR-005** | Faturamento / Planos | **Plano Pro sem limite de projetos:** No plano `pro` (R$ 49/mês), o limite de criação de projetos é **ilimitado** e a feature flag `pro_export` fica disponível. | `pricing_plan`, `doc_section`, `feature_flag` |

### 3. Máquina de Estados e Ciclo de Vida do Projeto (`/projects/:id`)

| ID | Módulo | Regra (Gatilho / Condição / Efeito) | Evidências Esperadas |
|---|---|---|---|
| **BR-006** | Projetos | **Enum de status e estado inicial (`draft`):** Todo projeto possui `status` pertencente ao conjunto `draft \| active \| archived`, sendo criado inicialmente com `status = "draft"`. | `network_call`, `dom_snapshot`, `doc_section` |
| **BR-007** | Projetos | **Ações permitidas em `draft`:** Quando o projeto está em `draft`, a interface exibe os botões **"Ativar projeto"** (`draft -> active`), **"Arquivar projeto"** (`draft -> archived`) e **"Excluir projeto"** (ação destrutiva). | `dom_snapshot`, `a11y_snapshot`, `state`, `transition`, `doc_section` |
| **BR-008** | Projetos | **Ações permitidas em `active`:** Quando o projeto está em `active`, a interface exibe **"Arquivar projeto"** (`active -> archived`) e **"Exportar relatório Pro"** (`pro_export`), ocultando o botão de ativação e impedindo a exclusão direta (`DELETE_ONLY_DRAFT`, HTTP `409`). | `dom_snapshot`, `a11y_snapshot`, `state`, `doc_section`, `feature_flag` |
| **BR-009** | Projetos | **Estado terminal somente leitura (`archived`):** Quando o projeto está em `archived`, ele torna-se somente leitura: nenhum botão de mutação é exibido na UI e chamadas a `/activate`, `/archive` ou `/delete` retornam HTTP `409 Conflict` (`INVALID_STATUS_TRANSITION` / `DELETE_ONLY_DRAFT`). | `dom_snapshot`, `network_call`, `doc_section` |

### 4. Paginação, Autenticação e Guardrails de Escopo

| ID | Módulo | Regra (Gatilho / Condição / Efeito) | Evidências Esperadas |
|---|---|---|---|
| **BR-010** | Projetos | **Listagem paginada de projetos (`GET /api/projects?page=`):** A listagem retorna páginas de tamanho padrão `2` com metadados `{ page, pageSize, total, totalPages, hasNextPage, createdProjectsCount }`. | `network_call`, `dom_snapshot` |
| **BR-011** | Autenticação | **Validação de credenciais no login (`/login` e `POST /api/auth/login`):** O login exige um `email` contendo `@` e `password` com no mínimo 8 caracteres, rejeitando entradas inválidas com HTTP `400`/`422` (`LOGIN_EMAIL_INVALID`, `LOGIN_PASSWORD_SHORT`). | `form_schema`, `form_probe`, `bundle_string` |
| **BR-012** | Segurança / Escopo | **Proteção de rotas administrativas e ações destrutivas:** A rota `/admin` e `/logout` são declaradas como `Disallow` em `/robots.txt` e em `forbiddenPaths` (retornando HTTP `403` em `/admin`), e o botão **"Excluir projeto"** é classificado como destrutivo, não devendo ser acionado pelo explorer quando `destructiveActions: false`. | `robots`, `dom_snapshot`, `state` |
