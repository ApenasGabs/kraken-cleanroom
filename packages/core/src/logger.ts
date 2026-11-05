import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import { LOG_LEVELS, type LogLevel } from "./config.js";

export type Logger = PinoLogger;

export const REDACT_PATHS = [
  "*.password",
  "*.token",
  "*.authorization",
  "*.cookie",
  "headers.cookie",
  "headers.authorization",
  "password",
  "token",
  "authorization",
  "cookie",
  "set-cookie",
  "apiKey",
  "api_key",
  "secret",
  "*.*.password",
  "*.*.token",
  "*.*.authorization",
  "*.*.cookie",
  'headers["set-cookie"]',
] as const;

const SENSITIVE_KEY_PATTERN =
  /^(?:password|passwd|pwd|token|access_token|refresh_token|api_token|auth_token|authorization|cookie|set-cookie|apikey|api_key|secret|client_secret|hmac_secret|credentials_key|private_key)$/i;

const URL_TOKEN_PATTERN = /(\b(?:[a-zA-Z0-9_.-]*_)?token=)([^&#\s"',;)]+)/gi;

/**
 * Redacts `token=<value>` query/URL parameters in any string.
 * Example: `ws://host:9222?token=abc` -> `ws://host:9222?token=[REDACTED]`
 */
export function redactUrlTokens(input: string): string {
  return input.replace(URL_TOKEN_PATTERN, "$1[REDACTED]");
}

/**
 * Recursively sanitizes log values:
 * - Redacts `token=` in any string
 * - Redacts values of sensitive keys (`password`, `token`, `authorization`, `cookie`, etc.) at any depth
 * - Sanitizes `Error` instances without losing `name`, `message`, `code`, `stack`, or `cause`
 */
export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactUrlTokens(value);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, seen));
  }

  if (value instanceof Error) {
    const errRecord: Record<string, unknown> = {
      type: value.name,
      name: value.name,
      message: redactUrlTokens(value.message),
    };
    if (typeof value.stack === "string") {
      errRecord.stack = redactUrlTokens(value.stack);
    }
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        errRecord[k] = "[REDACTED]";
      } else {
        errRecord[k] = sanitizeLogValue(v, seen);
      }
    }
    if (value.cause !== undefined) {
      errRecord.cause = sanitizeLogValue(value.cause, seen);
    }
    return errRecord;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeLogValue(val, seen);
    }
  }
  return result;
}

function resolveLogLevel(explicitLevel?: LogLevel): LogLevel {
  if (explicitLevel !== undefined) {
    return explicitLevel;
  }
  const envLevel = process.env.CLEANROOM_LOG_LEVEL?.trim().toLowerCase();
  if (envLevel && (LOG_LEVELS as readonly string[]).includes(envLevel)) {
    return envLevel as LogLevel;
  }
  return "info";
}

function wrapChildLogger(instance: PinoLogger): PinoLogger {
  const originalChild = instance.child.bind(instance);
  instance.child = ((bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => {
    const sanitizedBindings = sanitizeLogValue(bindings) as pino.Bindings;
    const childLogger = originalChild(sanitizedBindings, options);
    return wrapChildLogger(childLogger);
  }) as unknown as typeof instance.child;
  return instance;
}

export interface CreateLoggerOptions {
  level?: LogLevel | undefined;
  name?: string | undefined;
  base?: Record<string, unknown> | undefined;
  destination?: DestinationStream | undefined;
}

export function createLogger(
  options?: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const level = resolveLogLevel(options?.level);
  const stream = destination ?? options?.destination;

  const pinoOptions: pino.LoggerOptions = {
    level,
    ...(options?.name !== undefined ? { name: options.name } : {}),
    ...(options?.base !== undefined
      ? { base: sanitizeLogValue(options.base) as Record<string, unknown> }
      : {}),
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    formatters: {
      bindings(bindings) {
        return sanitizeLogValue(bindings) as Record<string, unknown>;
      },
      log(object) {
        return sanitizeLogValue(object) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(args, method) {
        const sanitizedArgs = args.map((arg) => sanitizeLogValue(arg));
        return method.apply(this, sanitizedArgs as Parameters<typeof method>);
      },
    },
  };

  const logger = stream !== undefined ? pino(pinoOptions, stream) : pino(pinoOptions);
  return wrapChildLogger(logger);
}
