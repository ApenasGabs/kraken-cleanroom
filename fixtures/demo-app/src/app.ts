import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PUBLIC_APP_BUNDLE_JS } from "./bundle-content.js";
import {
  type DemoStore,
  type DemoStoreOptions,
  VALIDATION_MESSAGES,
  createDemoStore,
} from "./store.js";
import {
  renderAdminPage,
  renderHelpPage,
  renderHomePage,
  renderLoginPage,
  renderNewProjectPage,
  renderNotFoundPage,
  renderPricingPage,
  renderProjectDetailPage,
  renderProjectsPage,
} from "./views.js";

export interface DemoAppInstance {
  app: Hono;
  store: DemoStore;
}

async function parseRequestBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed: unknown = await req.json();
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const formData = await req.formData();
      const record: Record<string, unknown> = {};
      formData.forEach((value, key) => {
        if (typeof value === "string") {
          record[key] = value;
        }
      });
      return record;
    }
    const text = await req.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  const contentType = req.headers.get("content-type") ?? "";
  return accept.includes("text/html") && !contentType.includes("application/json");
}

export function createDemoApp(options: DemoStoreOptions = {}): DemoAppInstance {
  const store = createDemoStore(options);
  const app = new Hono();

  // Home
  app.get("/", (c) => c.html(renderHomePage()));

  // Fake Login
  app.get("/login", (c) => c.html(renderLoginPage()));

  const handleLogin = async (c: Context): Promise<Response> => {
    const body = await parseRequestBody(c.req.raw);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !email.includes("@")) {
      const status: ContentfulStatusCode = email.length === 0 ? 400 : 422;
      if (wantsHtml(c.req.raw)) {
        return c.html(renderLoginPage(VALIDATION_MESSAGES.LOGIN_EMAIL_INVALID), status);
      }
      return c.json(
        {
          error: "LOGIN_EMAIL_INVALID",
          code: "LOGIN_EMAIL_INVALID",
          message: VALIDATION_MESSAGES.LOGIN_EMAIL_INVALID,
          issues: [
            {
              field: "email",
              code: "LOGIN_EMAIL_INVALID",
              message: VALIDATION_MESSAGES.LOGIN_EMAIL_INVALID,
            },
          ],
        },
        status,
      );
    }

    if (password.length < 8) {
      const status: ContentfulStatusCode = password.length === 0 ? 400 : 422;
      if (wantsHtml(c.req.raw)) {
        return c.html(renderLoginPage(VALIDATION_MESSAGES.LOGIN_PASSWORD_SHORT), status);
      }
      return c.json(
        {
          error: "LOGIN_PASSWORD_SHORT",
          code: "LOGIN_PASSWORD_SHORT",
          message: VALIDATION_MESSAGES.LOGIN_PASSWORD_SHORT,
          issues: [
            {
              field: "password",
              code: "LOGIN_PASSWORD_SHORT",
              message: VALIDATION_MESSAGES.LOGIN_PASSWORD_SHORT,
            },
          ],
        },
        status,
      );
    }

    return c.json({
      ok: true,
      user: { email, plan: store.getPlan() },
    });
  };

  app.post("/login", handleLogin);
  app.post("/api/auth/login", handleLogin);

  app.get("/logout", (c) => c.redirect("/login"));

  // Projects HTML routes
  app.get("/projects", (c) => {
    const pageParam = Number(c.req.query("page") ?? "1");
    const pageSizeParam = c.req.query("pageSize") ? Number(c.req.query("pageSize")) : undefined;
    const paginated = store.listProjects(pageParam, pageSizeParam);
    return c.html(renderProjectsPage(paginated));
  });

  app.get("/projects/new", (c) => c.html(renderNewProjectPage()));

  app.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    const project = store.getProject(id);
    if (!project) {
      return c.html(renderNotFoundPage(`/projects/${id}`), 404);
    }
    return c.html(renderProjectDetailPage(project));
  });

  // Pricing & Help
  app.get("/pricing", (c) => c.html(renderPricingPage()));
  app.get("/help", (c) => c.html(renderHelpPage()));

  // Robots.txt & Sitemap.xml
  app.get("/robots.txt", (c) => {
    const url = new URL(c.req.url);
    const body = [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /logout",
      `Sitemap: ${url.origin}/sitemap.xml`,
      "",
    ].join("\n");
    return c.text(body, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  app.get("/sitemap.xml", (c) => {
    const url = new URL(c.req.url);
    const origin = url.origin;
    const paths = ["/", "/projects", "/projects/new", "/pricing", "/help", "/login"];
    const entries = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
    return c.body(xml, 200, { "Content-Type": "application/xml; charset=utf-8" });
  });

  // Forbidden Admin route
  const handleAdmin = (c: Context): Response | Promise<Response> => {
    const visits = store.recordAdminVisit();
    if ((c.req.raw.headers.get("accept") ?? "").includes("application/json")) {
      return c.json(
        {
          error: "ADMIN_FORBIDDEN",
          code: "ADMIN_FORBIDDEN",
          message: "Rota administrativa restrita (/admin).",
          adminVisitsCount: visits,
        },
        403,
      );
    }
    return c.html(renderAdminPage(), 403);
  };

  app.all("/admin", handleAdmin);
  app.all("/admin/*", handleAdmin);

  // Public JS bundle
  app.get("/static/app.js", (c) =>
    c.body(PUBLIC_APP_BUNDLE_JS, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
    }),
  );

  // JSON API: Stats & Counter (used by F1-06 validation-only tests)
  const handleStats = (c: Context): Response => c.json(store.getStats());
  app.get("/api/stats", handleStats);
  app.get("/api/projects/stats", handleStats);

  // JSON API: Projects list (paginated)
  app.get("/api/projects", (c) => {
    const pageParam = Number(c.req.query("page") ?? "1");
    const pageSizeParam = c.req.query("pageSize") ? Number(c.req.query("pageSize")) : undefined;
    return c.json(store.listProjects(pageParam, pageSizeParam));
  });

  // JSON API: Project detail
  app.get("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    const project = store.getProject(id);
    if (!project) {
      return c.json(
        {
          error: "PROJECT_NOT_FOUND",
          code: "PROJECT_NOT_FOUND",
          message: `Projeto '${id}' não encontrado.`,
        },
        404,
      );
    }
    return c.json({ data: project });
  });

  // JSON API: Create project
  app.post("/api/projects", async (c) => {
    const payload = await parseRequestBody(c.req.raw);
    const planHeader = c.req.header("x-demo-plan") ?? c.req.query("plan") ?? null;
    const result = store.createProject(payload, planHeader);

    if (!result.ok) {
      if (wantsHtml(c.req.raw)) {
        return c.html(renderNewProjectPage(result.message), result.status);
      }
      return c.json(
        {
          error: result.code,
          code: result.code,
          message: result.message,
          issues: result.issues,
        },
        result.status,
      );
    }

    if (wantsHtml(c.req.raw)) {
      return c.redirect(`/projects/${result.data.id}`, 303);
    }

    return c.json(
      {
        data: result.data,
        meta: {
          createdProjectsCount: store.getCreatedProjectsCount(),
        },
      },
      201,
    );
  });

  // JSON API: Status transitions
  app.post("/api/projects/:id/activate", (c) => {
    const id = c.req.param("id");
    const result = store.transitionStatus(id, "active");
    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          code: result.code,
          message: result.message,
        },
        result.status,
      );
    }
    if (wantsHtml(c.req.raw)) {
      return c.redirect(`/projects/${id}`, 303);
    }
    return c.json({ data: result.data });
  });

  app.post("/api/projects/:id/archive", (c) => {
    const id = c.req.param("id");
    const result = store.transitionStatus(id, "archived");
    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          code: result.code,
          message: result.message,
        },
        result.status,
      );
    }
    if (wantsHtml(c.req.raw)) {
      return c.redirect(`/projects/${id}`, 303);
    }
    return c.json({ data: result.data });
  });

  // Destructive action: Delete project
  const handleDeleteProject = (c: Context): Response => {
    const id = c.req.param("id") ?? "";
    const result = store.deleteProject(id);
    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          code: result.code,
          message: result.message,
        },
        result.status,
      );
    }
    if (wantsHtml(c.req.raw)) {
      return c.redirect("/projects", 303);
    }
    return c.json({ data: result.data });
  };

  app.delete("/api/projects/:id", handleDeleteProject);
  app.post("/api/projects/:id/delete", handleDeleteProject);

  app.notFound((c) => {
    if ((c.req.header("accept") ?? "").includes("application/json")) {
      return c.json(
        { error: "NOT_FOUND", code: "NOT_FOUND", message: "Rota não encontrada." },
        404,
      );
    }
    return c.html(renderNotFoundPage(c.req.path), 404);
  });

  return { app, store };
}
