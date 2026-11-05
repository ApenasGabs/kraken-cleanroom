import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ConfigError,
  LLM_PROVIDERS,
  type LlmProvider,
  loadConfig,
  redactUrlTokens,
} from "@cleanroom/core";
import { chromium } from "playwright-core";

export type DoctorCheckStatus = "ok" | "fail";

export interface DoctorCheckResult {
  id: "dataDir" | "browser" | "llm";
  label: string;
  status: DoctorCheckStatus;
  message: string;
  missingEnvVars?: readonly string[] | undefined;
  details?: Record<string, string | number | boolean> | undefined;
}

export interface DoctorReport {
  ok: boolean;
  checks: readonly DoctorCheckResult[];
  missingEnvVars: readonly string[];
}

export interface CdpConnectionProbe {
  connectAndOpenBlank(wsEndpoint: string, timeoutMs: number): Promise<{ browserVersion?: string }>;
}

export interface LlmProbeContext {
  provider: LlmProvider;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export type LlmConnectivityProbe = (ctx: LlmProbeContext) => Promise<void>;

export interface DoctorOptions {
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
  cdpTimeoutMs?: number | undefined;
  cdpProbe?: CdpConnectionProbe | undefined;
  llmProbe?: LlmConnectivityProbe | undefined;
}

const SENSITIVE_ENV_KEYS = [
  "CLEANROOM_BROWSER_WS_ENDPOINT",
  "CLEANROOM_LLM_API_KEY",
  "CLEANROOM_API_TOKEN",
  "CLEANROOM_INBOX_HMAC_SECRET",
  "CLEANROOM_CREDENTIALS_KEY",
] as const;

export function sanitizeEndpointForDisplay(rawEndpoint: string): string {
  const tokenRedacted = redactUrlTokens(rawEndpoint);
  try {
    const parsed = new URL(tokenRedacted);
    if (parsed.username) {
      parsed.username = "[REDACTED]";
    }
    if (parsed.password) {
      parsed.password = "[REDACTED]";
    }
    for (const [key] of parsed.searchParams.entries()) {
      if (/^(token|api[_-]?key|key|secret|password|auth|access[_-]?token|sig)$/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return redactUrlTokens(parsed.toString());
  } catch {
    return tokenRedacted.replace(
      /([?&](?:token|api[_-]?key|key|secret|password|auth|access[_-]?token)=)([^&#\s]+)/gi,
      "$1[REDACTED]",
    );
  }
}

export function collectSensitiveValues(env: Record<string, string | undefined>): string[] {
  const secrets = new Set<string>();

  for (const key of SENSITIVE_ENV_KEYS) {
    const raw = env[key]?.trim();
    if (!raw) {
      continue;
    }
    if (key === "CLEANROOM_BROWSER_WS_ENDPOINT") {
      try {
        const parsed = new URL(raw);
        if (parsed.password && parsed.password.length >= 3) {
          secrets.add(parsed.password);
        }
        for (const [, value] of parsed.searchParams.entries()) {
          if (value.trim().length >= 3) {
            secrets.add(value.trim());
          }
        }
      } catch {
        const match = raw.match(/[?&][^=]+=([^&#\s]+)/);
        if (match?.[1] && match[1].length >= 3) {
          secrets.add(match[1]);
        }
      }
    } else if (raw.length >= 3) {
      secrets.add(raw);
    }
  }

  return Array.from(secrets).sort((a, b) => b.length - a.length);
}

export function redactDoctorText(
  text: string,
  env: Record<string, string | undefined> = {},
): string {
  let sanitized = redactUrlTokens(text);
  sanitized = sanitized.replace(
    /([?&](?:token|api[_-]?key|key|secret|password|auth|access[_-]?token)=)([^&#\s]+)/gi,
    "$1[REDACTED]",
  );
  sanitized = sanitized.replace(/((?:wss?|https?):\/\/)([^/@\s]+:[^/@\s]+)@/gi, "$1[REDACTED]@");

  const secrets = collectSensitiveValues(env);
  for (const secret of secrets) {
    if (secret.length > 0 && sanitized.includes(secret)) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized;
}

export const defaultCdpProbe: CdpConnectionProbe = {
  async connectAndOpenBlank(
    wsEndpoint: string,
    timeoutMs: number,
  ): Promise<{ browserVersion?: string }> {
    const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: timeoutMs });
    try {
      const browserVersion = browser.version();
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto("about:blank", { timeout: timeoutMs });
      } finally {
        await context.close();
      }
      return browserVersion ? { browserVersion } : {};
    } finally {
      await browser.close();
    }
  },
};

async function checkDataDir(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<DoctorCheckResult> {
  const rawDir = env.CLEANROOM_DATA_DIR;
  if (rawDir !== undefined && rawDir.trim().length === 0) {
    return {
      id: "dataDir",
      label: "Diretório de dados (CLEANROOM_DATA_DIR)",
      status: "fail",
      message: "CLEANROOM_DATA_DIR está vazio. Defina um caminho de diretório gravável.",
      missingEnvVars: ["CLEANROOM_DATA_DIR"],
    };
  }

  const configuredDir = rawDir?.trim() ?? "./data";
  const resolvedDir = resolve(cwd, configuredDir);
  const probeFile = join(
    resolvedDir,
    `.cleanroom-doctor-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );

  try {
    await mkdir(resolvedDir, { recursive: true });
    await writeFile(probeFile, "ok", { encoding: "utf8", mode: 0o600 });
    await unlink(probeFile);

    return {
      id: "dataDir",
      label: "Diretório de dados (CLEANROOM_DATA_DIR)",
      status: "ok",
      message: `Diretório gravável verificado em "${resolvedDir}".`,
      details: {
        path: resolvedDir,
        explicitEnv: rawDir !== undefined,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      id: "dataDir",
      label: "Diretório de dados (CLEANROOM_DATA_DIR)",
      status: "fail",
      message: redactDoctorText(
        `Não foi possível gravar em CLEANROOM_DATA_DIR ("${resolvedDir}"): ${reason}`,
        env,
      ),
      details: {
        path: resolvedDir,
      },
    };
  }
}

async function checkBrowserCdp(
  env: Record<string, string | undefined>,
  cdpProbe: CdpConnectionProbe,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  const rawEndpoint = env.CLEANROOM_BROWSER_WS_ENDPOINT?.trim();
  if (!rawEndpoint) {
    return {
      id: "browser",
      label: "Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)",
      status: "fail",
      message:
        "Variável CLEANROOM_BROWSER_WS_ENDPOINT ausente. Defina o endpoint WebSocket CDP do Browserless (ws://<host>:<port> ou wss://<host>:<port>).",
      missingEnvVars: ["CLEANROOM_BROWSER_WS_ENDPOINT"],
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawEndpoint);
  } catch {
    return {
      id: "browser",
      label: "Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)",
      status: "fail",
      message: redactDoctorText(
        "CLEANROOM_BROWSER_WS_ENDPOINT inválido: esperado URL ws:// ou wss://.",
        env,
      ),
    };
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    return {
      id: "browser",
      label: "Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)",
      status: "fail",
      message: redactDoctorText(
        `CLEANROOM_BROWSER_WS_ENDPOINT deve usar protocolo ws:// ou wss:// (recebido "${parsedUrl.protocol}").`,
        env,
      ),
    };
  }

  const displayEndpoint = sanitizeEndpointForDisplay(rawEndpoint);

  try {
    const result = await cdpProbe.connectAndOpenBlank(rawEndpoint, timeoutMs);
    const versionSuffix = result.browserVersion ? ` (versão: ${result.browserVersion})` : "";
    return {
      id: "browser",
      label: "Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)",
      status: "ok",
      message: redactDoctorText(
        `Conectado ao Browserless via CDP (${displayEndpoint}) e aberto about:blank com sucesso${versionSuffix}.`,
        env,
      ),
      details: {
        endpoint: displayEndpoint,
        ...(result.browserVersion ? { browserVersion: result.browserVersion } : {}),
      },
    };
  } catch (err) {
    const rawReason = err instanceof Error ? err.message : String(err);
    const safeReason = redactDoctorText(rawReason, env);
    return {
      id: "browser",
      label: "Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)",
      status: "fail",
      message: `Falha ao conectar via CDP em ${displayEndpoint}: ${safeReason}`,
      details: {
        endpoint: displayEndpoint,
      },
    };
  }
}

async function checkLlmConfig(
  env: Record<string, string | undefined>,
  llmProbe?: LlmConnectivityProbe,
): Promise<DoctorCheckResult> {
  const rawProvider = env.CLEANROOM_LLM_PROVIDER?.trim();
  const rawModel = env.CLEANROOM_LLM_MODEL?.trim();
  const rawApiKey = env.CLEANROOM_LLM_API_KEY?.trim();
  const rawBaseUrl = env.CLEANROOM_LLM_BASE_URL?.trim();

  if (!rawProvider) {
    const missing: string[] = ["CLEANROOM_LLM_PROVIDER"];
    if (!rawModel) {
      missing.push("CLEANROOM_LLM_MODEL");
    }
    if (!rawApiKey) {
      missing.push("CLEANROOM_LLM_API_KEY");
    }
    return {
      id: "llm",
      label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
      status: "fail",
      message: `Variáveis de ambiente de LLM ausentes: ${missing.join(", ")} (ou defina CLEANROOM_LLM_PROVIDER=fake para modo de teste).`,
      missingEnvVars: missing,
    };
  }

  if (!LLM_PROVIDERS.includes(rawProvider as LlmProvider)) {
    return {
      id: "llm",
      label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
      status: "fail",
      message: `CLEANROOM_LLM_PROVIDER inválido ("${redactDoctorText(rawProvider, env)}"). Valores aceitos: ${LLM_PROVIDERS.join(", ")}.`,
    };
  }

  const provider = rawProvider as LlmProvider;

  if (provider === "fake") {
    if (llmProbe) {
      try {
        await llmProbe({ provider });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          id: "llm",
          label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
          status: "fail",
          message: redactDoctorText(`Falha na verificação do provedor LLM fake: ${reason}`, env),
        };
      }
    }
    return {
      id: "llm",
      label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
      status: "ok",
      message: 'Provedor LLM configurado como "fake" (modo determinístico para testes).',
      details: {
        provider: "fake",
      },
    };
  }

  const missingForRealProvider: string[] = [];
  if (!rawModel) {
    missingForRealProvider.push("CLEANROOM_LLM_MODEL");
  }
  if (!rawApiKey) {
    missingForRealProvider.push("CLEANROOM_LLM_API_KEY");
  }

  if (missingForRealProvider.length > 0) {
    return {
      id: "llm",
      label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
      status: "fail",
      message: `Configuração incompleta para CLEANROOM_LLM_PROVIDER="${provider}": faltam ${missingForRealProvider.join(", ")}.`,
      missingEnvVars: missingForRealProvider,
      details: {
        provider,
      },
    };
  }

  if (rawBaseUrl) {
    try {
      const parsedBase = new URL(rawBaseUrl);
      if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
        return {
          id: "llm",
          label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
          status: "fail",
          message: "CLEANROOM_LLM_BASE_URL deve usar protocolo http:// ou https://.",
        };
      }
    } catch {
      return {
        id: "llm",
        label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
        status: "fail",
        message: "CLEANROOM_LLM_BASE_URL não é uma URL http(s) válida.",
      };
    }
  }

  if (llmProbe) {
    try {
      await llmProbe({
        provider,
        model: rawModel,
        apiKey: rawApiKey,
        baseUrl: rawBaseUrl,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        id: "llm",
        label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
        status: "fail",
        message: redactDoctorText(
          `Falha ao verificar provedor LLM "${provider}" (modelo "${rawModel}"): ${reason}`,
          env,
        ),
        details: {
          provider,
          model: rawModel ?? "",
          apiKey: "[REDACTED]",
        },
      };
    }
  }

  return {
    id: "llm",
    label: "Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)",
    status: "ok",
    message: redactDoctorText(
      `Provedor LLM "${provider}" configurado (modelo: "${rawModel}", apiKey: [REDACTED]).`,
      env,
    ),
    details: {
      provider,
      model: rawModel ?? "",
      apiKey: "[REDACTED]",
      ...(rawBaseUrl ? { baseUrl: sanitizeEndpointForDisplay(rawBaseUrl) } : {}),
    },
  };
}

export async function runDoctor(options?: DoctorOptions): Promise<DoctorReport> {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const cdpTimeoutMs = options?.cdpTimeoutMs ?? 10_000;
  const cdpProbe = options?.cdpProbe ?? defaultCdpProbe;

  // Validate auxiliary config syntax without leaking secrets
  let configSyntaxError: ConfigError | null = null;
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      configSyntaxError = err;
    }
  }

  const dataDirResult = await checkDataDir(env, cwd);
  const browserResult = await checkBrowserCdp(env, cdpProbe, cdpTimeoutMs);
  const llmResult = await checkLlmConfig(env, options?.llmProbe);

  const checks: DoctorCheckResult[] = [dataDirResult, browserResult, llmResult];

  if (configSyntaxError) {
    for (const issue of configSyntaxError.issues) {
      if (
        issue.envVar !== "CLEANROOM_DATA_DIR" &&
        issue.envVar !== "CLEANROOM_BROWSER_WS_ENDPOINT" &&
        issue.envVar !== "CLEANROOM_LLM_PROVIDER" &&
        issue.envVar !== "CLEANROOM_LLM_BASE_URL"
      ) {
        checks.push({
          id: "dataDir",
          label: `Configuração (${issue.envVar})`,
          status: "fail",
          message: redactDoctorText(`${issue.envVar}: ${issue.message}`, env),
        });
      }
    }
  }

  const missingSet = new Set<string>();
  for (const check of checks) {
    if (check.missingEnvVars) {
      for (const envVar of check.missingEnvVars) {
        missingSet.add(envVar);
      }
    }
  }

  const ok = checks.every((check) => check.status === "ok");
  return {
    ok,
    checks,
    missingEnvVars: Array.from(missingSet),
  };
}

export function formatDoctorReport(
  report: DoctorReport,
  env: Record<string, string | undefined> = {},
): string {
  const lines: string[] = ["Diagnóstico do ambiente kraken-cleanroom (cleanroom doctor):", ""];

  for (const check of report.checks) {
    const icon = check.status === "ok" ? "[OK]" : "[FALHA]";
    lines.push(`${icon} ${check.label}`);
    lines.push(`     ${redactDoctorText(check.message, env)}`);
  }

  if (report.missingEnvVars.length > 0) {
    lines.push("");
    lines.push(`Variáveis de ambiente ausentes: ${report.missingEnvVars.join(", ")}`);
  }

  lines.push("");
  lines.push(
    report.ok
      ? "Resultado: Ambiente pronto para execução (todos os checks passaram)."
      : "Resultado: Ambiente incompleto ou com falhas de conectividade.",
  );

  return redactDoctorText(lines.join("\n"), env);
}
