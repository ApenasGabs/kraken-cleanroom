import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManifestError } from "./errors.js";
import {
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_REPORT_VIEWPORTS,
  REPORT_SECTIONS,
  loadManifest,
  parseManifestObject,
  parseManifestYaml,
} from "./manifest.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EXAMPLE_MANIFEST_PATH = resolve(__dirname, "../../../examples/cleanroom.example.yaml");

function createValidBaseInput() {
  return {
    version: 1 as const,
    job: {
      name: "demo-study",
      description: "Estudo funcional em clean room.",
      goals: ["Quais são as regras de validação de projetos?"],
    },
    target: {
      url: "https://demo.playwright.dev/todomvc/",
      type: "web-spa" as const,
    },
    ownership: "third-party" as const,
    authorization: {
      basis: "Site público criado para prática de testes automatizados.",
      tosReviewed: true,
      evidence: null,
    },
  };
}

describe("manifestSchema & loadManifest", () => {
  it("1. valida examples/cleanroom.example.yaml sem erros e mescla defaults", async () => {
    const manifest = await loadManifest(EXAMPLE_MANIFEST_PATH);

    expect(manifest.version).toBe(1);
    expect(manifest.job.name).toBe("todomvc-demo");
    expect(manifest.target.url).toBe("https://demo.playwright.dev/todomvc/");
    expect(manifest.target.allowedOrigins).toEqual(["https://demo.playwright.dev"]);
    expect(manifest.ownership).toBe("third-party");
    expect(manifest.authorization.tosReviewed).toBe(true);
    expect(manifest.limits.forbiddenPaths).toEqual(
      expect.arrayContaining([...DEFAULT_FORBIDDEN_PATHS]),
    );
    expect(manifest.accounts.strategy).toBe("none");
    expect(manifest.report.language).toBe("pt-BR");
    expect(manifest.report.viewports).toEqual(DEFAULT_REPORT_VIEWPORTS);
  });

  it("2. preenche todos os defaults quando apenas campos obrigatórios são fornecidos", () => {
    const manifest = parseManifestObject(createValidBaseInput());

    expect(manifest.target.allowedOrigins).toEqual(["https://demo.playwright.dev"]);
    expect(manifest.target.docsUrls).toEqual([]);
    expect(manifest.methods).toEqual({
      behavioralUi: true,
      networkHar: true,
      publicDocs: true,
      staticBundles: true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    });
    expect(manifest.limits.maxPages).toBe(150);
    expect(manifest.limits.maxDepth).toBe(6);
    expect(manifest.limits.maxDurationMin).toBe(60);
    expect(manifest.limits.rateLimitRps).toBe(1);
    expect(manifest.limits.maxAccounts).toBe(0);
    expect(manifest.limits.destructiveActions).toBe(false);
    expect(manifest.limits.formSubmission).toBe("validation-only");
    expect(manifest.limits.respectRobotsTxt).toBe(true);
    expect(manifest.limits.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);
    expect(manifest.accounts).toEqual({
      strategy: "none",
      identity: "owner",
    });
    expect(manifest.humanInTheLoop).toEqual({
      captcha: "handoff",
      smsOtp: "handoff",
      payments: "abort",
      handoffTimeoutMin: 30,
    });
    expect(manifest.cleanup).toEqual({
      deleteAccountAtEnd: true,
      purgeHarSecrets: true,
      retainDays: 90,
    });
    expect(manifest.report.include).toEqual([...REPORT_SECTIONS]);
  });

  it("3. permite http://localhost(:port) e http://127.0.0.1(:port) quando ownership === 'own'", () => {
    const localOwn = parseManifestObject({
      ...createValidBaseInput(),
      ownership: "own",
      target: {
        url: "http://127.0.0.1:4321/projects",
        type: "web-ssr",
      },
      authorization: {
        basis: "Aplicação local demo-app própria para testes de integração.",
        tosReviewed: false,
      },
    });

    expect(localOwn.target.allowedOrigins).toEqual(["http://127.0.0.1:4321"]);

    const localhostOwn = parseManifestObject({
      ...createValidBaseInput(),
      ownership: "own",
      target: {
        url: "http://localhost:3000",
      },
    });
    expect(localhostOwn.target.allowedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("4. rejeita http:// mesmo em localhost quando ownership é 'third-party' ou 'client-authorized'", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "third-party",
        target: {
          url: "http://localhost:3000",
        },
      }),
    ).toThrowError(ManifestError);

    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "client-authorized",
        target: {
          url: "http://example.com",
        },
        authorization: {
          basis: "Autorização formal do cliente.",
          tosReviewed: true,
          evidence: "Contrato #2026-01",
        },
      }),
    ).toThrow(/https:\/\//);
  });

  it("5. rejeita http:// em domínio remoto mesmo quando ownership é 'own'", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "own",
        target: {
          url: "http://meu-app-remoto.com.br",
        },
      }),
    ).toThrow(/localhost ou 127\.0\.0\.1/);
  });

  it("6. Regra cruzada #1: ownership == third-party exige authorization.tosReviewed == true", () => {
    try {
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "third-party",
        authorization: {
          basis: "Estudo exploratório de app público.",
          tosReviewed: false,
        },
      });
      expect.unreachable("Deveria ter lançado ManifestError");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      const manifestErr = err as ManifestError;
      expect(manifestErr.code).toBe("MANIFEST_INVALID");
      expect(manifestErr.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "authorization.tosReviewed",
            message: expect.stringMatching(/tosReviewed deve ser obrigatoriamente true/),
          }),
        ]),
      );
    }
  });

  it("7. Regra cruzada #2: methods.binaryAnalysis == true exige ownership == own", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "third-party",
        methods: {
          binaryAnalysis: true,
        },
      }),
    ).toThrow(/methods\.binaryAnalysis só é permitido quando ownership é "own"/);

    const validOwnBinary = parseManifestObject({
      ...createValidBaseInput(),
      ownership: "own",
      methods: {
        binaryAnalysis: true,
      },
    });
    expect(validOwnBinary.methods.binaryAnalysis).toBe(true);
  });

  it("8. Regra cruzada #3: ownership == client-authorized exige authorization.evidence não vazio", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "client-authorized",
        authorization: {
          basis: "Auditoria contratada pelo cliente Acme.",
          tosReviewed: true,
          evidence: "   ",
        },
      }),
    ).toThrow(/authorization\.evidence deve ser preenchido/);

    const validClientAuth = parseManifestObject({
      ...createValidBaseInput(),
      ownership: "client-authorized",
      authorization: {
        basis: "Auditoria contratada pelo cliente Acme.",
        tosReviewed: true,
        evidence: "OS-9941 assinada em 2026-11-01",
      },
    });
    expect(validClientAuth.authorization.evidence).toBe("OS-9941 assinada em 2026-11-01");
  });

  it("9. Regra cruzada #4: methods.authenticatedSession == true exige accounts.strategy != none", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        methods: {
          authenticatedSession: true,
        },
        accounts: {
          strategy: "none",
        },
      }),
    ).toThrow(/accounts\.strategy não pode ser "none"/);

    const validProvided = parseManifestObject({
      ...createValidBaseInput(),
      methods: {
        authenticatedSession: true,
      },
      accounts: {
        strategy: "provided",
        credentialRef: "vault://cleanroom/demo",
      },
    });
    expect(validProvided.accounts.strategy).toBe("provided");
  });

  it("10. Regra cruzada #5: accounts.strategy == signup exige limits.maxAccounts == 1", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        methods: {
          authenticatedSession: true,
        },
        accounts: {
          strategy: "signup",
        },
        limits: {
          maxAccounts: 0,
        },
      }),
    ).toThrow(/limits\.maxAccounts deve ser exatamente 1/);

    const validSignup = parseManifestObject({
      ...createValidBaseInput(),
      methods: {
        authenticatedSession: true,
      },
      accounts: {
        strategy: "signup",
      },
      limits: {
        maxAccounts: 1,
      },
    });
    expect(validSignup.limits.maxAccounts).toBe(1);
  });

  it("11. Regra cruzada #6: target.url deve estar em target.allowedOrigins", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        target: {
          url: "https://demo.playwright.dev/todomvc/",
          allowedOrigins: ["https://outro-dominio.example.com"],
        },
      }),
    ).toThrow(/deve estar contida em target\.allowedOrigins/);
  });

  it("12. Regra cruzada #7: forbiddenPaths padrão é sempre mesclado (impossível remover **/logout)", () => {
    const manifestWithEmptyForbidden = parseManifestObject({
      ...createValidBaseInput(),
      limits: {
        forbiddenPaths: [],
      },
    });
    expect(manifestWithEmptyForbidden.limits.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);

    const manifestWithCustomForbidden = parseManifestObject({
      ...createValidBaseInput(),
      limits: {
        forbiddenPaths: ["**/billing/**", "**/internal/**"],
      },
    });
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/logout");
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/delete*");
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/admin/**");
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/checkout/**");
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/billing/**");
    expect(manifestWithCustomForbidden.limits.forbiddenPaths).toContain("**/internal/**");
  });

  it("13. valida target.type === 'repo' exigindo target.repo e dispensando target.url", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        ownership: "own",
        target: {
          type: "repo",
        },
      }),
    ).toThrow(/target\.repo é obrigatório/);

    const repoManifest = parseManifestObject({
      ...createValidBaseInput(),
      ownership: "own",
      target: {
        type: "repo",
        repo: "ApenasGabs/kraken-cleanroom",
      },
      methods: {
        sourceRepo: true,
      },
    });
    expect(repoManifest.target.repo).toBe("ApenasGabs/kraken-cleanroom");
    expect(repoManifest.target.allowedOrigins).toEqual([]);
  });

  it("14. bloqueia valores 'auto' em humanInTheLoop (captcha, smsOtp, payments)", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        humanInTheLoop: {
          captcha: "auto",
        },
      }),
    ).toThrow(/humanInTheLoop\.captcha deve ser "handoff" ou "abort"/);

    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        humanInTheLoop: {
          payments: "auto",
        },
      }),
    ).toThrow(/humanInTheLoop\.payments deve ser "require-approval" ou "abort"/);
  });

  it("15. valida limites numéricos e formato de job.name (slug)", () => {
    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        job: {
          name: "Nome Com Espacos!",
        },
      }),
    ).toThrow(/slug válido/);

    expect(() =>
      parseManifestObject({
        ...createValidBaseInput(),
        limits: {
          rateLimitRps: 25,
          maxAccounts: 2,
        },
      }),
    ).toThrow(ManifestError);
  });

  it("16. loadManifest suporta string YAML inline, trata sintaxe inválida e enforcePhase1Execution", async () => {
    const inlineYaml = `
version: 1
job:
  name: inline-yaml-test
target:
  url: https://demo.playwright.dev/todomvc/
  type: web-spa
ownership: third-party
authorization:
  basis: Teste unitário com YAML inline válido.
  tosReviewed: true
`;
    const parsed = await loadManifest(inlineYaml);
    expect(parsed.job.name).toBe("inline-yaml-test");

    expect(() => parseManifestYaml("version: [unclosed")).toThrow(/Erro de sintaxe YAML/);
    await expect(loadManifest("/caminho/inexistente/cleanroom.yaml")).rejects.toThrow(
      /Não foi possível ler o arquivo/,
    );

    const phase2Input = {
      ...createValidBaseInput(),
      methods: { authenticatedSession: true },
      accounts: { strategy: "provided" as const, credentialRef: "ref-1" },
    };
    expect(() => parseManifestObject(phase2Input, { enforcePhase1Execution: true })).toThrow(
      /só é executável a partir da Fase 2/,
    );
  });
});
