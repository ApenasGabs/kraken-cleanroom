import type { HarLog } from "@cleanroom/core";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_HEADERS,
  MAX_BODY_BYTES,
  REDACTED_MARKER,
  TRUNCATED_MARKER,
  inferJsonShape,
  isApiRequest,
  normalizeUrlTemplate,
  sanitizeHar,
} from "./har-sanitizer.js";

describe("har-sanitizer (@cleanroom/explorer - F1-07)", () => {
  const SECRET_VALUES = {
    authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-token",
    apiKeyHeader: "api-key-live-9876543210-secret",
    csrfHeader: "csrf-anti-forgery-token-secret-999",
    cookieSession: "session_id=ultra-secret-session-id-abc",
    cookieAuth: "auth_token=super-auth-cookie-secret-xyz",
    setCookieHeader: "session_live=secret-live-cookie; Path=/; Secure; HttpOnly",
    queryAccessToken: "access_token_secret_value_12345",
    queryApiKey: "api_key_query_secret_777",
    queryPasswordReset: "reset_token_secret_888",
    jsonPassword: "MySuperSecretPassword#2026!",
    jsonAccessToken: "access_token_body_secret_value_abc",
    jsonSecretField: "classified-vault-secret-data",
    jsonSessionId: "session_payload_secret_456",
    jsonNestedKey: "nested_private_api_key_000",
    responseJwt: "eyJhbGciOiJIUzI1NiJ9.res-token-secret-payload.sig",
    responseSecret: "internal-db-secret-string",
  };

  function createRawFixtureHar(): HarLog {
    return {
      log: {
        version: "1.2",
        creator: { name: "Playwright", version: "1.50.0" },
        browser: { name: "Chromium", version: "131.0.0.0" },
        pages: [
          {
            startedDateTime: "2026-11-13T18:00:00.000Z",
            id: "page@1",
            title: "Cleanroom Target Demo",
            pageTimings: { onContentLoad: 120, onLoad: 350 },
          },
        ],
        entries: [
          // 1. Chamada de API com segredos em headers, cookies, query e body JSON
          {
            _resourceType: "fetch",
            startedDateTime: "2026-11-13T18:00:01.000Z",
            time: 42,
            request: {
              method: "POST",
              url: `https://app.demo.local/api/v1/projects/550e8400-e29b-41d4-a716-446655440000/tokens?access_token=${SECRET_VALUES.queryAccessToken}&apiKey=${SECRET_VALUES.queryApiKey}&page=2`,
              httpVersion: "HTTP/1.1",
              cookies: [
                { name: "session_id", value: SECRET_VALUES.cookieSession },
                { name: "auth_token", value: SECRET_VALUES.cookieAuth },
              ],
              headers: [
                { name: "Host", value: "app.demo.local" },
                { name: "Authorization", value: SECRET_VALUES.authHeader },
                { name: "x-api-key", value: SECRET_VALUES.apiKeyHeader },
                { name: "X-CSRF-Token", value: SECRET_VALUES.csrfHeader },
                {
                  name: "Cookie",
                  value: `${SECRET_VALUES.cookieSession}; ${SECRET_VALUES.cookieAuth}`,
                },
                { name: "Content-Type", value: "application/json" },
                { name: "Accept", value: "application/json" },
              ],
              queryString: [
                { name: "access_token", value: SECRET_VALUES.queryAccessToken },
                { name: "apiKey", value: SECRET_VALUES.queryApiKey },
                { name: "page", value: "2" },
              ],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({
                  projectName: "Cleanroom Project Alpha",
                  budget: 15000,
                  password: SECRET_VALUES.jsonPassword,
                  access_token: SECRET_VALUES.jsonAccessToken,
                  session_id: SECRET_VALUES.jsonSessionId,
                  secretConfig: SECRET_VALUES.jsonSecretField,
                  active: true,
                  tags: ["cleanroom", "mvp"],
                  nested: {
                    apiKey: SECRET_VALUES.jsonNestedKey,
                    owner: "engineer@company.local",
                  },
                }),
              },
              headersSize: 450,
              bodySize: 320,
            },
            response: {
              status: 201,
              statusText: "Created",
              httpVersion: "HTTP/1.1",
              cookies: [{ name: "session_live", value: "session-cookie-value" }],
              headers: [
                { name: "Content-Type", value: "application/json; charset=utf-8" },
                { name: "Set-Cookie", value: SECRET_VALUES.setCookieHeader },
                { name: "X-Request-Id", value: "req-12345" },
              ],
              content: {
                size: 250,
                mimeType: "application/json",
                text: JSON.stringify({
                  id: "proj-1",
                  status: "active",
                  authToken: SECRET_VALUES.responseJwt,
                  internalSecret: SECRET_VALUES.responseSecret,
                  createdAt: "2026-11-13T18:00:01.000Z",
                  metadata: {
                    tier: "enterprise",
                    quota: 100,
                  },
                }),
              },
              redirectURL: "",
              headersSize: 220,
              bodySize: 250,
            },
            cache: {},
            timings: { send: 1, wait: 35, receive: 6 },
          },
          // 2. Script JS público com SourceMap
          {
            _resourceType: "script",
            startedDateTime: "2026-11-13T18:00:00.500Z",
            time: 15,
            request: {
              method: "GET",
              url: "https://app.demo.local/assets/app-bundle.js",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [{ name: "Accept", value: "*/*" }],
              queryString: [],
              headersSize: 80,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [{ name: "Content-Type", value: "application/javascript" }],
              content: {
                size: 1024,
                mimeType: "application/javascript",
                text: "console.log('Cleanroom Target App');\n//# sourceMappingURL=app-bundle.js.map",
              },
              redirectURL: "",
              headersSize: 90,
              bodySize: 1024,
            },
            cache: {},
            timings: { send: 1, wait: 10, receive: 4 },
          },
        ],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Critério de Aceite 1: Nenhum segredo sobrevive no HAR salvo
  // -------------------------------------------------------------------------
  it("sanitiza rigorosamente o HAR: nenhum segredo sobrevive no JSON salvo (Critério 1)", () => {
    const rawHar = createRawFixtureHar();
    const result = sanitizeHar(rawHar);

    const serializedSanitized = JSON.stringify(result.har, null, 2);

    // 1. Garante que NENHUM segredo bruto sobrevive em qualquer ponto do texto
    for (const [name, secret] of Object.entries(SECRET_VALUES)) {
      expect(
        serializedSanitized.includes(secret),
        `Vazamento detectado do segredo '${name}': "${secret}" foi encontrado no HAR sanitizado!`,
      ).toBe(false);
    }

    // 2. Headers proibidos foram totalmente removidos
    const entry = result.har.log.entries[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Entrada HAR não encontrada");
    const reqHeaderNames = entry.request.headers.map((h) => h.name.toLowerCase());
    const resHeaderNames = entry.response.headers.map((h) => h.name.toLowerCase());

    for (const forbidden of FORBIDDEN_HEADERS) {
      expect(reqHeaderNames).not.toContain(forbidden);
      expect(resHeaderNames).not.toContain(forbidden);
    }

    // 3. Cookies arrays estão estritamente vazios
    expect(entry.request.cookies).toHaveLength(0);
    expect(entry.response.cookies).toHaveLength(0);

    // 4. Query params sensíveis foram mascarados como [REDACTED]
    const accessTokenQuery = entry.request.queryString.find((q) => q.name === "access_token");
    const apiKeyQuery = entry.request.queryString.find((q) => q.name === "apiKey");
    const pageQuery = entry.request.queryString.find((q) => q.name === "page");

    expect(accessTokenQuery?.value).toBe(REDACTED_MARKER);
    expect(apiKeyQuery?.value).toBe(REDACTED_MARKER);
    expect(pageQuery?.value).toBe("2"); // parâmetro não sensível preservado

    // URL foi higienizada também
    expect(entry.request.url).toContain("access_token=%5BREDACTED%5D");
    expect(entry.request.url).toContain("apiKey=%5BREDACTED%5D");
    expect(entry.request.url).toContain("page=2");

    // 5. Body JSON do Request teve campos sensíveis mascarados e campos normais preservados
    const postDataText = entry.request.postData?.text ?? "";
    const parsedReqBody = JSON.parse(postDataText);
    expect(parsedReqBody.projectName).toBe("Cleanroom Project Alpha");
    expect(parsedReqBody.budget).toBe(15000);
    expect(parsedReqBody.active).toBe(true);
    expect(parsedReqBody.password).toBe(REDACTED_MARKER);
    expect(parsedReqBody.access_token).toBe(REDACTED_MARKER);
    expect(parsedReqBody.session_id).toBe(REDACTED_MARKER);
    expect(parsedReqBody.secretConfig).toBe(REDACTED_MARKER);
    expect(parsedReqBody.nested.apiKey).toBe(REDACTED_MARKER);
    expect(parsedReqBody.nested.owner).toBe("engineer@company.local");

    // 6. Body JSON da Response teve campos sensíveis mascarados
    const contentText = entry.response.content.text ?? "";
    const parsedResBody = JSON.parse(contentText);
    expect(parsedResBody.id).toBe("proj-1");
    expect(parsedResBody.status).toBe("active");
    expect(parsedResBody.authToken).toBe(REDACTED_MARKER);
    expect(parsedResBody.internalSecret).toBe(REDACTED_MARKER);
    expect(parsedResBody.metadata.tier).toBe("enterprise");

    // 7. Estatísticas de sanitização apuradas corretamente
    expect(result.stats.headersRemoved).toBeGreaterThanOrEqual(5);
    expect(result.stats.cookiesPurged).toBeGreaterThanOrEqual(3);
    expect(result.stats.queryParamsRedacted).toBeGreaterThanOrEqual(2);
    expect(result.stats.bodyFieldsRedacted).toBeGreaterThanOrEqual(7);
  });

  // -------------------------------------------------------------------------
  // Critério de Aceite 2: Evidências network_call com urlTemplate e shapes
  // -------------------------------------------------------------------------
  it("extrai evidências network_call com urlTemplate normalizado e shapes de tipos recursivos sem valores (Critério 2)", () => {
    const rawHar = createRawFixtureHar();
    const result = sanitizeHar(rawHar);

    expect(result.apiCalls).toHaveLength(1);
    const call = result.apiCalls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("Chamada de API não encontrada");

    expect(call.method).toBe("POST");
    expect(call.status).toBe(201);
    expect(call.statusText).toBe("Created");

    // Template normalizado substitui UUID por {id}
    expect(call.urlTemplate).toBe("https://app.demo.local/api/v1/projects/{id}/tokens");
    expect(call.pathTemplate).toBe("/api/v1/projects/{id}/tokens");

    // reqShape: esqueleto recursivo de tipos JSON sem nenhum valor literal
    expect(call.reqShape).toEqual({
      active: "boolean",
      budget: "number",
      nested: {
        apiKey: "string",
        owner: "string",
      },
      password: "string",
      access_token: "string",
      session_id: "string",
      secretConfig: "string",
      projectName: "string",
      tags: ["string"],
    });

    // resShape: esqueleto recursivo sem valores
    expect(call.resShape).toEqual({
      authToken: "string",
      createdAt: "string",
      id: "string",
      internalSecret: "string",
      metadata: {
        quota: "number",
        tier: "string",
      },
      status: "string",
    });

    // Garante que nenhum segredo nem dado literal está presente nos shapes
    const shapesString = JSON.stringify({ req: call.reqShape, res: call.resShape });
    expect(shapesString).not.toContain("Cleanroom Project Alpha");
    expect(shapesString).not.toContain("15000");
    expect(shapesString).not.toContain(SECRET_VALUES.jsonPassword);
    expect(shapesString).not.toContain(SECRET_VALUES.responseJwt);
  });

  // -------------------------------------------------------------------------
  // Testes de inferJsonShape
  // -------------------------------------------------------------------------
  describe("inferJsonShape", () => {
    it("mapeia primitivos para descritores de tipo", () => {
      expect(inferJsonShape("hello")).toBe("string");
      expect(inferJsonShape(123)).toBe("number");
      expect(inferJsonShape(0)).toBe("number");
      expect(inferJsonShape(true)).toBe("boolean");
      expect(inferJsonShape(false)).toBe("boolean");
      expect(inferJsonShape(null)).toBe("null");
      expect(inferJsonShape(undefined)).toBe("undefined");
    });

    it("mapeia arrays vazios e de tipos homogêneos", () => {
      expect(inferJsonShape([])).toEqual([]);
      expect(inferJsonShape(["a", "b", "c"])).toEqual(["string"]);
      expect(inferJsonShape([1, 2, 3])).toEqual(["number"]);
      expect(inferJsonShape([true, false])).toEqual(["boolean"]);
    });

    it("mescla chaves de arrays de objetos garantindo cobertura de campos opcionais", () => {
      const items = [
        { id: "1", name: "Projeto A" },
        { id: "2", name: "Projeto B", budget: 5000 },
        { id: "3", name: "Projeto C", active: true },
      ];
      expect(inferJsonShape(items)).toEqual([
        {
          active: "boolean",
          budget: "number",
          id: "string",
          name: "string",
        },
      ]);
    });

    it("ordena chaves de objetos deterministicamente", () => {
      const obj = { z: 1, a: "test", m: true };
      const shape = inferJsonShape(obj);
      expect(Object.keys(shape as Record<string, unknown>)).toEqual(["a", "m", "z"]);
    });
  });

  // -------------------------------------------------------------------------
  // Testes de normalizeUrlTemplate
  // -------------------------------------------------------------------------
  describe("normalizeUrlTemplate", () => {
    it("substitui UUIDs, números e slugs com ID por {id}", () => {
      const t1 = normalizeUrlTemplate(
        "https://api.example.com/v1/projects/550e8400-e29b-41d4-a716-446655440000",
      );
      expect(t1.pathTemplate).toBe("/v1/projects/{id}");
      expect(t1.urlTemplate).toBe("https://api.example.com/v1/projects/{id}");

      const t2 = normalizeUrlTemplate("https://api.example.com/users/42/items/999?filter=active");
      expect(t2.pathTemplate).toBe("/users/{id}/items/{id}");

      const t3 = normalizeUrlTemplate(
        "https://api.example.com/api/tasks/task-abc1234/subtasks/st-9988",
      );
      expect(t3.pathTemplate).toBe("/api/tasks/{id}/subtasks/{id}");

      const t4 = normalizeUrlTemplate("https://api.example.com/posts/hello-world-abcdef123");
      expect(t4.pathTemplate).toBe("/posts/{id}");
    });
  });

  // -------------------------------------------------------------------------
  // Testes de isApiRequest
  // -------------------------------------------------------------------------
  describe("isApiRequest", () => {
    it("detecta requisições fetch/xhr e JSON, ignorando assets estáticos", () => {
      const fetchEntry = {
        _resourceType: "fetch",
        request: { url: "https://demo.local/data", headers: [] },
        response: { content: { mimeType: "text/plain" } },
      } as unknown as import("@cleanroom/core").HarEntry;
      expect(isApiRequest(fetchEntry)).toBe(true);

      const jsonEntry = {
        _resourceType: "other",
        request: {
          url: "https://demo.local/graphql",
          headers: [{ name: "Accept", value: "application/json" }],
        },
        response: { content: { mimeType: "application/json" } },
      } as unknown as import("@cleanroom/core").HarEntry;
      expect(isApiRequest(jsonEntry)).toBe(true);

      const scriptEntry = {
        _resourceType: "script",
        request: { url: "https://demo.local/static/main.js", headers: [] },
        response: { content: { mimeType: "application/javascript" } },
      } as unknown as import("@cleanroom/core").HarEntry;
      expect(isApiRequest(scriptEntry)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Teste de truncamento de corpos > 256 KB
  // -------------------------------------------------------------------------
  it("trunca corpos de requisições e respostas que excedem 256 KB", () => {
    const hugeText = "A".repeat(300 * 1024); // 300 KB
    const harWithHugeBody: HarLog = {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1.0" },
        pages: [],
        entries: [
          {
            _resourceType: "fetch",
            startedDateTime: "2026-11-13T18:00:00.000Z",
            time: 10,
            request: {
              method: "POST",
              url: "https://app.demo.local/api/large-upload",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [{ name: "Content-Type", value: "text/plain" }],
              queryString: [],
              postData: {
                mimeType: "text/plain",
                text: hugeText,
              },
            },
            response: {
              status: 200,
              cookies: [],
              headers: [{ name: "Content-Type", value: "text/plain" }],
              content: {
                size: 300 * 1024,
                mimeType: "text/plain",
                text: hugeText,
              },
            },
          } as unknown as import("@cleanroom/core").HarEntry,
        ],
      },
    };

    const res = sanitizeHar(harWithHugeBody, { maxBodyBytes: MAX_BODY_BYTES });
    const entry0 = res.har.log.entries[0];
    expect(entry0).toBeDefined();
    const reqText = entry0?.request.postData?.text ?? "";
    const resText = entry0?.response.content.text ?? "";

    expect(reqText).toContain(TRUNCATED_MARKER);
    expect(resText).toContain(TRUNCATED_MARKER);
    expect(res.stats.bodiesTruncated).toBe(2);
    expect(Buffer.byteLength(reqText, "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES + 50);
  });

  // -------------------------------------------------------------------------
  // Teste de catálogo de scripts JS públicos
  // -------------------------------------------------------------------------
  it("indexa metadados de scripts JS públicos para o bundleAnalyzer (F1-10)", () => {
    const rawHar = createRawFixtureHar();
    const result = sanitizeHar(rawHar);

    expect(result.publicScripts).toHaveLength(1);
    const script = result.publicScripts[0];
    expect(script).toBeDefined();
    if (!script) throw new Error("Script público não encontrado");
    expect(script.url).toBe("https://app.demo.local/assets/app-bundle.js");
    expect(script.hasSourceMap).toBe(true);
    expect(script.sourceMapUrl).toBe("https://app.demo.local/assets/app-bundle.js.map");
    expect(script.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(script.size).toBe(1024);
  });
});
