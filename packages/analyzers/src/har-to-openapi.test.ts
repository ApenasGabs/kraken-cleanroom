import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceStore,
  FakeLlmClient,
  type HarEntry,
  type HarLog,
  type JobRecord,
  type Manifest,
  MethodNotAllowedError,
  type PhaseContext,
  type SqliteDatabase,
  createEvidenceStore,
  createLogger,
  createScopeGuard,
  openDatabase,
  parseManifestObject,
} from "@cleanroom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarToOpenApiPhase,
  extractSafeEnumsFromJson,
  harToOpenApi,
  isStandardErrorShape,
  normalizeOpenApiPathTemplate,
  serializeOpenApiYaml,
  validateOpenApiDocument,
} from "./har-to-openapi.js";

interface DemoAppModule {
  createDemoApp(): {
    app: {
      fetch(request: Request): Response | Promise<Response>;
    };
    store: {
      getStats(): {
        adminVisitsCount: number;
      };
    };
  };
}

const DEMO_ORIGIN = "https://demo.cleanroom.test";

function buildManifest(overrides?: { networkHar?: boolean }): Manifest {
  return parseManifestObject({
    version: 1,
    job: {
      name: "demo-har-to-openapi-test",
      description: "Estudo clean-room da fixture demo-app para validação do harToOpenApi",
      goals: ["Inferir contrato OpenAPI 3.1 a partir do tráfego e evidências de rede"],
    },
    target: {
      url: DEMO_ORIGIN,
      type: "web-ssr",
      allowedOrigins: [DEMO_ORIGIN],
      docsUrls: [`${DEMO_ORIGIN}/help`],
    },
    ownership: "own",
    authorization: {
      basis: "Aplicação de demonstração própria do repositório para testes automatizados.",
      tosReviewed: true,
      evidence: null,
    },
    methods: {
      behavioralUi: true,
      networkHar: overrides?.networkHar ?? true,
      publicDocs: true,
      staticBundles: true,
      binaryAnalysis: false,
      sourceRepo: false,
      authenticatedSession: false,
    },
    limits: {
      maxPages: 30,
      maxDepth: 3,
      maxDurationMin: 10,
      rateLimitRps: 5,
      maxAccounts: 0,
      forbiddenPaths: ["/admin", "**/admin/**", "**/logout"],
      destructiveActions: false,
      formSubmission: "validation-only",
      respectRobotsTxt: true,
    },
    accounts: {
      strategy: "none",
    },
    humanInTheLoop: {
      captcha: "abort",
      smsOtp: "abort",
      payments: "abort",
      handoffTimeoutMin: 5,
    },
    cleanup: {
      deleteAccountAtEnd: false,
      purgeHarSecrets: true,
      retainDays: 30,
    },
    report: {
      language: "pt-BR",
      viewports: [[1440, 900]],
    },
  });
}

async function recordDemoCallToHarEntry(
  fetchFn: (req: Request) => Response | Promise<Response>,
  params: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  },
): Promise<HarEntry> {
  const url = `${DEMO_ORIGIN}${params.path}`;
  const reqHeaders: Record<string, string> = {
    accept: "application/json",
    ...(params.body ? { "content-type": "application/json" } : {}),
    ...params.headers,
  };
  const bodyText = params.body ? JSON.stringify(params.body) : undefined;
  const req = new Request(url, {
    method: params.method,
    headers: reqHeaders,
    ...(bodyText ? { body: bodyText } : {}),
  });

  const res = await fetchFn(req);
  const resText = await res.text();
  const parsedUrl = new URL(url);
  const queryString: Array<{ name: string; value: string }> = [];
  parsedUrl.searchParams.forEach((value, name) => {
    queryString.push({ name, value });
  });

  const resHeaders: Array<{ name: string; value: string }> = [];
  res.headers.forEach((value, name) => {
    resHeaders.push({ name, value });
  });

  return {
    _resourceType: "fetch",
    startedDateTime: new Date().toISOString(),
    time: 12,
    request: {
      method: params.method.toUpperCase(),
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
      queryString,
      ...(bodyText
        ? {
            postData: {
              mimeType: "application/json",
              text: bodyText,
            },
          }
        : {}),
      headersSize: -1,
      bodySize: bodyText ? Buffer.byteLength(bodyText, "utf8") : 0,
    },
    response: {
      status: res.status,
      statusText:
        res.statusText || (res.status === 200 ? "OK" : res.status === 201 ? "Created" : ""),
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: resHeaders,
      content: {
        size: Buffer.byteLength(resText, "utf8"),
        mimeType: res.headers.get("content-type") ?? "application/json",
        text: resText,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(resText, "utf8"),
    },
    cache: {},
    timings: { send: 1, wait: 8, receive: 3 },
  };
}

describe("harToOpenApi (@cleanroom/analyzers - F1-08)", () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let evidenceStore: EvidenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cleanroom-har-to-openapi-"));
    db = openDatabase({ dataDir: tempDir });
    evidenceStore = createEvidenceStore({ db, dataDir: tempDir });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestContext(
    manifest: Manifest,
    opts?: {
      checkpoint?: unknown;
      onSaveCheckpoint?: (cp: unknown) => void;
    },
  ): PhaseContext {
    const nowIso = new Date().toISOString();
    const job: JobRecord = {
      id: "job_test_f1_08",
      name: manifest.job.name,
      state: "running",
      manifest,
      createdAt: nowIso,
      updatedAt: nowIso,
      llmTokensIn: 0,
      llmTokensOut: 0,
    };
    const guard = createScopeGuard(manifest, {
      sleep: async () => undefined,
    });

    return {
      job,
      manifest,
      guard,
      evidence: evidenceStore,
      llm: new FakeLlmClient(),
      log: createLogger({ level: "silent" }),
      signal: new AbortController().signal,
      checkpoint: opts?.checkpoint,
      saveCheckpoint: (cp) => {
        opts?.onSaveCheckpoint?.(cp);
      },
      emit: () => undefined,
    };
  }

  it("gera openapi.yaml OpenAPI 3.1.0 válido a partir de HAR/evidências da fixtures/demo-app com GET /api/projects paginado, POST /api/projects, GET /api/projects/{id} com enum status (draft|active|archived) e x-cleanroom-evidence", async () => {
    const demoModuleUrl = new URL("../../../fixtures/demo-app/src/index.ts", import.meta.url).href;
    const { createDemoApp } = (await import(demoModuleUrl)) as DemoAppModule;
    const demo = createDemoApp();

    const entries: HarEntry[] = [
      // Lista paginada (páginas 1 e 2)
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects?page=1",
        headers: { authorization: "Bearer demo-session-token" },
      }),
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects?page=2",
        headers: { authorization: "Bearer demo-session-token" },
      }),
      // Detalhe de projetos cobrindo os 3 estados (draft, active, archived) + 404
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects/proj-1",
      }),
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects/proj-2",
      }),
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects/proj-3",
      }),
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/api/projects/proj-999",
      }),
      // Criação de projeto (probe inválido 400 + criação válida 201 com plano pro)
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "POST",
        path: "/api/projects",
        body: { name: "", budget: -10, targetDate: "2020-01-01" },
      }),
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "POST",
        path: "/api/projects?plan=pro",
        body: {
          name: "Projeto Cleanroom OpenAPI",
          budget: 25000,
          targetDate: "2099-12-31",
        },
      }),
      // Rota proibida (/admin) que deve ser filtrada pelo ScopeGuard
      await recordDemoCallToHarEntry((r) => demo.app.fetch(r), {
        method: "GET",
        path: "/admin",
      }),
    ];

    const harLog: HarLog = {
      log: {
        version: "1.2",
        creator: { name: "cleanroom-test", version: "0.1.0" },
        entries,
      },
    };

    const manifest = buildManifest();
    const savedCheckpoints: unknown[] = [];
    const ctx = createTestContext(manifest, {
      onSaveCheckpoint: (cp) => savedCheckpoints.push(cp),
    });

    const result = await harToOpenApi(ctx, { har: harLog });

    expect(result.skipped).toBe(false);
    expect(result.outputPath).toBeDefined();
    expect(result.outputPath).toContain(join("jobs", ctx.job.id, "analysis", "openapi.yaml"));
    expect(existsSync(result.outputPath ?? "")).toBe(true);

    // 1. Valida conformidade estrutural OpenAPI 3.1.0
    const validation = validateOpenApiDocument(result.document);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(result.document.openapi).toBe("3.1.0");

    // 2. Verifica que /admin nunca entrou no contrato OpenAPI
    expect(result.document.paths["/admin"]).toBeUndefined();

    // 3. Verifica GET /api/projects paginado (page) e x-cleanroom-evidence
    const getProjects = result.document.paths["/api/projects"]?.get;
    expect(getProjects).toBeDefined();
    expect(getProjects?.["x-cleanroom-evidence"].length).toBeGreaterThanOrEqual(2);
    for (const evId of getProjects?.["x-cleanroom-evidence"] ?? []) {
      expect(evId).toMatch(/^ev_/);
      expect(evidenceStore.get(ctx.job.id, evId)).not.toBeNull();
    }

    const pageParam = getProjects?.parameters?.find((p) => p.name === "page" && p.in === "query");
    expect(pageParam).toBeDefined();
    expect(pageParam?.schema.type).toBe("integer");
    expect(pageParam?.["x-cleanroom-pagination"]).toBe(true);
    expect(getProjects?.["x-cleanroom-pagination"]?.parameters).toContain("page");

    // 4. Verifica POST /api/projects com requestBody, 201, 400 e x-cleanroom-evidence
    const postProjects = result.document.paths["/api/projects"]?.post;
    expect(postProjects).toBeDefined();
    expect(postProjects?.["x-cleanroom-evidence"].length).toBeGreaterThanOrEqual(2);
    const postReqSchema = postProjects?.requestBody?.content["application/json"]?.schema;
    expect(postReqSchema?.properties?.name?.type).toBe("string");
    expect(postReqSchema?.properties?.budget?.type).toBe("number");
    expect(postReqSchema?.properties?.targetDate?.type).toBe("string");
    expect(postReqSchema?.required).toEqual(["budget", "name", "targetDate"]);
    expect(postProjects?.responses["201"]).toBeDefined();
    expect(postProjects?.responses["400"]).toBeDefined();

    // 5. Verifica GET /api/projects/{id} com enum status (draft | active | archived) e x-cleanroom-evidence
    const getProjectById = result.document.paths["/api/projects/{id}"]?.get;
    expect(getProjectById).toBeDefined();
    expect(getProjectById?.["x-cleanroom-evidence"].length).toBeGreaterThanOrEqual(3);

    const idPathParam = getProjectById?.parameters?.find((p) => p.name === "id" && p.in === "path");
    expect(idPathParam).toBeDefined();
    expect(idPathParam?.required).toBe(true);

    const getById200Schema =
      getProjectById?.responses["200"]?.content?.["application/json"]?.schema;
    const statusPropSchema =
      getById200Schema?.properties?.data?.properties?.status ??
      getById200Schema?.properties?.status;
    expect(statusPropSchema?.type).toBe("string");
    expect(statusPropSchema?.enum).toEqual(["draft", "active", "archived"]);
    expect(getProjectById?.["x-cleanroom-enums"]?.status).toEqual(["draft", "active", "archived"]);

    // 6. Verifica detecção de auth (bearerAuth) e erro padrão (StandardError: { error, message, code })
    expect(result.securitySchemes).toContain("bearerAuth");
    expect(result.document.components?.securitySchemes?.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(result.hasStandardErrorSchema).toBe(true);
    const standardError = result.document.components?.schemas?.StandardError;
    expect(standardError?.properties?.error?.type).toBe("string");
    expect(standardError?.properties?.message?.type).toBe("string");
    expect(standardError?.properties?.code?.type).toBe("string");

    // 7. Verifica conteúdo do arquivo openapi.yaml salvo em disco
    const yamlOnDisk = readFileSync(result.outputPath ?? "", "utf8");
    expect(yamlOnDisk).toContain("openapi: 3.1.0");
    expect(yamlOnDisk).toContain("/api/projects:");
    expect(yamlOnDisk).toContain("/api/projects/{id}:");
    expect(yamlOnDisk).toContain("x-cleanroom-evidence:");
    expect(yamlOnDisk).toContain("- draft");
    expect(yamlOnDisk).toContain("- active");
    expect(yamlOnDisk).toContain("- archived");
    expect(savedCheckpoints.length).toBe(1);
  });

  it("funciona exclusivamente a partir de evidências network_call persistidas no EvidenceStore (sem arquivo HAR em disco)", async () => {
    const manifest = buildManifest();
    const ctx = createTestContext(manifest);

    // Insere evidências network_call simulando o output da fase capture (F1-07)
    evidenceStore.put({
      jobId: ctx.job.id,
      kind: "network_call",
      phase: "capture",
      url: `${DEMO_ORIGIN}/api/projects?page=1`,
      summary: "network_call GET /api/projects -> 200",
      data: {
        method: "GET",
        url: `${DEMO_ORIGIN}/api/projects?page=1`,
        urlTemplate: `${DEMO_ORIGIN}/api/projects`,
        pathTemplate: "/api/projects",
        status: 200,
        queryParams: ["page"],
        authSchemes: ["cookie"],
        resShape: {
          items: [
            {
              budget: "number",
              createdAt: "string",
              id: "string",
              name: "string",
              status: "string",
              targetDate: "string",
            },
          ],
          meta: {
            hasNextPage: "boolean",
            page: "number",
            pageSize: "number",
            total: "number",
            totalPages: "number",
          },
        },
        safeEnumSamples: {
          "items[].status": ["draft", "active", "archived"],
          status: ["draft", "active", "archived"],
        },
      },
    });

    evidenceStore.put({
      jobId: ctx.job.id,
      kind: "network_call",
      phase: "capture",
      url: `${DEMO_ORIGIN}/api/projects`,
      summary: "network_call POST /api/projects -> 201",
      data: {
        method: "POST",
        url: `${DEMO_ORIGIN}/api/projects`,
        urlTemplate: `${DEMO_ORIGIN}/api/projects`,
        pathTemplate: "/api/projects",
        status: 201,
        reqShape: {
          budget: "number",
          name: "string",
          targetDate: "string",
        },
        resShape: {
          data: {
            budget: "number",
            createdAt: "string",
            id: "string",
            name: "string",
            status: "string",
            targetDate: "string",
          },
        },
        safeEnumSamples: {
          "data.status": ["draft"],
        },
      },
    });

    evidenceStore.put({
      jobId: ctx.job.id,
      kind: "network_call",
      phase: "capture",
      url: `${DEMO_ORIGIN}/api/projects/proj-1`,
      summary: "network_call GET /api/projects/{id} -> 200",
      data: {
        method: "GET",
        url: `${DEMO_ORIGIN}/api/projects/proj-1`,
        urlTemplate: `${DEMO_ORIGIN}/api/projects/{id}`,
        pathTemplate: "/api/projects/{id}",
        status: 200,
        resShape: {
          data: {
            budget: "number",
            createdAt: "string",
            id: "string",
            name: "string",
            status: "string",
            targetDate: "string",
          },
        },
        safeEnumSamples: {
          "data.status": ["draft"],
        },
      },
    });

    const result = await harToOpenApi(ctx);

    expect(validateOpenApiDocument(result.document).valid).toBe(true);
    expect(result.securitySchemes).toContain("cookieAuth");
    expect(result.paginationParams).toContain("page");

    const getById = result.document.paths["/api/projects/{id}"]?.get;
    expect(getById).toBeDefined();
    // Como compartilha a família de recurso /api/projects, herda os 3 valores seguros de status
    const statusSchema =
      getById?.responses["200"]?.content?.["application/json"]?.schema.properties?.data?.properties
        ?.status;
    expect(statusSchema?.enum).toEqual(["draft", "active", "archived"]);
    expect(getById?.["x-cleanroom-evidence"]).toHaveLength(1);
  });

  it("mescla shapes com campos opcionais e respeita limite de <= 8 valores para enums seguros", async () => {
    const har: HarLog = {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1.0" },
        entries: [
          {
            _resourceType: "fetch",
            request: {
              method: "GET",
              url: `${DEMO_ORIGIN}/api/users/550e8400-e29b-41d4-a716-446655440000?limit=10&offset=0`,
              cookies: [{ name: "sid", value: "abc" }],
              headers: [],
              queryString: [
                { name: "limit", value: "10" },
                { name: "offset", value: "0" },
              ],
            },
            response: {
              status: 200,
              cookies: [],
              headers: [{ name: "content-type", value: "application/json" }],
              content: {
                size: 100,
                mimeType: "application/json",
                text: JSON.stringify({
                  id: "u1",
                  role: "admin",
                  nickname: "Gabs", // presente apenas na 1ª amostra -> opcional
                  state: "s1",
                }),
              },
            },
          },
          {
            _resourceType: "fetch",
            request: {
              method: "GET",
              url: `${DEMO_ORIGIN}/api/users/999`,
              cookies: [],
              headers: [],
              queryString: [],
            },
            response: {
              status: 200,
              cookies: [],
              headers: [{ name: "content-type", value: "application/json" }],
              content: {
                size: 100,
                mimeType: "application/json",
                text: JSON.stringify({
                  id: "u2",
                  role: "member",
                  // nickname ausente nesta amostra!
                  state: "s2",
                }),
              },
            },
          },
          // Adiciona mais 7 valores distintos para 'state' (total = 9 > 8) para testar que > 8 não vira enum
          ...["s3", "s4", "s5", "s6", "s7", "s8", "s9"].map((stVal, i) => ({
            _resourceType: "fetch",
            request: {
              method: "GET",
              url: `${DEMO_ORIGIN}/api/users/${1000 + i}`,
              cookies: [],
              headers: [],
              queryString: [],
            },
            response: {
              status: 200,
              cookies: [],
              headers: [{ name: "content-type", value: "application/json" }],
              content: {
                size: 50,
                mimeType: "application/json",
                text: JSON.stringify({
                  id: `u_${i}`,
                  role: "viewer",
                  state: stVal,
                }),
              },
            },
          })),
        ],
      },
    };

    const res = await harToOpenApi(har);
    expect(validateOpenApiDocument(res.document).valid).toBe(true);

    const getUserOp = res.document.paths["/api/users/{id}"]?.get;
    expect(getUserOp).toBeDefined();

    const schema = getUserOp?.responses["200"]?.content?.["application/json"]?.schema;
    expect(schema?.required).toEqual(["id", "role", "state"]);
    expect(schema?.required).not.toContain("nickname");
    expect(schema?.properties?.nickname?.type).toBe("string");

    // 'role' tem 3 valores seguros <= 8 -> vira enum
    expect(schema?.properties?.role?.enum).toEqual(["admin", "member", "viewer"]);
    // 'state' tem 9 valores distintos (> 8) -> não vira enum
    expect(schema?.properties?.state?.enum).toBeUndefined();

    // Paginação limit & offset detectados
    expect(res.paginationParams).toEqual(["limit", "offset"]);
    expect(getUserOp?.["x-cleanroom-pagination"]?.style).toBe("offset");
  });

  it("respeita guard.assertMethod('networkHar') e pula quando methods.networkHar === false", async () => {
    const manifest = buildManifest({ networkHar: false });
    const ctx = createTestContext(manifest);
    const assertMethodSpy = vi.spyOn(ctx.guard, "assertMethod");

    const result = await harToOpenApi(ctx);
    expect(assertMethodSpy).toHaveBeenCalledWith("networkHar");
    expect(result.skipped).toBe(true);
    expect(result.stats.skipped).toBe(1);

    await expect(harToOpenApi(ctx, { throwOnMethodDisabled: true })).rejects.toBeInstanceOf(
      MethodNotAllowedError,
    );

    const phase = createHarToOpenApiPhase();
    expect(phase.isEnabled?.(manifest)).toBe(false);
    expect(phase.isEnabled?.(buildManifest({ networkHar: true }))).toBe(true);
  });

  it("testa utilitários puros: normalizeOpenApiPathTemplate, extractSafeEnumsFromJson, isStandardErrorShape e serializeOpenApiYaml", () => {
    expect(
      normalizeOpenApiPathTemplate(
        "https://api.example.com/v1/projects/550e8400-e29b-41d4-a716-446655440000/tasks/42",
      ),
    ).toEqual({
      origin: "https://api.example.com",
      pathTemplate: "/v1/projects/{id}/tasks/{id}",
      pathParams: ["id"],
    });

    const enums = extractSafeEnumsFromJson({
      status: "draft",
      plan: "pro",
      name: "Texto Longo Com Espaços Não É Enum",
      secretToken: "[REDACTED]",
    });
    expect(enums.status).toEqual(["draft"]);
    expect(enums.plan).toEqual(["pro"]);
    expect(enums.name).toBeUndefined();
    expect(enums.secretToken).toBeUndefined();

    expect(isStandardErrorShape({ error: "BAD_REQUEST", message: "Erro", code: "E01" })).toBe(true);
    expect(isStandardErrorShape({ ok: true })).toBe(false);

    const yaml = serializeOpenApiYaml({
      openapi: "3.1.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {},
    });
    expect(yaml).toContain("openapi: 3.1.0");
    expect(yaml).toContain("paths: {}");
  });
});
