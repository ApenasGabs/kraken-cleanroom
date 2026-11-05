export const CLEANROOM_ERROR_CODES = [
  "CONFIG_INVALID",
  "MANIFEST_INVALID",
  "METHOD_NOT_ALLOWED",
  "OUT_OF_SCOPE",
  "DESTRUCTIVE_ACTION_FORBIDDEN",
  "BROWSER_UNAVAILABLE",
  "LLM_INVALID_OUTPUT",
  "LLM_UNAVAILABLE",
  "JOB_NOT_FOUND",
  "JOB_CONFLICT",
  "JOB_BLOCKED",
  "EVIDENCE_NOT_FOUND",
  "HANDOFF_NOT_FOUND",
  "UNAUTHORIZED",
] as const;

export type CleanroomErrorCode = (typeof CLEANROOM_ERROR_CODES)[number];

const DEFAULT_STATUS_BY_CODE: Record<CleanroomErrorCode, number> = {
  CONFIG_INVALID: 500,
  MANIFEST_INVALID: 422,
  METHOD_NOT_ALLOWED: 403,
  OUT_OF_SCOPE: 403,
  DESTRUCTIVE_ACTION_FORBIDDEN: 403,
  BROWSER_UNAVAILABLE: 503,
  LLM_INVALID_OUTPUT: 502,
  LLM_UNAVAILABLE: 503,
  JOB_NOT_FOUND: 404,
  JOB_CONFLICT: 409,
  JOB_BLOCKED: 422,
  EVIDENCE_NOT_FOUND: 404,
  HANDOFF_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
};

export interface CleanroomErrorOptions {
  statusCode?: number | undefined;
  details?: unknown;
  cause?: unknown;
}

export interface SerializedCleanroomError {
  name: string;
  code: CleanroomErrorCode;
  message: string;
  statusCode: number;
  details?: unknown;
  cause?: unknown;
}

export interface ErrorEnvelope {
  error: {
    code: CleanroomErrorCode;
    message: string;
    details?: unknown;
  };
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof CleanroomError) {
    return cause.toJSON();
  }
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
    };
  }
  return cause;
}

export class CleanroomError extends Error {
  readonly code: CleanroomErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: CleanroomErrorCode, message: string, options?: CleanroomErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = options?.statusCode ?? DEFAULT_STATUS_BY_CODE[code];
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedCleanroomError {
    const serialized: SerializedCleanroomError = {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
    if (this.details !== undefined) {
      serialized.details = this.details;
    }
    if (this.cause !== undefined) {
      serialized.cause = serializeCause(this.cause);
    }
    return serialized;
  }

  toErrorEnvelope(): ErrorEnvelope {
    const errorObj: ErrorEnvelope["error"] = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      errorObj.details = this.details;
    }
    return { error: errorObj };
  }
}

export interface ConfigIssue {
  envVar: string;
  message: string;
}

export class ConfigError extends CleanroomError {
  readonly issues: readonly ConfigIssue[];

  constructor(
    message: string,
    options?: CleanroomErrorOptions & { issues?: readonly ConfigIssue[] | undefined },
  ) {
    const issues = options?.issues ?? [];
    super("CONFIG_INVALID", message, {
      statusCode: options?.statusCode ?? 500,
      details: options?.details ?? (issues.length > 0 ? { issues } : undefined),
      cause: options?.cause,
    });
    this.issues = issues;
  }
}

export interface ManifestIssueDetail {
  path: string;
  message: string;
}

export class ManifestError extends CleanroomError {
  readonly issues: readonly ManifestIssueDetail[];

  constructor(
    message: string,
    options?: CleanroomErrorOptions & { issues?: readonly ManifestIssueDetail[] | undefined },
  ) {
    const issues = options?.issues ?? [];
    super("MANIFEST_INVALID", message, {
      statusCode: options?.statusCode ?? 422,
      details: options?.details ?? (issues.length > 0 ? { issues } : undefined),
      cause: options?.cause,
    });
    this.issues = issues;
  }
}

export class MethodNotAllowedError extends CleanroomError {
  readonly method?: string;

  constructor(message: string, options?: CleanroomErrorOptions & { method?: string | undefined }) {
    super("METHOD_NOT_ALLOWED", message, {
      statusCode: options?.statusCode ?? 403,
      details:
        options?.details ??
        (options?.method !== undefined ? { method: options.method } : undefined),
      cause: options?.cause,
    });
    if (options?.method !== undefined) {
      this.method = options.method;
    }
  }
}

export class OutOfScopeError extends CleanroomError {
  readonly url?: string;

  constructor(message: string, options?: CleanroomErrorOptions & { url?: string | undefined }) {
    super("OUT_OF_SCOPE", message, {
      statusCode: options?.statusCode ?? 403,
      details: options?.details ?? (options?.url !== undefined ? { url: options.url } : undefined),
      cause: options?.cause,
    });
    if (options?.url !== undefined) {
      this.url = options.url;
    }
  }
}

export class DestructiveActionError extends CleanroomError {
  readonly actionLabel?: string;

  constructor(
    message: string,
    options?: CleanroomErrorOptions & { actionLabel?: string | undefined },
  ) {
    super("DESTRUCTIVE_ACTION_FORBIDDEN", message, {
      statusCode: options?.statusCode ?? 403,
      details:
        options?.details ??
        (options?.actionLabel !== undefined ? { actionLabel: options.actionLabel } : undefined),
      cause: options?.cause,
    });
    if (options?.actionLabel !== undefined) {
      this.actionLabel = options.actionLabel;
    }
  }
}

export class BrowserUnavailableError extends CleanroomError {
  constructor(message: string, options?: CleanroomErrorOptions) {
    super("BROWSER_UNAVAILABLE", message, options);
  }
}

export class LlmInvalidOutputError extends CleanroomError {
  constructor(message: string, options?: CleanroomErrorOptions) {
    super("LLM_INVALID_OUTPUT", message, options);
  }
}

export class LlmUnavailableError extends CleanroomError {
  constructor(message: string, options?: CleanroomErrorOptions) {
    super("LLM_UNAVAILABLE", message, options);
  }
}

export class JobNotFoundError extends CleanroomError {
  readonly jobId?: string;

  constructor(message: string, options?: CleanroomErrorOptions & { jobId?: string | undefined }) {
    super("JOB_NOT_FOUND", message, {
      statusCode: options?.statusCode ?? 404,
      details:
        options?.details ?? (options?.jobId !== undefined ? { jobId: options.jobId } : undefined),
      cause: options?.cause,
    });
    if (options?.jobId !== undefined) {
      this.jobId = options.jobId;
    }
  }
}

export class JobConflictError extends CleanroomError {
  constructor(message: string, options?: CleanroomErrorOptions) {
    super("JOB_CONFLICT", message, options);
  }
}

export class JobBlockedError extends CleanroomError {
  readonly reason?: string;

  constructor(message: string, options?: CleanroomErrorOptions & { reason?: string | undefined }) {
    super("JOB_BLOCKED", message, {
      statusCode: options?.statusCode ?? 422,
      details:
        options?.details ??
        (options?.reason !== undefined ? { reason: options.reason } : undefined),
      cause: options?.cause,
    });
    if (options?.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export class EvidenceNotFoundError extends CleanroomError {
  readonly evidenceId?: string;

  constructor(
    message: string,
    options?: CleanroomErrorOptions & { evidenceId?: string | undefined },
  ) {
    super("EVIDENCE_NOT_FOUND", message, {
      statusCode: options?.statusCode ?? 404,
      details:
        options?.details ??
        (options?.evidenceId !== undefined ? { evidenceId: options.evidenceId } : undefined),
      cause: options?.cause,
    });
    if (options?.evidenceId !== undefined) {
      this.evidenceId = options.evidenceId;
    }
  }
}

export class HandoffNotFoundError extends CleanroomError {
  readonly handoffId?: string;

  constructor(
    message: string,
    options?: CleanroomErrorOptions & { handoffId?: string | undefined },
  ) {
    super("HANDOFF_NOT_FOUND", message, {
      statusCode: options?.statusCode ?? 404,
      details:
        options?.details ??
        (options?.handoffId !== undefined ? { handoffId: options.handoffId } : undefined),
      cause: options?.cause,
    });
    if (options?.handoffId !== undefined) {
      this.handoffId = options.handoffId;
    }
  }
}

export class UnauthorizedError extends CleanroomError {
  constructor(message: string, options?: CleanroomErrorOptions) {
    super("UNAUTHORIZED", message, options);
  }
}

export function isCleanroomError(err: unknown): err is CleanroomError {
  return err instanceof CleanroomError;
}
