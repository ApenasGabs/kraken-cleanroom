import { afterEach, describe, expect, it } from "vitest";
import { type DemoServer, createDemoApp, startDemoServer } from "./index.js";

describe("fixtures/demo-app", () => {
  let runningServer: DemoServer | undefined;

  afterEach(async () => {
    if (runningServer) {
      await runningServer.close();
      runningServer = undefined;
    }
  });

  it("starts and stops programmatically on an ephemeral port via startDemoServer()", async () => {
    runningServer = await startDemoServer(0);
    expect(runningServer.port).toBeGreaterThan(0);
    expect(runningServer.baseUrl).toBe(`http://localhost:${runningServer.port}`);
    expect(runningServer.getCreatedProjectsCount()).toBe(0);

    const homeRes = await fetch(`${runningServer.baseUrl}/`);
    expect(homeRes.status).toBe(200);
    const html = await homeRes.text();
    expect(html).toContain("Gestão Simplificada de Projetos");
    expect(html).toContain("/static/app.js");

    const statsRes = await fetch(`${runningServer.baseUrl}/api/projects/stats`);
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as {
      createdProjectsCount: number;
      adminVisitsCount: number;
    };
    expect(stats.createdProjectsCount).toBe(0);
    expect(stats.adminVisitsCount).toBe(0);
  });

  it("serves paginated projects via GET /api/projects?page= and HTML /projects", async () => {
    const { app } = createDemoApp();

    const page1Res = await app.request("http://localhost/api/projects?page=1");
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: Array<{ id: string; status: string }>;
      meta: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
        hasNextPage: boolean;
      };
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.id).toBe("proj-1");
    expect(page1.items[0]?.status).toBe("draft");
    expect(page1.items[1]?.id).toBe("proj-2");
    expect(page1.items[1]?.status).toBe("active");
    expect(page1.meta).toMatchObject({
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
      hasNextPage: true,
    });

    const page2Res = await app.request("http://localhost/api/projects?page=2");
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      items: Array<{ id: string; status: string }>;
      meta: { page: number; hasNextPage: boolean };
    };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe("proj-3");
    expect(page2.items[0]?.status).toBe("archived");
    expect(page2.meta.hasNextPage).toBe(false);

    const htmlListRes = await app.request("http://localhost/projects?page=1");
    expect(htmlListRes.status).toBe(200);
    const listHtml = await htmlListRes.text();
    expect(listHtml).toContain("Portal do Cliente");
    expect(listHtml).toContain("Motor de Faturamento");
  });

  it("renders status-dependent action buttons on /projects/:id and enforces transitions", async () => {
    const { app } = createDemoApp();

    // 1. Draft project has Activate, Archive, and Delete buttons
    const draftHtmlRes = await app.request("http://localhost/projects/proj-1");
    expect(draftHtmlRes.status).toBe(200);
    const draftHtml = await draftHtmlRes.text();
    expect(draftHtml).toContain("Ativar projeto");
    expect(draftHtml).toContain("Arquivar projeto");
    expect(draftHtml).toContain("Excluir projeto");

    // 2. Active project has Archive and Export Pro, but no Activate or Delete
    const activeHtmlRes = await app.request("http://localhost/projects/proj-2");
    expect(activeHtmlRes.status).toBe(200);
    const activeHtml = await activeHtmlRes.text();
    expect(activeHtml).toContain("Arquivar projeto");
    expect(activeHtml).toContain("Exportar relatório Pro");
    expect(activeHtml).not.toContain("Ativar projeto");
    expect(activeHtml).not.toContain("Excluir projeto");

    // 3. Archived project is read-only
    const archivedHtmlRes = await app.request("http://localhost/projects/proj-3");
    expect(archivedHtmlRes.status).toBe(200);
    const archivedHtml = await archivedHtmlRes.text();
    expect(archivedHtml).toContain("somente leitura");
    expect(archivedHtml).not.toContain("Ativar projeto");
    expect(archivedHtml).not.toContain("Arquivar projeto");
    expect(archivedHtml).not.toContain("Excluir projeto");

    // 4. Transition draft -> active succeeds, archived -> active fails with 409
    const activateDraftRes = await app.request("http://localhost/api/projects/proj-1/activate", {
      method: "POST",
    });
    expect(activateDraftRes.status).toBe(200);
    const activatedBody = (await activateDraftRes.json()) as { data: { status: string } };
    expect(activatedBody.data.status).toBe("active");

    const activateArchivedRes = await app.request("http://localhost/api/projects/proj-3/activate", {
      method: "POST",
    });
    expect(activateArchivedRes.status).toBe(409);
  });

  it("validates POST /api/projects (400/422) without incrementing createdProjectsCount", async () => {
    const fixedNow = () => new Date("2026-06-01T12:00:00.000Z");
    const { app, store } = createDemoApp({ now: fixedNow });

    // Missing required name -> 400
    const missingNameRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", budget: 1000, targetDate: "2026-12-01" }),
    });
    expect(missingNameRes.status).toBe(400);

    // Name too short (< 3 chars) -> 422
    const shortNameRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "AB", budget: 1000, targetDate: "2026-12-01" }),
    });
    expect(shortNameRes.status).toBe(422);
    const shortNameBody = (await shortNameRes.json()) as { code: string };
    expect(shortNameBody.code).toBe("NAME_LENGTH_INVALID");

    // Name too long (> 60 chars) -> 422
    const longNameRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "X".repeat(61),
        budget: 1000,
        targetDate: "2026-12-01",
      }),
    });
    expect(longNameRes.status).toBe(422);

    // Negative budget -> 422
    const negativeBudgetRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Projeto Válido", budget: -10, targetDate: "2026-12-01" }),
    });
    expect(negativeBudgetRes.status).toBe(422);
    const negBudgetBody = (await negativeBudgetRes.json()) as { code: string };
    expect(negBudgetBody.code).toBe("BUDGET_MIN_ZERO");

    // Past or today targetDate -> 422
    const pastDateRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Projeto Válido", budget: 500, targetDate: "2026-06-01" }),
    });
    expect(pastDateRes.status).toBe(422);
    const pastDateBody = (await pastDateRes.json()) as { code: string };
    expect(pastDateBody.code).toBe("TARGET_DATE_MUST_BE_FUTURE");

    // Counter must remain 0 after all validation probes
    expect(store.getCreatedProjectsCount()).toBe(0);
    expect(store.getStats().validationFailuresCount).toBe(5);
  });

  it("enforces Free plan limit of 3 non-archived projects and allows unlimited on Pro", async () => {
    const fixedNow = () => new Date("2026-06-01T12:00:00.000Z");
    const { app, store } = createDemoApp({ now: fixedNow });

    // Seed has 2 non-archived projects (proj-1 draft, proj-2 active) + 1 archived (proj-3).
    // Creating 3rd non-archived project on Free plan succeeds (201):
    const validRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Terceiro Projeto Ativo",
        budget: 2500,
        targetDate: "2026-10-15",
      }),
    });
    expect(validRes.status).toBe(201);
    expect(store.getCreatedProjectsCount()).toBe(1);

    // Attempting a 4th non-archived project on Free plan fails with 422 PLAN_LIMIT_REACHED:
    const limitReachedRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Quarto Projeto Bloqueado",
        budget: 3000,
        targetDate: "2026-11-20",
      }),
    });
    expect(limitReachedRes.status).toBe(422);
    const limitBody = (await limitReachedRes.json()) as { code: string };
    expect(limitBody.code).toBe("PLAN_LIMIT_REACHED");
    expect(store.getCreatedProjectsCount()).toBe(1);

    // Using Pro plan header allows exceeding the Free limit:
    const proRes = await app.request("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-plan": "pro",
      },
      body: JSON.stringify({
        name: "Quarto Projeto no Pro",
        budget: 9000,
        targetDate: "2026-11-20",
      }),
    });
    expect(proRes.status).toBe(201);
    expect(store.getCreatedProjectsCount()).toBe(2);
  });

  it("serves /pricing, /help (3 articles), /robots.txt, /sitemap.xml, /static/app.js and /admin (403)", async () => {
    const { app, store } = createDemoApp();

    const pricingRes = await app.request("http://localhost/pricing");
    expect(pricingRes.status).toBe(200);
    const pricingHtml = await pricingRes.text();
    expect(pricingHtml).toContain("Plano Free");
    expect(pricingHtml).toContain("até 3 projetos");
    expect(pricingHtml).toContain("Plano Pro");
    expect(pricingHtml).toContain("projetos ilimitados");

    const helpRes = await app.request("http://localhost/help");
    expect(helpRes.status).toBe(200);
    const helpHtml = await helpRes.text();
    const h2Matches = helpHtml.match(/<h2>/g) ?? [];
    expect(h2Matches.length).toBe(3);

    const robotsRes = await app.request("http://localhost/robots.txt");
    expect(robotsRes.status).toBe(200);
    const robotsTxt = await robotsRes.text();
    expect(robotsTxt).toContain("Disallow: /admin");
    expect(robotsTxt).toContain("Sitemap: http://localhost/sitemap.xml");

    const sitemapRes = await app.request("http://localhost/sitemap.xml");
    expect(sitemapRes.status).toBe(200);
    const sitemapXml = await sitemapRes.text();
    expect(sitemapXml).toContain("<loc>http://localhost/projects</loc>");
    expect(sitemapXml).toContain("<loc>http://localhost/pricing</loc>");
    expect(sitemapXml).toContain("<loc>http://localhost/help</loc>");
    expect(sitemapXml).not.toContain("/admin");

    const bundleRes = await app.request("http://localhost/static/app.js");
    expect(bundleRes.status).toBe(200);
    const bundleJs = await bundleRes.text();
    expect(bundleJs).toContain('path: "/projects/new"');
    expect(bundleJs).toContain('isEnabled("pro_export")');
    expect(bundleJs).toContain("projects.validation.name_length");

    const adminRes = await app.request("http://localhost/admin");
    expect(adminRes.status).toBe(403);
    expect(store.getStats().adminVisitsCount).toBe(1);
  });
});
