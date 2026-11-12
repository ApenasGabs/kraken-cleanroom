import type { ZodError, ZodType, ZodTypeDef } from "zod";
import { type CleanroomConfig, type LlmProvider, assertLlmConfig } from "./config.js";
import { ConfigError, LlmInvalidOutputError, LlmUnavailableError } from "./errors.js";

export const LLM_ROLES = ["system", "user", "assistant"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmUsageEvent {
  usage: LlmUsage;
  attempt: number;
  jobId?: string | undefined;
}

export type LlmUsageCallback = (event: LlmUsageEvent) => void;

export interface LlmTokenSink {
  addLlmUsage(jobId: string, usage: LlmUsage): unknown;
}

export interface LlmOptions {
  schemaName?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  /** Máximo de retries após falha de JSON ou validação Zod (default: 2). */
  maxRetries?: number | undefined;
  signal?: AbortSignal | undefined;
  jobId?: string | undefined;
  onUsage?: LlmUsageCallback | undefined;
}

export interface LlmGenerateResult<T> {
  data: T;
  usage: LlmUsage;
}

export type AnyZodSchema<T> = ZodType<T, ZodTypeDef, unknown>;

export interface LlmClient {
  generateObject<T>(
    schema: AnyZodSchema<T>,
    messages: readonly LlmMessage[],
    opts?: LlmOptions,
  ): Promise<LlmGenerateResult<T>>;
}

export const DEFAULT_LLM_MAX_RETRIES = 2;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const BOUND_TOKEN_SINK = Symbol.for("cleanroom.llm.boundTokenSink");

interface TokenSinkAwareClient extends LlmClient {
  readonly [BOUND_TOKEN_SINK]?: LlmTokenSink | undefined;
}

export interface LlmCompletionOutput {
  raw: string | unknown;
  rawText: string;
  mode: "json-string" | "value";
  usage: LlmUsage;
}

export interface BaseLlmClientOptions {
  defaultMaxRetries?: number | undefined;
  jobStore?: LlmTokenSink | undefined;
  jobId?: string | undefined;
  onUsage?: LlmUsageCallback | undefined;
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function normalizeLlmUsage(
  usage?: { tokensIn?: number | undefined; tokensOut?: number | undefined } | null,
): LlmUsage {
  return {
    tokensIn: normalizeTokenCount(usage?.tokensIn),
    tokensOut: normalizeTokenCount(usage?.tokensOut),
  };
}

export function extractJsonFromLlmText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed;
}

export function formatZodValidationIssues(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`)
    .join("; ");
}

export function buildValidationRetryPrompt(
  validationError: string,
  retryNumber: number,
  maxRetries: number,
): string {
  return [
    `Sua resposta anterior falhou na validação estrutural (tentativa de correção ${retryNumber}/${maxRetries}).`,
    `Erro de validação: ${validationError}`,
    "Responda APENAS com um objeto JSON estritamente válido que respeite o schema solicitado, sem blocos markdown.",
  ].join("\n");
}

function ensureJsonSystemInstruction(messages: readonly LlmMessage[]): LlmMessage[] {
  const hint = "Responda exclusivamente com um JSON válido compatível com o schema solicitado.";
  const firstSystemIdx = messages.findIndex((m) => m.role === "system");
  if (firstSystemIdx === -1) {
    return [{ role: "system", content: hint }, ...messages];
  }
  return messages.map((m, idx) =>
    idx === firstSystemIdx && !m.content.toLowerCase().includes("json")
      ? { role: "system", content: `${m.content}\n\n${hint}` }
      : { ...m },
  );
}

function redactSecret(text: string, secret?: string): string {
  return secret && secret.trim().length > 0 ? text.split(secret).join("[REDACTED]") : text;
}

async function postJson<TResponse>(params: {
  providerLabel: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  secret: string;
  fetchFn: typeof globalThis.fetch;
  signal?: AbortSignal | undefined;
}): Promise<TResponse> {
  const { providerLabel, endpoint, headers, body, secret, fetchFn, signal } = params;
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    throw new LlmUnavailableError(
      `Falha de rede ao chamar provedor ${providerLabel}: ${redactSecret(rawMsg, secret)}`,
      { cause: err },
    );
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new LlmUnavailableError(
      `Provedor ${providerLabel} retornou HTTP ${response.status}: ${redactSecret(errorBody.slice(0, 300), secret)}`,
      { details: { status: response.status } },
    );
  }
  try {
    return (await response.json()) as TResponse;
  } catch (err) {
    throw new LlmUnavailableError(
      `Resposta HTTP do provedor ${providerLabel} não é um JSON válido.`,
      { cause: err },
    );
  }
}

async function executeWithValidationRetry<T>(params: {
  schema: AnyZodSchema<T>;
  messages: readonly LlmMessage[];
  opts?: LlmOptions | undefined;
  baseOptions?: BaseLlmClientOptions | undefined;
  invokeAttempt: (
    conversation: readonly LlmMessage[],
    attempt: number,
    opts?: LlmOptions,
  ) => Promise<LlmCompletionOutput>;
}): Promise<LlmGenerateResult<T>> {
  const { schema, messages, opts, baseOptions, invokeAttempt } = params;
  const maxRetries = Math.max(
    0,
    Math.trunc(opts?.maxRetries ?? baseOptions?.defaultMaxRetries ?? DEFAULT_LLM_MAX_RETRIES),
  );
  const effectiveJobId = opts?.jobId ?? baseOptions?.jobId;
  const conversation: LlmMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const totalUsage: LlmUsage = { tokensIn: 0, tokensOut: 0 };
  let lastError = "Saída vazia do modelo.";
  let lastRawText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (opts?.signal?.aborted) {
      throw new LlmUnavailableError("Chamada ao LLM cancelada via AbortSignal.", {
        cause: opts.signal.reason,
      });
    }

    const completion = await invokeAttempt(conversation, attempt, opts);
    const attemptUsage = normalizeLlmUsage(completion.usage);
    totalUsage.tokensIn += attemptUsage.tokensIn;
    totalUsage.tokensOut += attemptUsage.tokensOut;
    lastRawText = completion.rawText;

    if (baseOptions?.jobStore !== undefined && effectiveJobId !== undefined) {
      baseOptions.jobStore.addLlmUsage(effectiveJobId, attemptUsage);
    }
    const usageEvent: LlmUsageEvent = {
      usage: attemptUsage,
      attempt,
      ...(effectiveJobId !== undefined ? { jobId: effectiveJobId } : {}),
    };
    baseOptions?.onUsage?.(usageEvent);
    opts?.onUsage?.(usageEvent);

    let candidate: unknown;
    let jsonParseFailed = false;
    if (completion.mode === "json-string") {
      const rawStr = typeof completion.raw === "string" ? completion.raw : completion.rawText;
      try {
        candidate = JSON.parse(extractJsonFromLlmText(rawStr));
      } catch (err) {
        jsonParseFailed = true;
        lastError = `JSON malformado: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      candidate = completion.raw;
    }

    if (!jsonParseFailed) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) {
        return { data: parsed.data, usage: totalUsage };
      }
      lastError = `Validação Zod falhou: ${formatZodValidationIssues(parsed.error)}`;
    }

    if (attempt < maxRetries) {
      conversation.push({ role: "assistant", content: completion.rawText });
      conversation.push({
        role: "user",
        content: buildValidationRetryPrompt(lastError, attempt + 1, maxRetries),
      });
    }
  }

  throw new LlmInvalidOutputError(
    `Saída do LLM inválida após ${maxRetries + 1} tentativa(s): ${lastError}`,
    {
      details: {
        attempts: maxRetries + 1,
        maxRetries,
        lastError,
        rawOutput: lastRawText,
        usage: totalUsage,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// FakeLlmClient (determinístico para testes)
// ---------------------------------------------------------------------------

export interface FakeLlmResponseEnvelope {
  data?: unknown;
  content?: string | undefined;
  raw?: string | undefined;
  usage?: { tokensIn?: number | undefined; tokensOut?: number | undefined } | undefined;
  error?: Error | undefined;
}

export interface FakeLlmRequest {
  attempt: number;
  messages: readonly LlmMessage[];
  opts?: LlmOptions | undefined;
}

export type FakeLlmStaticResponse =
  | FakeLlmResponseEnvelope
  | string
  | Record<string, unknown>
  | unknown;
export type FakeLlmHandler = (
  request: FakeLlmRequest,
) => FakeLlmStaticResponse | Promise<FakeLlmStaticResponse>;
export type FakeLlmResponseInput = FakeLlmStaticResponse | FakeLlmHandler;
export type FakeLlmMatcher = string | RegExp | ((request: FakeLlmRequest) => boolean);

export interface FakeLlmHandlerEntry {
  matcher: FakeLlmMatcher;
  handler: FakeLlmHandler;
}

export interface FakeLlmCallRecord {
  attempt: number;
  messages: LlmMessage[];
  opts?: LlmOptions | undefined;
  rawOutput: string;
  usage: LlmUsage;
}

export interface FakeLlmClientOptions extends BaseLlmClientOptions {
  responses?: readonly FakeLlmResponseInput[] | undefined;
  fixtures?: Record<string, FakeLlmResponseInput | readonly FakeLlmResponseInput[]> | undefined;
  handlers?: readonly FakeLlmHandlerEntry[] | undefined;
  defaultResponse?: FakeLlmResponseInput | undefined;
  defaultUsage?: LlmUsage | undefined;
}

const ENVELOPE_KEYS = new Set(["data", "content", "raw", "usage", "error"]);

function isResponseEnvelope<T>(
  value: unknown,
  schema: AnyZodSchema<T>,
): value is FakeLlmResponseEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every((k) => ENVELOPE_KEYS.has(k))) return false;
  const hasField =
    "data" in record ||
    typeof record.content === "string" ||
    typeof record.raw === "string" ||
    record.error instanceof Error ||
    (typeof record.usage === "object" && record.usage !== null);
  if (!hasField) return false;
  if (
    !("usage" in record) &&
    !("raw" in record) &&
    !("error" in record) &&
    schema.safeParse(value).success
  ) {
    return false;
  }
  return true;
}

function matchesRequest(matcher: FakeLlmMatcher, req: FakeLlmRequest): boolean {
  if (typeof matcher === "function") return matcher(req);
  const combined = [req.opts?.schemaName ?? "", ...req.messages.map((m) => m.content)].join("\n");
  return typeof matcher === "string"
    ? req.opts?.schemaName === matcher || combined.includes(matcher)
    : matcher.test(combined);
}

export class FakeLlmClient implements TokenSinkAwareClient {
  readonly [BOUND_TOKEN_SINK]?: LlmTokenSink | undefined;
  readonly calls: FakeLlmCallRecord[] = [];
  private readonly queue: FakeLlmResponseInput[] = [];
  private readonly fixtures = new Map<string, FakeLlmResponseInput[]>();
  private readonly handlers: FakeLlmHandlerEntry[] = [];
  private defaultResponse: FakeLlmResponseInput | undefined;
  private readonly defaultUsage: LlmUsage;
  private readonly baseOptions: BaseLlmClientOptions;

  constructor(options?: FakeLlmClientOptions) {
    this.baseOptions = {
      defaultMaxRetries: options?.defaultMaxRetries,
      jobStore: options?.jobStore,
      jobId: options?.jobId,
      onUsage: options?.onUsage,
    };
    this[BOUND_TOKEN_SINK] = options?.jobStore;
    this.defaultUsage = normalizeLlmUsage(options?.defaultUsage ?? { tokensIn: 10, tokensOut: 5 });
    if (options?.responses) this.queue.push(...options.responses);
    if (options?.fixtures) {
      for (const [k, v] of Object.entries(options.fixtures)) this.registerFixture(k, v);
    }
    if (options?.handlers) this.handlers.push(...options.handlers);
    this.defaultResponse = options?.defaultResponse;
  }

  enqueue(...responses: FakeLlmResponseInput[]): this {
    this.queue.push(...responses);
    return this;
  }

  registerFixture(
    key: string,
    response: FakeLlmResponseInput | readonly FakeLlmResponseInput[],
  ): this {
    this.fixtures.set(key, Array.isArray(response) ? [...response] : [response]);
    return this;
  }

  registerHandler(matcher: FakeLlmMatcher, handler: FakeLlmHandler): this {
    this.handlers.push({ matcher, handler });
    return this;
  }

  setDefaultResponse(response: FakeLlmResponseInput): this {
    this.defaultResponse = response;
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
    this.fixtures.clear();
    this.handlers.length = 0;
    this.defaultResponse = undefined;
  }

  async generateObject<T>(
    schema: AnyZodSchema<T>,
    messages: readonly LlmMessage[],
    opts?: LlmOptions,
  ): Promise<LlmGenerateResult<T>> {
    return executeWithValidationRetry({
      schema,
      messages,
      opts,
      baseOptions: this.baseOptions,
      invokeAttempt: async (conversation, attempt, callOpts) => {
        const req: FakeLlmRequest = { attempt, messages: conversation, opts: callOpts };
        const candidate = await this.resolveNextResponse(req);
        const normalized = this.toCompletionOutput(candidate, schema);
        this.calls.push({
          attempt,
          messages: conversation.map((m) => ({ ...m })),
          opts: callOpts,
          rawOutput: normalized.rawText,
          usage: normalized.usage,
        });
        return normalized;
      },
    });
  }

  private async resolveNextResponse(req: FakeLlmRequest): Promise<FakeLlmStaticResponse> {
    if (this.queue.length > 0) {
      const next = this.queue.shift() as FakeLlmResponseInput;
      return typeof next === "function" ? await (next as FakeLlmHandler)(req) : next;
    }
    for (const entry of this.handlers) {
      if (matchesRequest(entry.matcher, req)) return await entry.handler(req);
    }
    if (req.opts?.schemaName !== undefined) {
      const schemaFixtures = this.fixtures.get(req.opts.schemaName);
      if (schemaFixtures !== undefined) return await this.consumeFixtureList(schemaFixtures, req);
    }
    const allText = req.messages.map((m) => m.content).join("\n");
    for (const [key, list] of this.fixtures.entries()) {
      if (allText.includes(key)) return await this.consumeFixtureList(list, req);
    }
    if (this.defaultResponse !== undefined) {
      return typeof this.defaultResponse === "function"
        ? await (this.defaultResponse as FakeLlmHandler)(req)
        : this.defaultResponse;
    }
    throw new LlmInvalidOutputError(
      "FakeLlmClient não possui resposta configurada na fila, fixtures ou handler padrão.",
      { details: { attempt: req.attempt, schemaName: req.opts?.schemaName } },
    );
  }

  private async consumeFixtureList(
    list: FakeLlmResponseInput[],
    req: FakeLlmRequest,
  ): Promise<FakeLlmStaticResponse> {
    const item = list.length > 1 ? (list.shift() as FakeLlmResponseInput) : list[0];
    return typeof item === "function" ? await (item as FakeLlmHandler)(req) : item;
  }

  private toCompletionOutput<T>(
    resolved: FakeLlmStaticResponse,
    schema: AnyZodSchema<T>,
  ): LlmCompletionOutput {
    if (resolved instanceof Error) throw resolved;
    if (typeof resolved === "string") {
      return {
        raw: resolved,
        rawText: resolved,
        mode: "json-string",
        usage: { ...this.defaultUsage },
      };
    }
    if (isResponseEnvelope(resolved, schema)) {
      if (resolved.error instanceof Error) throw resolved.error;
      const usage =
        resolved.usage !== undefined
          ? {
              tokensIn: normalizeTokenCount(resolved.usage.tokensIn ?? this.defaultUsage.tokensIn),
              tokensOut: normalizeTokenCount(
                resolved.usage.tokensOut ?? this.defaultUsage.tokensOut,
              ),
            }
          : { ...this.defaultUsage };
      const textField =
        typeof resolved.raw === "string"
          ? resolved.raw
          : typeof resolved.content === "string"
            ? resolved.content
            : undefined;
      if (textField !== undefined) {
        return { raw: textField, rawText: textField, mode: "json-string", usage };
      }
      return {
        raw: resolved.data,
        rawText: JSON.stringify(resolved.data ?? null),
        mode: "value",
        usage,
      };
    }
    return {
      raw: resolved,
      rawText: JSON.stringify(resolved ?? null),
      mode: "value",
      usage: { ...this.defaultUsage },
    };
  }
}

// ---------------------------------------------------------------------------
// Provedores HTTP MVP: OpenAiCompatibleLlmClient & GeminiLlmClient
// ---------------------------------------------------------------------------

export interface OpenAiCompatibleLlmClientOptions extends BaseLlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function assertProviderCredentials(label: string, apiKey: string, model: string): void {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new ConfigError(`${label} requer apiKey não vazia.`, {
      issues: [{ envVar: "CLEANROOM_LLM_API_KEY", message: "API key obrigatória" }],
    });
  }
  if (!model || model.trim().length === 0) {
    throw new ConfigError(`${label} requer model não vazio.`, {
      issues: [{ envVar: "CLEANROOM_LLM_MODEL", message: "Model obrigatório" }],
    });
  }
}

export class OpenAiCompatibleLlmClient implements TokenSinkAwareClient {
  readonly [BOUND_TOKEN_SINK]?: LlmTokenSink | undefined;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseOptions: BaseLlmClientOptions;

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    assertProviderCredentials("OpenAiCompatibleLlmClient", options.apiKey, options.model);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseOptions = {
      defaultMaxRetries: options.defaultMaxRetries,
      jobStore: options.jobStore,
      jobId: options.jobId,
      onUsage: options.onUsage,
    };
    this[BOUND_TOKEN_SINK] = options.jobStore;
  }

  async generateObject<T>(
    schema: AnyZodSchema<T>,
    messages: readonly LlmMessage[],
    opts?: LlmOptions,
  ): Promise<LlmGenerateResult<T>> {
    return executeWithValidationRetry({
      schema,
      messages,
      opts,
      baseOptions: this.baseOptions,
      invokeAttempt: async (conversation, _attempt, callOpts) => {
        const payload = await postJson<OpenAiChatResponse>({
          providerLabel: "openai-compatible",
          endpoint: `${this.baseUrl}/chat/completions`,
          headers: { authorization: `Bearer ${this.apiKey}` },
          body: {
            model: this.model,
            messages: ensureJsonSystemInstruction(conversation),
            temperature: callOpts?.temperature ?? 0,
            response_format: { type: "json_object" },
            ...(callOpts?.maxTokens !== undefined ? { max_tokens: callOpts.maxTokens } : {}),
          },
          secret: this.apiKey,
          fetchFn: this.fetchFn,
          signal: callOpts?.signal,
        });
        const content = payload.choices?.[0]?.message?.content ?? "";
        return {
          raw: content,
          rawText: content,
          mode: "json-string",
          usage: normalizeLlmUsage({
            tokensIn: payload.usage?.prompt_tokens,
            tokensOut: payload.usage?.completion_tokens,
          }),
        };
      },
    });
  }
}

export interface GeminiLlmClientOptions extends BaseLlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiLlmClient implements TokenSinkAwareClient {
  readonly [BOUND_TOKEN_SINK]?: LlmTokenSink | undefined;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseOptions: BaseLlmClientOptions;

  constructor(options: GeminiLlmClientOptions) {
    assertProviderCredentials("GeminiLlmClient", options.apiKey, options.model);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseOptions = {
      defaultMaxRetries: options.defaultMaxRetries,
      jobStore: options.jobStore,
      jobId: options.jobId,
      onUsage: options.onUsage,
    };
    this[BOUND_TOKEN_SINK] = options.jobStore;
  }

  async generateObject<T>(
    schema: AnyZodSchema<T>,
    messages: readonly LlmMessage[],
    opts?: LlmOptions,
  ): Promise<LlmGenerateResult<T>> {
    return executeWithValidationRetry({
      schema,
      messages,
      opts,
      baseOptions: this.baseOptions,
      invokeAttempt: async (conversation, _attempt, callOpts) => {
        const modelPath = this.model.startsWith("models/")
          ? this.model
          : `models/${encodeURIComponent(this.model)}`;
        const prepared = ensureJsonSystemInstruction(conversation);
        const systemMessages = prepared.filter((m) => m.role === "system");
        const chatMessages = prepared.filter((m) => m.role !== "system");
        const contents =
          chatMessages.length > 0
            ? chatMessages.map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
              }))
            : [{ role: "user", parts: [{ text: "Gere o JSON solicitado." }] }];

        const payload = await postJson<GeminiGenerateContentResponse>({
          providerLabel: "gemini",
          endpoint: `${this.baseUrl}/${modelPath}:generateContent`,
          headers: { "x-goog-api-key": this.apiKey },
          body: {
            ...(systemMessages.length > 0
              ? {
                  systemInstruction: {
                    parts: systemMessages.map((m) => ({ text: m.content })),
                  },
                }
              : {}),
            contents,
            generationConfig: {
              temperature: callOpts?.temperature ?? 0,
              responseMimeType: "application/json",
              ...(callOpts?.maxTokens !== undefined ? { maxOutputTokens: callOpts.maxTokens } : {}),
            },
          },
          secret: this.apiKey,
          fetchFn: this.fetchFn,
          signal: callOpts?.signal,
        });
        const content = (payload.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("");
        return {
          raw: content,
          rawText: content,
          mode: "json-string",
          usage: normalizeLlmUsage({
            tokensIn: payload.usageMetadata?.promptTokenCount,
            tokensOut: payload.usageMetadata?.candidatesTokenCount,
          }),
        };
      },
    });
  }
}

export interface CreateLlmClientOptions extends BaseLlmClientOptions {
  provider: LlmProvider;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  fakeOptions?: FakeLlmClientOptions | undefined;
}

export function createLlmClient(options: CreateLlmClientOptions): LlmClient {
  const { provider } = options;
  if (provider === "fake") {
    return new FakeLlmClient({
      ...options.fakeOptions,
      defaultMaxRetries: options.defaultMaxRetries ?? options.fakeOptions?.defaultMaxRetries,
      jobStore: options.jobStore ?? options.fakeOptions?.jobStore,
      jobId: options.jobId ?? options.fakeOptions?.jobId,
      onUsage: options.onUsage ?? options.fakeOptions?.onUsage,
    });
  }
  if (provider === "openai-compatible" || provider === "openai") {
    return new OpenAiCompatibleLlmClient({
      apiKey: options.apiKey ?? "",
      model: options.model ?? "",
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      defaultMaxRetries: options.defaultMaxRetries,
      jobStore: options.jobStore,
      jobId: options.jobId,
      onUsage: options.onUsage,
    });
  }
  if (provider === "gemini") {
    return new GeminiLlmClient({
      apiKey: options.apiKey ?? "",
      model: options.model ?? "",
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      defaultMaxRetries: options.defaultMaxRetries,
      jobStore: options.jobStore,
      jobId: options.jobId,
      onUsage: options.onUsage,
    });
  }
  throw new ConfigError(
    `Provedor LLM "${provider}" ainda não é suportado no MVP (use openai-compatible, gemini ou fake).`,
    {
      issues: [
        {
          envVar: "CLEANROOM_LLM_PROVIDER",
          message: `Provedor "${provider}" não suportado no MVP`,
        },
      ],
    },
  );
}

export function createLlmClientFromConfig(
  config: CleanroomConfig,
  extra?: Omit<CreateLlmClientOptions, "provider" | "model" | "apiKey" | "baseUrl">,
): LlmClient {
  assertLlmConfig(config);
  return createLlmClient({
    provider: config.llmProvider,
    model: config.llmModel,
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    ...extra,
  });
}

export function bindLlmClientToJob(
  client: LlmClient,
  store: LlmTokenSink,
  jobId: string,
  onAfterAttempt?: () => void,
): LlmClient {
  const alreadyBoundToSameStore = (client as TokenSinkAwareClient)[BOUND_TOKEN_SINK] === store;
  return {
    async generateObject<T>(
      schema: AnyZodSchema<T>,
      messages: readonly LlmMessage[],
      opts?: LlmOptions,
    ): Promise<LlmGenerateResult<T>> {
      const targetJobId = opts?.jobId ?? jobId;
      let attemptUsageRecorded = false;
      const result = await client.generateObject(schema, messages, {
        ...opts,
        jobId: targetJobId,
        onUsage: (event) => {
          attemptUsageRecorded = true;
          if (!alreadyBoundToSameStore) store.addLlmUsage(targetJobId, event.usage);
          onAfterAttempt?.();
          opts?.onUsage?.(event);
        },
      });
      if (!attemptUsageRecorded && !alreadyBoundToSameStore) {
        store.addLlmUsage(targetJobId, result.usage);
        onAfterAttempt?.();
      }
      return result;
    },
  };
}
