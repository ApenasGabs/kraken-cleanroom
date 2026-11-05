import type { DemoProject, PaginatedProjects, ProjectStatus } from "./store.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLayout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="generator" content="Hono Cleanroom Demo SSR" />
  <title>${escapeHtml(title)} — Kraken Demo App</title>
  <style>
    :root { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; background: #f8fafc; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; line-height: 1.5; }
    header { background: #0f172a; color: #f8fafc; padding: 1rem 1.5rem; }
    nav { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; max-width: 1100px; margin: 0 auto; }
    nav a { color: #e2e8f0; text-decoration: none; font-weight: 500; }
    nav a:hover { text-decoration: underline; color: #ffffff; }
    main { max-width: 1100px; margin: 1.5rem auto; padding: 0 1.5rem; }
    .card { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
    .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .badge-draft { background: #fef3c7; color: #92400e; }
    .badge-active { background: #dcfce7; color: #166534; }
    .badge-archived { background: #e2e8f0; color: #475569; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; }
    button, .btn { padding: 0.5rem 1rem; border-radius: 0.375rem; border: 1px solid #0f172a; background: #0f172a; color: #ffffff; cursor: pointer; text-decoration: none; font-size: 0.95rem; }
    button.secondary, .btn.secondary { background: #ffffff; color: #0f172a; }
    button.destructive { background: #dc2626; border-color: #dc2626; color: #ffffff; }
    .alert { padding: 0.75rem 1rem; border-radius: 0.375rem; background: #fee2e2; border: 1px solid #ef4444; color: #991b1b; margin-bottom: 1rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
    .field input { width: 100%; max-width: 420px; padding: 0.5rem; border: 1px solid #94a3b8; border-radius: 0.375rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #cbd5e1; padding: 0.75rem; text-align: left; }
    th { background: #f1f5f9; }
    footer { max-width: 1100px; margin: 2rem auto; padding: 1rem 1.5rem; border-top: 1px solid #cbd5e1; font-size: 0.875rem; color: #475569; display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; }
  </style>
  <script src="/static/app.js" defer></script>
</head>
<body>
  <header>
    <nav aria-label="Navegação principal">
      <a href="/">Início</a>
      <a href="/projects">Projetos</a>
      <a href="/projects/new">Novo projeto</a>
      <a href="/pricing">Planos e Preços</a>
      <a href="/help">Central de Ajuda</a>
      <a href="/login">Entrar</a>
    </nav>
  </header>
  <main>
    ${content}
  </main>
  <footer>
    <span>Kraken Cleanroom Demo App (Fixture de Referência)</span>
    <div>
      <a href="/admin">Painel Admin (Restrito)</a>
      |
      <a href="/logout">Sair</a>
    </div>
  </footer>
</body>
</html>`;
}

function statusLabel(status: ProjectStatus): string {
  switch (status) {
    case "draft":
      return "Rascunho";
    case "active":
      return "Ativo";
    case "archived":
      return "Arquivado";
  }
}

export function renderHomePage(): string {
  return renderLayout(
    "Gestão de Projetos",
    `<section class="card">
      <h1>Gestão Simplificada de Projetos</h1>
      <p>Organize seus projetos, acompanhe orçamentos e controle prazos em um fluxo simples.</p>
      <div class="actions">
        <a class="btn" href="/projects">Ver lista de projetos</a>
        <a class="btn secondary" href="/projects/new">Novo projeto</a>
        <a class="btn secondary" href="/pricing">Conhecer planos</a>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <h2>Ciclo de vida controlado</h2>
        <p>Projetos iniciam em <strong>draft</strong>, passam para <strong>active</strong> e encerram em <strong>archived</strong>.</p>
      </div>
      <div class="card">
        <h2>Plano Free e Pro</h2>
        <p>Comece grátis com até 3 projetos ativos ou em rascunho. Evolua para o Pro sem limites.</p>
      </div>
    </section>`,
  );
}

export function renderLoginPage(errorMessage?: string): string {
  const alertBlock = errorMessage
    ? `<div id="login-errors" class="alert" role="alert">${escapeHtml(errorMessage)}</div>`
    : `<div id="login-errors" class="alert" role="alert" hidden></div>`;

  return renderLayout(
    "Entrar",
    `<section class="card">
      <h1>Acessar Conta</h1>
      <p>Ambiente de demonstração com autenticação simulada.</p>
      ${alertBlock}
      <form id="login-form" action="/api/auth/login" method="post" novalidate>
        <div class="field">
          <label for="email">E-mail</label>
          <input id="email" name="email" type="email" required placeholder="voce@exemplo.com" />
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input id="password" name="password" type="password" required minlength="8" placeholder="Mínimo de 8 caracteres" />
        </div>
        <div class="actions">
          <button type="submit">Entrar</button>
        </div>
      </form>
    </section>`,
  );
}

export function renderProjectsPage(paginated: PaginatedProjects): string {
  const rows = paginated.items
    .map(
      (
        project,
      ) => `<article class="card" data-project-id="${escapeHtml(project.id)}" data-status="${escapeHtml(project.status)}">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <h2><a href="/projects/${escapeHtml(project.id)}">${escapeHtml(project.name)}</a></h2>
          <span class="badge badge-${escapeHtml(project.status)}" data-field="status">${escapeHtml(project.status)} (${statusLabel(project.status)})</span>
        </div>
        <p>Orçamento: <strong>R$ ${project.budget.toFixed(2)}</strong> | Entrega: <strong>${escapeHtml(project.targetDate)}</strong></p>
        <div class="actions">
          <a class="btn secondary" href="/projects/${escapeHtml(project.id)}">Ver detalhes</a>
        </div>
      </article>`,
    )
    .join("\n");

  const prevPage = paginated.meta.page > 1 ? paginated.meta.page - 1 : null;
  const nextPage = paginated.meta.hasNextPage ? paginated.meta.page + 1 : null;

  return renderLayout(
    "Projetos",
    `<section>
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem;">
        <h1>Projetos (Página ${paginated.meta.page} de ${paginated.meta.totalPages})</h1>
        <a class="btn" href="/projects/new">Novo projeto</a>
      </div>
      ${rows || "<p>Nenhum projeto encontrado nesta página.</p>"}
      <nav aria-label="Paginação de projetos" class="actions">
        ${prevPage ? `<a class="btn secondary" href="/projects?page=${prevPage}">Página anterior</a>` : ""}
        <a class="btn secondary" href="/projects?page=1">Página 1</a>
        <a class="btn secondary" href="/projects?page=2">Página 2</a>
        ${nextPage ? `<a class="btn secondary" href="/projects?page=${nextPage}">Próxima página</a>` : ""}
      </nav>
    </section>`,
  );
}

export function renderProjectDetailPage(project: DemoProject, errorMessage?: string): string {
  const alertBlock = errorMessage
    ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";

  let statusActions = "";
  if (project.status === "draft") {
    statusActions = `
      <form action="/api/projects/${escapeHtml(project.id)}/activate" method="post">
        <button type="submit" data-action="activate">Ativar projeto</button>
      </form>
      <form action="/api/projects/${escapeHtml(project.id)}/archive" method="post">
        <button type="submit" class="secondary" data-action="archive">Arquivar projeto</button>
      </form>
      <form action="/api/projects/${escapeHtml(project.id)}/delete" method="post">
        <button type="submit" class="destructive" data-action="delete">Excluir projeto</button>
      </form>
    `;
  } else if (project.status === "active") {
    statusActions = `
      <form action="/api/projects/${escapeHtml(project.id)}/archive" method="post">
        <button type="submit" class="secondary" data-action="archive">Arquivar projeto</button>
      </form>
      <button type="button" class="secondary" data-feature="pro_export">Exportar relatório Pro</button>
    `;
  } else {
    statusActions = `<p data-readonly-notice="true"><em>Projeto arquivado (somente leitura). Nenhuma ação de alteração disponível.</em></p>`;
  }

  return renderLayout(
    `Projeto: ${project.name}`,
    `<article class="card" data-project-id="${escapeHtml(project.id)}" data-project-status="${escapeHtml(project.status)}">
      ${alertBlock}
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <h1>${escapeHtml(project.name)}</h1>
        <span class="badge badge-${escapeHtml(project.status)}" data-status-badge="${escapeHtml(project.status)}">${escapeHtml(project.status)} (${statusLabel(project.status)})</span>
      </div>
      <dl>
        <dt>ID</dt>
        <dd>${escapeHtml(project.id)}</dd>
        <dt>Status atual</dt>
        <dd>${escapeHtml(project.status)}</dd>
        <dt>Orçamento aprovado</dt>
        <dd>R$ ${project.budget.toFixed(2)}</dd>
        <dt>Data de entrega prevista</dt>
        <dd>${escapeHtml(project.targetDate)}</dd>
      </dl>
      <div class="actions" aria-label="Ações do projeto">
        ${statusActions}
      </div>
      <p style="margin-top:1.25rem;"><a href="/projects">← Voltar para a lista de projetos</a></p>
    </article>`,
  );
}

export function renderNewProjectPage(errorMessage?: string): string {
  const alertBlock = errorMessage
    ? `<div id="form-errors" class="alert" role="alert" aria-live="polite">${escapeHtml(errorMessage)}</div>`
    : `<div id="form-errors" class="alert" role="alert" aria-live="polite" hidden></div>`;

  return renderLayout(
    "Novo projeto",
    `<section class="card">
      <h1>Novo projeto</h1>
      <p>Preencha os campos abaixo. Nome obrigatório (3 a 60 caracteres), orçamento maior ou igual a 0 e data de entrega futura.</p>
      ${alertBlock}
      <form id="new-project-form" action="/api/projects" method="post" novalidate>
        <div class="field">
          <label for="name">Nome do projeto *</label>
          <input id="name" name="name" type="text" required minlength="3" maxlength="60" placeholder="Ex.: Portal de Autoatendimento" />
        </div>
        <div class="field">
          <label for="budget">Orçamento (R$) *</label>
          <input id="budget" name="budget" type="number" required min="0" step="0.01" placeholder="0.00" />
        </div>
        <div class="field">
          <label for="targetDate">Data de entrega (futura) *</label>
          <input id="targetDate" name="targetDate" type="date" required />
        </div>
        <div class="actions">
          <button type="submit">Criar projeto</button>
          <a class="btn secondary" href="/projects">Cancelar</a>
        </div>
      </form>
    </section>`,
  );
}

export function renderPricingPage(): string {
  return renderLayout(
    "Planos e Preços",
    `<section class="card">
      <h1>Planos e Preços</h1>
      <p>Escolha o plano ideal para a sua equipe.</p>
      <div class="grid">
        <article class="card" data-plan="free">
          <h2>Plano Free</h2>
          <p><strong>R$ 0 / mês</strong></p>
          <ul>
            <li>Limite: <strong>até 3 projetos</strong> ativos ou em rascunho</li>
            <li>1 usuário incluído</li>
            <li>Visão padrão de status (draft, active, archived)</li>
          </ul>
        </article>
        <article class="card" data-plan="pro">
          <h2>Plano Pro</h2>
          <p><strong>R$ 49 / mês</strong></p>
          <ul>
            <li>Limite: <strong>projetos ilimitados</strong></li>
            <li>Membros ilimitados</li>
            <li>Exportação avançada habilitada (<code>pro_export</code>)</li>
          </ul>
        </article>
      </div>
      <table aria-label="Comparativo de planos">
        <thead>
          <tr>
            <th>Plano</th>
            <th>Preço Mensal</th>
            <th>Limite de Projetos</th>
            <th>Exportação Pro</th>
          </tr>
        </thead>
        <tbody>
          <tr data-plan-row="free">
            <td>Free</td>
            <td>R$ 0</td>
            <td>Até 3 projetos</td>
            <td>Não incluído</td>
          </tr>
          <tr data-plan-row="pro">
            <td>Pro</td>
            <td>R$ 49</td>
            <td>Ilimitado</td>
            <td>Incluído (feature flag pro_export)</td>
          </tr>
        </tbody>
      </table>
    </section>`,
  );
}

export function renderHelpPage(): string {
  return renderLayout(
    "Central de Ajuda",
    `<article class="card">
      <h1>Central de Ajuda — Documentação Oficial</h1>
      <p>Guia rápido sobre regras de negócio, validações e limites da plataforma.</p>

      <section id="artigo-criacao-validacoes">
        <h2>1. Como criar projetos e regras de validação</h2>
        <p>Para cadastrar um novo projeto em <code>/projects/new</code> ou via <code>POST /api/projects</code>, três regras de validação obrigatórias são aplicadas:</p>
        <ul>
          <li><strong>Nome do projeto:</strong> obrigatório, devendo conter entre 3 e 60 caracteres após remoção de espaços nas extremidades.</li>
          <li><strong>Orçamento:</strong> obrigatório, numérico maior ou igual a zero (<code>budget &gt;= 0</code>). Valores negativos são rejeitados com erro HTTP 422.</li>
          <li><strong>Data de entrega:</strong> obrigatória no formato ISO (<code>YYYY-MM-DD</code>) e estritamente futura em relação à data atual.</li>
        </ul>
      </section>

      <section id="artigo-ciclo-vida-status">
        <h2>2. Ciclo de vida e máquina de estados do projeto</h2>
        <p>Todo projeto possui um atributo <code>status</code> pertencente ao enum <code>draft | active | archived</code>:</p>
        <ul>
          <li><strong>draft (Rascunho):</strong> estado inicial de todo projeto recém-criado. Permite ativar (transição para <code>active</code>), arquivar (transição para <code>archived</code>) ou excluir o projeto.</li>
          <li><strong>active (Ativo):</strong> projeto em execução. Permite arquivar (transição para <code>archived</code>) e acionar a exportação avançada, mas não permite exclusão direta nem retorno para rascunho.</li>
          <li><strong>archived (Arquivado):</strong> estado final somente leitura. Projetos arquivados não podem ser reativados, editados nem excluídos.</li>
        </ul>
      </section>

      <section id="artigo-planos-limites-seguranca">
        <h2>3. Limites de planos Free vs Pro e rotas restritas</h2>
        <p>A criação de projetos respeita o limite contratado na conta:</p>
        <ul>
          <li><strong>Plano Free:</strong> permite manter no máximo <strong>3 projetos</strong> não arquivados (em <code>draft</code> ou <code>active</code>). Ao atingir 3 projetos, novas criações retornam HTTP 422 (<code>PLAN_LIMIT_REACHED</code>).</li>
          <li><strong>Plano Pro:</strong> permite criação ilimitada de projetos e libera a funcionalidade <code>pro_export</code>.</li>
          <li><strong>Rotas administrativas:</strong> o caminho <code>/admin</code> é restrito a administradores internos e bloqueado no <code>robots.txt</code>.</li>
        </ul>
      </section>
    </article>`,
  );
}

export function renderAdminPage(): string {
  return renderLayout(
    "Admin Restrito",
    `<section class="card">
      <h1>403 — Área Administrativa Restrita</h1>
      <p>Esta rota é exclusiva para administração interna e não deve ser acessada por crawlers ou usuários comuns.</p>
    </section>`,
  );
}

export function renderNotFoundPage(path: string): string {
  return renderLayout(
    "Página não encontrada",
    `<section class="card">
      <h1>404 — Página não encontrada</h1>
      <p>O caminho <code>${escapeHtml(path)}</code> não existe nesta aplicação.</p>
      <a class="btn secondary" href="/">Voltar ao início</a>
    </section>`,
  );
}
