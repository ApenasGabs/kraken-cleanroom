import { z } from "zod";
import { ConfigError, type ConfigIssue } from "./errors.js";

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openai-compatible",
  "fake",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CleanroomConfig {
  dataDir: string;
  browserWsEndpoint?: string;
  llmProvider: LlmProvider;
  llmModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  httpPort: number;
  apiToken?: string;
  maxConcurrentJobs: number;
  logLevel: LogLevel;
  notifyWebhookUrl?: string;
  publicUrl?: string;
  inboxDomain: string;
  inboxHmacSecret?: string;
  credentialsKey?: string;
}

export interface LoadConfigOptions {
  requireBrowser?: boolean | undefined;
  requireLlm?: boolean | undefined;
}

function isValidUrlWithProtocols(value: string, allowedProtocols: readonly string[]): boolean {
  try {
    const parsed = new URL(value);
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

const optionalNonEmptyString = z.preprocess((val) => {
  if (typeof val !== "string") {
    return undefined;
  }
  const trimmed = val.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(1).optional());

const optionalHttpUrl = (envName: string) =>
  optionalNonEmptyString.refine(
    (val) => val === undefined || isValidUrlWithProtocols(val, ["http:", "https:"]),
    { message: `${envName} must be a valid http:// or https:// URL` },
  );

const optionalWsUrl = (envName: string) =>
  optionalNonEmptyString.refine(
    (val) => val === undefined || isValidUrlWithProtocols(val, ["ws:", "wss:"]),
    { message: `${envName} must be a valid ws:// or wss:// WebSocket URL` },
  );

const envSchema = z.object({
  CLEANROOM_DATA_DIR: z
    .string()
    .default("./data")
    .transform((val) => val.trim())
    .refine((val) => val.length > 0, {
      message: "CLEANROOM_DATA_DIR must be a non-empty directory path",
    }),

  CLEANROOM_BROWSER_WS_ENDPOINT: optionalWsUrl("CLEANROOM_BROWSER_WS_ENDPOINT"),

  CLEANROOM_LLM_PROVIDER: z.preprocess(
    (val) => {
      if (typeof val !== "string" || val.trim().length === 0) {
        return "fake";
      }
      return val.trim();
    },
    z.enum(LLM_PROVIDERS, {
      errorMap: () => ({
        message: `CLEANROOM_LLM_PROVIDER must be one of: ${LLM_PROVIDERS.join(", ")}`,
      }),
    }),
  ),

  CLEANROOM_LLM_MODEL: optionalNonEmptyString,
  CLEANROOM_LLM_API_KEY: optionalNonEmptyString,
  CLEANROOM_LLM_BASE_URL: optionalHttpUrl("CLEANROOM_LLM_BASE_URL"),

  CLEANROOM_HTTP_PORT: z
    .string()
    .default("4870")
    .transform((val) => val.trim())
    .refine((val) => /^\d+$/.test(val), {
      message: "CLEANROOM_HTTP_PORT must be an integer between 1 and 65535",
    })
    .transform((val) => Number.parseInt(val, 10))
    .refine((port) => Number.isInteger(port) && port >= 1 && port <= 65535, {
      message: "CLEANROOM_HTTP_PORT must be an integer between 1 and 65535",
    }),

  CLEANROOM_API_TOKEN: optionalNonEmptyString,

  CLEANROOM_MAX_CONCURRENT_JOBS: z
    .string()
    .default("1")
    .transform((val) => val.trim())
    .refine((val) => /^\d+$/.test(val), {
      message: "CLEANROOM_MAX_CONCURRENT_JOBS must be a positive integer (>= 1)",
    })
    .transform((val) => Number.parseInt(val, 10))
    .refine((n) => Number.isInteger(n) && n >= 1, {
      message: "CLEANROOM_MAX_CONCURRENT_JOBS must be a positive integer (>= 1)",
    }),

  CLEANROOM_LOG_LEVEL: z
    .string()
    .default("info")
    .transform((val) => val.trim().toLowerCase())
    .pipe(
      z.enum(LOG_LEVELS, {
        errorMap: () => ({
          message: `CLEANROOM_LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`,
        }),
      }),
    ),

  CLEANROOM_NOTIFY_WEBHOOK_URL: optionalHttpUrl("CLEANROOM_NOTIFY_WEBHOOK_URL"),
  CLEANROOM_PUBLIC_URL: optionalHttpUrl("CLEANROOM_PUBLIC_URL"),

  CLEANROOM_INBOX_DOMAIN: z.preprocess((val) => {
    if (typeof val !== "string" || val.trim().length === 0) {
      return "lab.example.com";
    }
    return val.trim();
  }, z.string().min(1)),

  CLEANROOM_INBOX_HMAC_SECRET: optionalNonEmptyString,
  CLEANROOM_CREDENTIALS_KEY: optionalNonEmptyString,
});

function buildConfigError(issues: readonly ConfigIssue[]): ConfigError {
  const summary = issues.map((issue) => `${issue.envVar}: ${issue.message}`).join("; ");
  return new ConfigError(`Invalid Cleanroom configuration: ${summary}`, { issues });
}

export function assertBrowserConfig(
  config: CleanroomConfig,
): CleanroomConfig & { browserWsEndpoint: string } {
  if (!config.browserWsEndpoint) {
    throw buildConfigError([
      {
        envVar: "CLEANROOM_BROWSER_WS_ENDPOINT",
        message:
          "CLEANROOM_BROWSER_WS_ENDPOINT is required when browser execution is enabled (expected ws:// or wss:// URL)",
      },
    ]);
  }
  return config as CleanroomConfig & { browserWsEndpoint: string };
}

export function assertLlmConfig(config: CleanroomConfig): CleanroomConfig {
  if (config.llmProvider === "fake") {
    return config;
  }
  const issues: ConfigIssue[] = [];
  if (!config.llmModel) {
    issues.push({
      envVar: "CLEANROOM_LLM_MODEL",
      message: `CLEANROOM_LLM_MODEL is required when CLEANROOM_LLM_PROVIDER is "${config.llmProvider}"`,
    });
  }
  if (!config.llmApiKey) {
    issues.push({
      envVar: "CLEANROOM_LLM_API_KEY",
      message: `CLEANROOM_LLM_API_KEY is required when CLEANROOM_LLM_PROVIDER is "${config.llmProvider}"`,
    });
  }
  if (issues.length > 0) {
    throw buildConfigError(issues);
  }
  return config;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options?: LoadConfigOptions,
): CleanroomConfig {
  const parsed = envSchema.safeParse(env);
  const issues: ConfigIssue[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const envVar = String(issue.path[0] ?? "ENVIRONMENT");
      issues.push({
        envVar,
        message: issue.message,
      });
    }
    throw buildConfigError(issues);
  }

  const raw = parsed.data;
  const config: CleanroomConfig = {
    dataDir: raw.CLEANROOM_DATA_DIR,
    ...(raw.CLEANROOM_BROWSER_WS_ENDPOINT !== undefined
      ? { browserWsEndpoint: raw.CLEANROOM_BROWSER_WS_ENDPOINT }
      : {}),
    llmProvider: raw.CLEANROOM_LLM_PROVIDER,
    ...(raw.CLEANROOM_LLM_MODEL !== undefined ? { llmModel: raw.CLEANROOM_LLM_MODEL } : {}),
    ...(raw.CLEANROOM_LLM_API_KEY !== undefined ? { llmApiKey: raw.CLEANROOM_LLM_API_KEY } : {}),
    ...(raw.CLEANROOM_LLM_BASE_URL !== undefined ? { llmBaseUrl: raw.CLEANROOM_LLM_BASE_URL } : {}),
    httpPort: raw.CLEANROOM_HTTP_PORT,
    ...(raw.CLEANROOM_API_TOKEN !== undefined ? { apiToken: raw.CLEANROOM_API_TOKEN } : {}),
    maxConcurrentJobs: raw.CLEANROOM_MAX_CONCURRENT_JOBS,
    logLevel: raw.CLEANROOM_LOG_LEVEL,
    ...(raw.CLEANROOM_NOTIFY_WEBHOOK_URL !== undefined
      ? { notifyWebhookUrl: raw.CLEANROOM_NOTIFY_WEBHOOK_URL }
      : {}),
    ...(raw.CLEANROOM_PUBLIC_URL !== undefined ? { publicUrl: raw.CLEANROOM_PUBLIC_URL } : {}),
    inboxDomain: raw.CLEANROOM_INBOX_DOMAIN,
    ...(raw.CLEANROOM_INBOX_HMAC_SECRET !== undefined
      ? { inboxHmacSecret: raw.CLEANROOM_INBOX_HMAC_SECRET }
      : {}),
    ...(raw.CLEANROOM_CREDENTIALS_KEY !== undefined
      ? { credentialsKey: raw.CLEANROOM_CREDENTIALS_KEY }
      : {}),
  };

  if (options?.requireBrowser) {
    assertBrowserConfig(config);
  }
  if (options?.requireLlm) {
    assertLlmConfig(config);
  }

  return config;
}
