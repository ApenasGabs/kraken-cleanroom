import { describe, expect, it } from "vitest";
import { DestructiveActionError, MethodNotAllowedError, OutOfScopeError } from "./errors.js";
import { parseManifestObject } from "./manifest.js";
import { createScopeGuard, parseRobotsTxt } from "./scope-guard.js";

function createTestManifest(overrides?: Record<string, unknown>) {
  return parseManifestObject({
    version: 1,
    job: {
      name: "guard-test",
    },
    target: {
      url: "https://demo.playwright.dev/todomvc/",
      type: "web-spa",
      allowedOrigins: ["https://demo.playwright.dev"],
    },
    ownership: "third-party",
    authorization: {
      basis: "Ambiente de testes automatizados para validação do ScopeGuard.",
      tosReviewed: true,
    },
    ...overrides,
  });
}

describe("ScopeGuard", () => {
  it("17. assertMethod permite métodos habilitados e lança MethodNotAllowedError para desabilitados", () => {
    const manifest = createTestManifest({
      methods: {
        behavioralUi: true,
        networkHar: true,
        binaryAnalysis: false,
        sourceRepo: false,
      },
    });
    const guard = createScopeGuard(manifest);

    expect(() => guard.assertMethod("behavioralUi")).not.toThrow();
    expect(() => guard.assertMethod("networkHar")).not.toThrow();

    try {
      guard.assertMethod("binaryAnalysis");
      expect.unreachable("Deveria ter lançado MethodNotAllowedError");
    } catch (err) {
      expect(err).toBeInstanceOf(MethodNotAllowedError);
      const methodErr = err as MethodNotAllowedError;
      expect(methodErr.code).toBe("METHOD_NOT_ALLOWED");
      expect(methodErr.method).toBe("binaryAnalysis");
    }
  });

  it("18. canNavigate permite URLs dentro de allowedOrigins e bloqueia origens externas ou protocolos inválidos", () => {
    const guard = createScopeGuard(createTestManifest());

    expect(guard.canNavigate("https://demo.playwright.dev/todomvc/active")).toBe(true);
    expect(guard.canNavigate("/todomvc/completed")).toBe(true);
    expect(guard.canNavigate("https://evil.example.com/todomvc")).toBe(false);
    expect(guard.canNavigate("javascript:alert(1)")).toBe(false);
    expect(guard.canNavigate("mailto:contato@example.com")).toBe(false);

    expect(() => guard.assertCanNavigate("https://evil.example.com/")).toThrowError(
      OutOfScopeError,
    );
  });

  it("19. canNavigate bloqueia todos os forbiddenPaths padrão (logout, delete*, admin/**, checkout/**) mesmo com URL encoding", () => {
    const manifest = createTestManifest({
      limits: {
        forbiddenPaths: ["**/custom-secret/**"],
      },
    });
    const guard = createScopeGuard(manifest);

    expect(guard.canNavigate("https://demo.playwright.dev/logout")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/auth/logout")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/auth/%6Cogout")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/projects/delete-all")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/admin/users")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/admin")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/checkout/step-1")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/app/custom-secret/settings")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/projects/123")).toBe(true);
  });

  it("20. canNavigate respeita regras de robots.txt (Disallow, Allow mais específico, wildcard *) quando respectRobotsTxt === true", () => {
    const robotsTxt = `
User-agent: *
Disallow: /private/
Disallow: /api/internal*
Allow: /private/public-doc
`;
    const manifest = createTestManifest({
      limits: {
        respectRobotsTxt: true,
      },
    });
    const guard = createScopeGuard(manifest, { robotsTxt });

    expect(guard.canNavigate("https://demo.playwright.dev/private/dashboard")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/private/public-doc")).toBe(true);
    expect(guard.canNavigate("https://demo.playwright.dev/api/internal/metrics")).toBe(false);
    expect(guard.canNavigate("https://demo.playwright.dev/help")).toBe(true);
  });

  it("21. canNavigate ignora bloqueios do robots.txt quando respectRobotsTxt === false, mantendo forbiddenPaths ativos", () => {
    const robotsTxt = `
User-agent: *
Disallow: /private/
`;
    const manifest = createTestManifest({
      limits: {
        respectRobotsTxt: false,
      },
    });
    const guard = createScopeGuard(manifest, { robotsTxt });

    expect(guard.canNavigate("https://demo.playwright.dev/private/dashboard")).toBe(true);
    // forbiddenPaths continua ativo mesmo se respectRobotsTxt for false
    expect(guard.canNavigate("https://demo.playwright.dev/admin/settings")).toBe(false);
  });

  it("22. parseRobotsTxt prioriza grupo específico do User-Agent sobre User-agent: *", () => {
    const robotsTxt = `
User-agent: *
Disallow: /

User-agent: kraken-cleanroom
Disallow: /secret-area
Allow: /
`;
    const policy = parseRobotsTxt(robotsTxt, "kraken-cleanroom/0.1");
    expect(policy.disallow).toEqual(["/secret-area"]);
    expect(policy.allow).toEqual(["/"]);
  });

  it("23. isDestructive detecta ações destrutivas em pt-BR e en (case-insensitive) e rotas destrutivas", () => {
    const guard = createScopeGuard(createTestManifest());

    const destructiveSamples = [
      "Excluir projeto",
      "DELETAR CONTA",
      "Remover membro",
      "Apagar registro",
      "Cancelar assinatura agora",
      "Delete item",
      "Remove user",
      "Destroy workspace",
      "Unsubscribe from plan",
      "Sair da conta",
      "Logout",
      "Sign out",
      "Publicar artigo",
      "Publish release",
      "Enviar convite para equipe",
      "Invite member",
      "Pagar fatura",
      "Pay now",
      "Comprar créditos",
      "Buy plan",
      "Ir para Checkout",
      "/api/projects/12/delete",
      "",
    ];

    for (const sample of destructiveSamples) {
      expect(guard.isDestructive(sample), `Esperava destrutivo para: "${sample}"`).toBe(true);
    }

    const safeSamples = [
      "Salvar rascunho",
      "Filtrar projetos",
      "Ver detalhes",
      "Próxima página",
      "Criar novo rascunho",
      "Abrir configurações",
      "Pesquisar tarefas",
      " Visualizar ",
    ];

    for (const sample of safeSamples) {
      expect(guard.isDestructive(sample), `Esperava seguro para: "${sample}"`).toBe(false);
    }

    expect(() => guard.assertNotDestructive("Excluir projeto")).toThrowError(
      DestructiveActionError,
    );
    expect(() => guard.assertNotDestructive("Ver detalhes")).not.toThrow();
  });

  it("24. throttle() aplica token bucket respeitando rateLimitRps de forma determinística", async () => {
    let fakeNowMs = 1_000_000;
    const sleepCalls: number[] = [];

    const manifest = createTestManifest({
      limits: {
        rateLimitRps: 2, // 2 req/s => 1 token a cada 500ms
      },
    });

    const guard = createScopeGuard(manifest, {
      now: () => fakeNowMs,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        fakeNowMs += ms;
      },
    });

    // 1ª chamada consome o token inicial imediatamente (0ms de espera)
    await guard.throttle();
    expect(sleepCalls).toEqual([]);

    // 2ª chamada no mesmo instante precisa aguardar 500ms
    await guard.throttle();
    expect(sleepCalls).toEqual([500]);

    // Avança 200ms no relógio; 3ª chamada precisa aguardar apenas os 300ms restantes
    fakeNowMs += 200;
    await guard.throttle();
    expect(sleepCalls).toEqual([500, 300]);

    // Avança 1000ms (>= 500ms); balde recarrega 1 token completo, próxima chamada não dorme
    fakeNowMs += 1000;
    await guard.throttle();
    expect(sleepCalls).toEqual([500, 300]);
  });
});
