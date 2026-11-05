import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrlTokens } from "./logger.js";

function createMemoryStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim().length > 0) {
          lines.push(line);
        }
      }
      callback();
    },
  });
  return {
    stream,
    lines,
    parsedEntries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger() and secret redaction", () => {
  it("redacts token= query parameters in arbitrary URLs", () => {
    expect(redactUrlTokens("ws://x?token=abc")).toBe("ws://x?token=[REDACTED]");
    expect(redactUrlTokens("ws://host:9222?token=abc&headless=true")).toBe(
      "ws://host:9222?token=[REDACTED]&headless=true",
    );
    expect(redactUrlTokens("wss://host:9222/devtools/browser/1?foo=bar&token=sec_123#frag")).toBe(
      "wss://host:9222/devtools/browser/1?foo=bar&token=[REDACTED]#frag",
    );
    expect(redactUrlTokens("https://api.example.com/oauth?access_token=xyz987")).toBe(
      "https://api.example.com/oauth?access_token=[REDACTED]",
    );
  });

  it("redacts ws://x?token=abc and sensitive fields in pino JSON logs", () => {
    const mem = createMemoryStream();
    const logger = createLogger({ level: "info", destination: mem.stream });

    logger.info(
      {
        endpoint: "ws://x?token=abc",
        auth: {
          password: "my-super-secret-password",
          token: "my-bearer-token",
          authorization: "Bearer secret-jwt",
          cookie: "session_id=secret-cookie",
        },
        headers: {
          cookie: "sid=cookie-val",
          authorization: "Bearer header-jwt",
          "x-request-id": "req-123",
        },
      },
      "Connecting to Browserless at ws://x?token=abc",
    );

    const entries = mem.parsedEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error("Expected log entry");
    }

    expect(entry.endpoint).toBe("ws://x?token=[REDACTED]");
    expect(entry.msg).toBe("Connecting to Browserless at ws://x?token=[REDACTED]");
    expect(entry.auth).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
    });
    expect(entry.headers).toEqual({
      cookie: "[REDACTED]",
      authorization: "[REDACTED]",
      "x-request-id": "req-123",
    });

    const rawJson = mem.lines[0] ?? "";
    expect(rawJson).not.toContain("token=abc");
    expect(rawJson).not.toContain("my-super-secret-password");
    expect(rawJson).not.toContain("my-bearer-token");
    expect(rawJson).not.toContain("secret-jwt");
    expect(rawJson).not.toContain("secret-cookie");
    expect(rawJson).not.toContain("cookie-val");
    expect(rawJson).not.toContain("header-jwt");
  });

  it("redacts secrets and URL tokens in child logger bindings and Error objects", () => {
    const mem = createMemoryStream();
    const rootLogger = createLogger({ level: "debug" }, mem.stream);
    const jobLogger = rootLogger.child({
      jobId: "job_01",
      browserUrl: "ws://browserless:9222?token=child_secret_token",
      credentials: { password: "child-password" },
    });

    const err = new Error("CDP connection failed for ws://browserless:9222?token=err_secret_token");
    jobLogger.error({ err }, "Phase explore failed");

    const entries = mem.parsedEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error("Expected log entry");
    }

    expect(entry.jobId).toBe("job_01");
    expect(entry.browserUrl).toBe("ws://browserless:9222?token=[REDACTED]");
    expect(entry.credentials).toEqual({ password: "[REDACTED]" });

    const serializedErr = entry.err as Record<string, unknown>;
    expect(serializedErr.message).toBe(
      "CDP connection failed for ws://browserless:9222?token=[REDACTED]",
    );
    expect(String(serializedErr.stack)).not.toContain("err_secret_token");
    expect(mem.lines[0]).not.toContain("child_secret_token");
    expect(mem.lines[0]).not.toContain("child-password");
    expect(mem.lines[0]).not.toContain("err_secret_token");
  });
});
