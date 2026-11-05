export const PUBLIC_APP_BUNDLE_JS = `// Kraken Cleanroom Demo App - Public Client Bundle
(function () {
  const ROUTES = [
    { path: "/", name: "home" },
    { path: "/login", name: "login" },
    { path: "/projects", name: "projects-list" },
    { path: "/projects/new", name: "projects-new" },
    { path: "/projects/:id", name: "projects-detail" },
    { path: "/pricing", name: "pricing" },
    { path: "/help", name: "help" }
  ];

  const API_ENDPOINTS = {
    projects: "/api/projects",
    projectStats: "/api/projects/stats",
    login: "/api/auth/login"
  };

  const I18N_MESSAGES = {
    "projects.validation.name_required": "O nome do projeto é obrigatório e deve ter entre 3 e 60 caracteres.",
    "projects.validation.name_length": "O nome do projeto deve ter entre 3 e 60 caracteres.",
    "projects.validation.budget_min": "O orçamento deve ser um valor numérico maior ou igual a 0.",
    "projects.validation.future_date": "A data de entrega deve ser uma data futura.",
    "projects.limit.free_plan": "Limite do plano Free atingido (máximo de 3 projetos ativos/rascunho). Faça upgrade para o plano Pro.",
    "projects.status.draft": "Rascunho",
    "projects.status.active": "Ativo",
    "projects.status.archived": "Arquivado",
    "auth.validation.email": "Informe um endereço de e-mail válido.",
    "auth.validation.password_min": "A senha deve ter pelo menos 8 caracteres."
  };

  const FEATURE_FLAGS = {
    pro_export: false,
    bulk_archive: false
  };

  function isEnabled(flagName) {
    return Boolean(FEATURE_FLAGS[flagName]);
  }

  function t(key) {
    return I18N_MESSAGES[key] || key;
  }

  window.DemoApp = {
    ROUTES: ROUTES,
    API_ENDPOINTS: API_ENDPOINTS,
    isEnabled: isEnabled,
    t: t
  };

  document.addEventListener("DOMContentLoaded", function () {
    const pathname = window.location.pathname;
    if (pathname === "/projects") {
      const params = new URLSearchParams(window.location.search);
      const page = params.get("page") || "1";
      fetch(API_ENDPOINTS.projects + "?page=" + encodeURIComponent(page), {
        headers: { Accept: "application/json" }
      }).catch(function () {});
    }

    const exportBtn = document.querySelector("[data-feature='pro_export']");
    if (exportBtn && !isEnabled("pro_export")) {
      exportBtn.setAttribute("title", "Disponível apenas no plano Pro");
    }

    const form = document.getElementById("new-project-form");
    const errorBox = document.getElementById("form-errors");
    if (form && errorBox) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = {
          name: String(formData.get("name") || ""),
          budget: formData.get("budget"),
          targetDate: String(formData.get("targetDate") || "")
        };
        const response = await fetch(API_ENDPOINTS.projects, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) {
          errorBox.textContent = body.message || t("projects.validation.name_required");
          errorBox.removeAttribute("hidden");
          return;
        }
        window.location.assign("/projects/" + body.data.id);
      });
    }
  });
})();
`;
