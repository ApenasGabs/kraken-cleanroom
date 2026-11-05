import { describe, expect, it } from "vitest";
import {
  BrowserUnavailableError,
  CLEANROOM_ERROR_CODES,
  CleanroomError,
  ConfigError,
  DestructiveActionError,
  EvidenceNotFoundError,
  HandoffNotFoundError,
  JobBlockedError,
  JobConflictError,
  JobNotFoundError,
  LlmInvalidOutputError,
  LlmUnavailableError,
  ManifestError,
  MethodNotAllowedError,
  OutOfScopeError,
  UnauthorizedError,
  isCleanroomError,
} from "./errors.js";

describe("CleanroomError hierarchy", () => {
  it("constructs base CleanroomError with code, statusCode, details, and cause", () => {
    const rootCause = new Error("socket hang up");
    const err = new CleanroomError("BROWSER_UNAVAILABLE", "Cannot reach Browserless CDP", {
      details: { endpointHost: "browserless.local" },
      cause: rootCause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CleanroomError);
    expect(isCleanroomError(err)).toBe(true);
    expect(isCleanroomError(rootCause)).toBe(false);
    expect(isCleanroomError("not an error")).toBe(false);

    expect(err.name).toBe("CleanroomError");
    expect(err.code).toBe("BROWSER_UNAVAILABLE");
    expect(err.message).toBe("Cannot reach Browserless CDP");
    expect(err.statusCode).toBe(503);
    expect(err.details).toEqual({ endpointHost: "browserless.local" });
    expect(err.cause).toBe(rootCause);
  });

  it("serializes CleanroomError to JSON and REST error envelope", () => {
    const inner = new ManifestError("Invalid manifest YAML", {
      issues: [{ path: "authorization.tosReviewed", message: "Must be true for third-party" }],
    });
    const outer = new JobConflictError("Cannot start job with invalid manifest", {
      cause: inner,
      details: { jobId: "job_01" },
    });

    const json = outer.toJSON();
    expect(json).toEqual({
      name: "JobConflictError",
      code: "JOB_CONFLICT",
      message: "Cannot start job with invalid manifest",
      statusCode: 409,
      details: { jobId: "job_01" },
      cause: {
        name: "ManifestError",
        code: "MANIFEST_INVALID",
        message: "Invalid manifest YAML",
        statusCode: 422,
        details: {
          issues: [{ path: "authorization.tosReviewed", message: "Must be true for third-party" }],
        },
      },
    });

    const roundTrip = JSON.parse(JSON.stringify(outer));
    expect(roundTrip).toEqual(json);

    expect(inner.toErrorEnvelope()).toEqual({
      error: {
        code: "MANIFEST_INVALID",
        message: "Invalid manifest YAML",
        details: {
          issues: [{ path: "authorization.tosReviewed", message: "Must be true for third-party" }],
        },
      },
    });
  });

  it("serializes native Error and primitive causes cleanly", () => {
    const withNativeCause = new LlmInvalidOutputError("Schema mismatch", {
      cause: new SyntaxError("Unexpected token in JSON"),
    });
    expect(withNativeCause.toJSON().cause).toEqual({
      name: "SyntaxError",
      message: "Unexpected token in JSON",
    });

    const withStringCause = new LlmUnavailableError("Provider timeout", {
      cause: "ETIMEDOUT",
    });
    expect(withStringCause.toJSON().cause).toBe("ETIMEDOUT");
    expect(withStringCause.toErrorEnvelope()).toEqual({
      error: {
        code: "LLM_UNAVAILABLE",
        message: "Provider timeout",
      },
    });
  });

  it("provides domain subclasses with stable error codes and status codes", () => {
    const configErr = new ConfigError("Bad config", {
      issues: [{ envVar: "CLEANROOM_HTTP_PORT", message: "Invalid port" }],
    });
    expect(configErr).toBeInstanceOf(CleanroomError);
    expect(configErr.name).toBe("ConfigError");
    expect(configErr.code).toBe("CONFIG_INVALID");
    expect(configErr.statusCode).toBe(500);
    expect(configErr.issues).toHaveLength(1);

    const manifestErr = new ManifestError("Invalid manifest");
    expect(manifestErr.code).toBe("MANIFEST_INVALID");
    expect(manifestErr.statusCode).toBe(422);

    const methodErr = new MethodNotAllowedError("Method binaryAnalysis disabled", {
      method: "binaryAnalysis",
    });
    expect(methodErr.code).toBe("METHOD_NOT_ALLOWED");
    expect(methodErr.statusCode).toBe(403);
    expect(methodErr.method).toBe("binaryAnalysis");

    const scopeErr = new OutOfScopeError("Origin not allowed", {
      url: "https://external.example.com",
    });
    expect(scopeErr.code).toBe("OUT_OF_SCOPE");
    expect(scopeErr.statusCode).toBe(403);
    expect(scopeErr.url).toBe("https://external.example.com");

    const destructiveErr = new DestructiveActionError("Destructive action blocked", {
      actionLabel: "Delete account",
    });
    expect(destructiveErr.code).toBe("DESTRUCTIVE_ACTION_FORBIDDEN");
    expect(destructiveErr.statusCode).toBe(403);
    expect(destructiveErr.actionLabel).toBe("Delete account");

    const browserErr = new BrowserUnavailableError("CDP disconnected");
    expect(browserErr.code).toBe("BROWSER_UNAVAILABLE");
    expect(browserErr.statusCode).toBe(503);

    const llmOutputErr = new LlmInvalidOutputError("Invalid JSON");
    expect(llmOutputErr.code).toBe("LLM_INVALID_OUTPUT");
    expect(llmOutputErr.statusCode).toBe(502);

    const jobNotFoundErr = new JobNotFoundError("Job not found", { jobId: "job_404" });
    expect(jobNotFoundErr.code).toBe("JOB_NOT_FOUND");
    expect(jobNotFoundErr.statusCode).toBe(404);
    expect(jobNotFoundErr.jobId).toBe("job_404");

    const jobBlockedErr = new JobBlockedError("Target returned 403", { reason: "HTTP_403" });
    expect(jobBlockedErr.code).toBe("JOB_BLOCKED");
    expect(jobBlockedErr.statusCode).toBe(422);
    expect(jobBlockedErr.reason).toBe("HTTP_403");

    const evidenceNotFoundErr = new EvidenceNotFoundError("Missing evidence", {
      evidenceId: "ev_01",
    });
    expect(evidenceNotFoundErr.code).toBe("EVIDENCE_NOT_FOUND");
    expect(evidenceNotFoundErr.statusCode).toBe(404);
    expect(evidenceNotFoundErr.evidenceId).toBe("ev_01");

    const handoffNotFoundErr = new HandoffNotFoundError("Missing handoff", {
      handoffId: "ho_01",
    });
    expect(handoffNotFoundErr.code).toBe("HANDOFF_NOT_FOUND");
    expect(handoffNotFoundErr.statusCode).toBe(404);
    expect(handoffNotFoundErr.handoffId).toBe("ho_01");

    const unauthorizedErr = new UnauthorizedError("Missing bearer token");
    expect(unauthorizedErr.code).toBe("UNAUTHORIZED");
    expect(unauthorizedErr.statusCode).toBe(401);

    expect(CLEANROOM_ERROR_CODES).toContain("MANIFEST_INVALID");
    expect(CLEANROOM_ERROR_CODES).toContain("METHOD_NOT_ALLOWED");
    expect(CLEANROOM_ERROR_CODES).toContain("OUT_OF_SCOPE");
    expect(CLEANROOM_ERROR_CODES).toContain("BROWSER_UNAVAILABLE");
    expect(CLEANROOM_ERROR_CODES).toContain("LLM_INVALID_OUTPUT");
    expect(CLEANROOM_ERROR_CODES).toContain("JOB_NOT_FOUND");
  });
});
