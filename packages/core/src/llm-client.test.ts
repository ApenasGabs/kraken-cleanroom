import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CleanroomError,
  ConfigError,
  DEFAULT_PHASE_ORDER,
  FakeLlmClient,
  GeminiLlmClient,
  JobStore,
  LlmInvalidOutputError,
  LlmUnavailableError,
  OpenAiCompatibleLlmClient,
  type Phase,
  type SqliteDatabase,
  bindLlmClientToJob,
  createCleanroomJobId,
  createJobService,
  createLlmClient,
  createLlmClientFromConfig,
  loadConfig,
  openDatabase,
} from "./index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const MANIFEST_YAML = readFileSync(
  resolve(here, "../../../examples/demo-app.cleanroom.yaml"),
  "utf8",
);

const ModuleFindingSchema = z.object({
  module: z.string().min(1),
  rulesCount: z.number().int().nonnegative(),
  tags: z.array(z.string()),
});

describe("FakeLlmClient & typed validation", () => {
  it("returns strongly-typed data validated by Zod from queued responses", async () => {
    const fake = new FakeLlmClient({
      responses: [
        {
          data: { module: "Projetos", rulesCount: 3, tags: ["crud", "status"] },
          usage: { tokensIn: 120, tokensOut: 45 },
        },
      ],
    });

    const result = await fake.generateObject(ModuleFindingSchema, [
      { role: "system", content: "Extraia achados do módulo." },
      { role: "user", content: "Analise evidências do módulo Projetos." },
    ]);

    expect(result.data).toEqual({
      module: "Projetos",
      rulesCount: 3,
      tags: ["crud", "status"],
    });
    expect(result.usage).toEqual({ tokensIn: 120, tokensOut: 45 });
    expect(fake.calls).toHaveLength(1);
  });

  it("resolves fixtures by schemaName or message content and strips markdown json fences", async () => {
    const fake = new FakeLlmClient({
      defaultUsage: { tokensIn: 25, tokensOut: 10 },
      fixtures: {
        "pricing-schema": '```json\n{"module":"Planos","rulesCount":2,"tags":["free","pro"]}\n```',
      },
    });

    const res = await fake.generateObject(
      ModuleFindingSchema,
      [{ role: "user", content: "Liste planos" }],
      { schemaName: "pricing-schema" },
    );

    expect(res.data).toEqual({
      module: "Planos",
      rulesCount: 2,
      tags: ["free", "pro"],
    });
    expect(res.usage).toEqual({ tokensIn: 25, tokensOut: 10 });
  });

  it("supports custom conditional handlers", async () => {
    const fake = new FakeLlmClient();
    fake.registerHandler(
      (req) => req.messages.some((m) => m.content.includes("Autenticação")),
      () => ({
        data: { module: "Autenticação", rulesCount: 1, tags: ["login"] },
        usage: { tokensIn: 30, tokensOut: 12 },
      }),
    );

    const res = await fake.generateObject(ModuleFindingSchema, [
      { role: "user", content: "Módulo: Autenticação" },
    ]);

    expect(res.data.module).toBe("Autenticação");
    expect(res.usage).toEqual({ tokensIn: 30, tokensOut: 12 });
  });
});

describe("Zod validation & automatic retry (up to 2x)", () => {
  it("retries up to 2x sending validation error back to the model and succeeds on the 3rd attempt", async () => {
    const fake = new FakeLlmClient({
      responses: [
        // 1ª tentativa (attempt 0): JSON malformado
        { raw: "{ invalid json", usage: { tokensIn: 50, tokensOut: 10 } },
        // 2ª tentativa / 1º retry (attempt 1): JSON válido mas fora do schema Zod
        {
          raw: JSON.stringify({ module: "", rulesCount: -5, tags: "not-an-array" }),
          usage: { tokensIn: 70, tokensOut: 15 },
        },
        // 3ª tentativa / 2º retry (attempt 2): JSON válido e em conformidade com o schema
        {
          raw: JSON.stringify({ module: "Projetos", rulesCount: 4, tags: ["validado"] }),
          usage: { tokensIn: 90, tokensOut: 25 },
        },
      ],
    });

    const result = await fake.generateObject(ModuleFindingSchema, [
      { role: "user", content: "Sintetize o módulo Projetos." },
    ]);

    expect(result.data).toEqual({
      module: "Projetos",
      rulesCount: 4,
      tags: ["validado"],
    });
    // Soma os tokens das 3 tentativas
    expect(result.usage).toEqual({
      tokensIn: 50 + 70 + 90,
      tokensOut: 10 + 15 + 25,
    });

    expect(fake.calls).toHaveLength(3);
    // Verifica que o erro de JSON malformado foi enviado de volta no 1º retry
    const retry1Messages = fake.calls[1]?.messages ?? [];
    expect(retry1Messages.at(-2)).toEqual({ role: "assistant", content: "{ invalid json" });
    expect(retry1Messages.at(-1)?.role).toBe("user");
    expect(retry1Messages.at(-1)?.content).toContain("JSON malformado");

    // Verifica que o erro detalhado do Zod foi enviado de volta no 2º retry
    const retry2Messages = fake.calls[2]?.messages ?? [];
    expect(retry2Messages.at(-1)?.role).toBe("user");
    expect(retry2Messages.at(-1)?.content).toContain("Validação Zod falhou");
    expect(retry2Messages.at(-1)?.content).toContain("rulesCount");
    expect(retry2Messages.at(-1)?.content).toContain("tags");
  });

  it("throws CleanroomError (LLM_INVALID_OUTPUT) after exhausting initial + 2 retries", async () => {
    const fake = new FakeLlmClient({
      responses: [
        { raw: "não é json 1", usage: { tokensIn: 10, tokensOut: 5 } },
        { raw: JSON.stringify({ module: 123 }), usage: { tokensIn: 15, tokensOut: 5 } },
        {
          raw: JSON.stringify({ module: "Ok", rulesCount: "errado", tags: [] }),
          usage: { tokensIn: 20, tokensOut: 5 },
        },
        // 4ª resposta não deve ser consumida pois o limite padrão é 2 retries (3 tentativas)
        { data: { module: "Nunca chega", rulesCount: 1, tags: [] } },
      ],
    });

    let caughtError: unknown;
    try {
      await fake.generateObject(ModuleFindingSchema, [
        { role: "user", content: "Tente gerar objeto" },
      ]);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(CleanroomError);
    expect(caughtError).toBeInstanceOf(LlmInvalidOutputError);
    const cleanErr = caughtError as LlmInvalidOutputError;
    expect(cleanErr.code).toBe("LLM_INVALID_OUTPUT");
    expect(cleanErr.message).toContain("3 tentativa(s)");
    expect(fake.calls).toHaveLength(3);
  });
});

describe("MVP providers: openai-compatible and gemini", () => {
  it("calls /chat/completions via native fetch in OpenAiCompatibleLlmClient and retries on invalid schema", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ module: "X", rulesCount: "bad" }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 12 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ module: "Faturamento", rulesCount: 2, tags: ["pro"] }),
                },
              },
            ],
            usage: { prompt_tokens: 60, completion_tokens: 18 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const client = new OpenAiCompatibleLlmClient({
      apiKey: "sk-test-placeholder-key",
      model: "gpt-4o-mini",
      baseUrl: "https://llm.example.com/v1/",
      fetch: fetchMock,
    });

    const result = await client.generateObject(ModuleFindingSchema, [
      { role: "user", content: "Extraia módulo Faturamento" },
    ]);

    expect(result.data).toEqual({
      module: "Faturamento",
      rulesCount: 2,
      tags: ["pro"],
    });
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? [];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test-placeholder-key",
    );
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.model).toBe("gpt-4o-mini");
    expect(sentBody.response_format).toEqual({ type: "json_object" });
  });

  it("throws LlmUnavailableError and redacts API key when OpenAiCompatibleLlmClient HTTP fails", async () => {
    const secretKey = "sk-secret-value-999";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`Unauthorized key ${secretKey}`, { status: 401 }));

    const client = new OpenAiCompatibleLlmClient({
      apiKey: secretKey,
      model: "gpt-4o-mini",
      fetch: fetchMock,
    });

    await expect(
      client.generateObject(ModuleFindingSchema, [{ role: "user", content: "oi" }]),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmUnavailableError);
      const llmErr = err as LlmUnavailableError;
      expect(llmErr.code).toBe("LLM_UNAVAILABLE");
      expect(llmErr.message).not.toContain(secretKey);
      expect(llmErr.message).toContain("[REDACTED]");
      return true;
    });
  });

  it("calls models/{model}:generateContent via native fetch in GeminiLlmClient", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      module: "Ajuda",
                      rulesCount: 3,
                      tags: ["docs", "faq"],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 85,
            candidatesTokenCount: 22,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = new GeminiLlmClient({
      apiKey: "gemini-placeholder-key",
      model: "gemini-2.5-flash",
      fetch: fetchMock,
    });

    const result = await client.generateObject(
      ModuleFindingSchema,
      [
        { role: "system", content: "Você é um analisador clean room." },
        { role: "user", content: "Analise a seção de ajuda." },
      ],
      { temperature: 0.1, maxTokens: 512 },
    );

    expect(result.data).toEqual({
      module: "Ajuda",
      rulesCount: 3,
      tags: ["docs", "faq"],
    });
    expect(result.usage).toEqual({ tokensIn: 85, tokensOut: 22 });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? [];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "gemini-placeholder-key",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.systemInstruction.parts[0].text).toContain("Você é um analisador clean room.");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Analise a seção de ajuda." }] },
    ]);
    expect(body.generationConfig).toEqual({
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
    });
  });

  it("creates clients via createLlmClient and createLlmClientFromConfig", () => {
    const fakeCfg = loadConfig({ CLEANROOM_LLM_PROVIDER: "fake" });
    expect(createLlmClientFromConfig(fakeCfg)).toBeInstanceOf(FakeLlmClient);

    const openAiCfg = loadConfig({
      CLEANROOM_LLM_PROVIDER: "openai-compatible",
      CLEANROOM_LLM_MODEL: "qwen-2.5",
      CLEANROOM_LLM_API_KEY: "test-key",
      CLEANROOM_LLM_BASE_URL: "https://api.example.com/v1",
    });
    expect(createLlmClientFromConfig(openAiCfg)).toBeInstanceOf(OpenAiCompatibleLlmClient);

    const geminiCfg = loadConfig({
      CLEANROOM_LLM_PROVIDER: "gemini",
      CLEANROOM_LLM_MODEL: "gemini-2.5-pro",
      CLEANROOM_LLM_API_KEY: "test-key",
    });
    expect(createLlmClientFromConfig(geminiCfg)).toBeInstanceOf(GeminiLlmClient);

    expect(() =>
      createLlmClient({
        provider: "anthropic",
        model: "claude-sonnet",
        apiKey: "test-key",
      }),
    ).toThrow(ConfigError);
  });
});

describe("Job token accounting (jobs.llm_tokens_in / jobs.llm_tokens_out)", () => {
  let dataDir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cleanroom-llm-tokens-"));
    db = openDatabase({ dataDir });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("accumulates tokensIn and tokensOut in the job record across calls and retries", async () => {
    const store = new JobStore({ db, dataDir });
    const jobId = createCleanroomJobId("token-test");
    store.createJob({
      id: jobId,
      name: "token-test",
      manifest: { version: 1 },
      manifestYaml: MANIFEST_YAML,
    });

    const fake = new FakeLlmClient({
      jobStore: store,
      jobId,
      responses: [
        // Chamada 1: falha na 1ª tentativa (30 in / 10 out) e acerta no retry (50 in / 20 out)
        { raw: "{broken", usage: { tokensIn: 30, tokensOut: 10 } },
        {
          data: { module: "Projetos", rulesCount: 3, tags: ["a"] },
          usage: { tokensIn: 50, tokensOut: 20 },
        },
        // Chamada 2: acerta de primeira (100 in / 40 out)
        {
          data: { module: "Planos", rulesCount: 2, tags: ["b"] },
          usage: { tokensIn: 100, tokensOut: 40 },
        },
      ],
    });

    const first = await fake.generateObject(ModuleFindingSchema, [
      { role: "user", content: "Chamada 1" },
    ]);
    expect(first.usage).toEqual({ tokensIn: 80, tokensOut: 30 });

    let job = store.getJobOrThrow(jobId);
    expect(job.llmTokensIn).toBe(80);
    expect(job.llmTokensOut).toBe(30);

    const second = await fake.generateObject(ModuleFindingSchema, [
      { role: "user", content: "Chamada 2" },
    ]);
    expect(second.usage).toEqual({ tokensIn: 100, tokensOut: 40 });

    job = store.getJobOrThrow(jobId);
    expect(job.llmTokensIn).toBe(180);
    expect(job.llmTokensOut).toBe(70);

    const snapshot = JSON.parse(readFileSync(join(dataDir, "jobs", jobId, "job.json"), "utf8"));
    expect(snapshot.llm).toEqual({ tokensIn: 180, tokensOut: 70 });
  });

  it("accumulates tokens automatically when phases use ctx.llm in JobRunner / JobService without double-counting", async () => {
    const fake = new FakeLlmClient({
      responses: [
        {
          data: { module: "Home", rulesCount: 1, tags: ["ui"] },
          usage: { tokensIn: 110, tokensOut: 35 },
        },
        {
          data: { module: "Ajuda", rulesCount: 2, tags: ["docs"] },
          usage: { tokensIn: 90, tokensOut: 25 },
        },
      ],
    });

    let observedJobTokensInsidePhase = { in: 0, out: 0 };

    const phases: Phase[] = DEFAULT_PHASE_ORDER.map((id) => ({
      id,
      async run(ctx) {
        if (id === "synthesize") {
          await ctx.llm.generateObject(ModuleFindingSchema, [
            { role: "user", content: "Sintetizar Home" },
          ]);
          await ctx.llm.generateObject(ModuleFindingSchema, [
            { role: "user", content: "Sintetizar Ajuda" },
          ]);
          observedJobTokensInsidePhase = {
            in: ctx.job.llmTokensIn,
            out: ctx.job.llmTokensOut,
          };
        }
        return { status: "ok", stats: {} };
      },
    }));

    const svc = createJobService({ db, dataDir, phases, llm: fake });
    const { jobId } = await svc.start(MANIFEST_YAML);
    const finished = await svc.waitForJob(jobId);

    expect(finished.state).toBe("completed");
    expect(finished.llmTokensIn).toBe(200);
    expect(finished.llmTokensOut).toBe(60);
    expect(observedJobTokensInsidePhase).toEqual({ in: 200, out: 60 });

    const status = await svc.status(jobId);
    expect(status.llm).toEqual({ tokensIn: 200, tokensOut: 60 });

    // Verifica que bindLlmClientToJob não duplica se o client já tinha jobStore configurado
    const alreadyBoundFake = new FakeLlmClient({
      jobStore: svc.store,
      responses: [
        {
          data: { module: "Extra", rulesCount: 1, tags: [] },
          usage: { tokensIn: 40, tokensOut: 10 },
        },
      ],
    });
    const wrapped = bindLlmClientToJob(alreadyBoundFake, svc.store, jobId);
    await wrapped.generateObject(ModuleFindingSchema, [{ role: "user", content: "Extra" }]);

    const updated = svc.store.getJobOrThrow(jobId);
    expect(updated.llmTokensIn).toBe(240);
    expect(updated.llmTokensOut).toBe(70);
  });
});
