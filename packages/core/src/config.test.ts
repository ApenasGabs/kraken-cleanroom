import { describe, expect, it } from "vitest";
import { assertBrowserConfig, assertLlmConfig, loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";

describe("loadConfig()", () => {
  it("loads safe offline defaults when environment is empty or matches .env.example", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      dataDir: "./data",
      llmProvider: "fake",
      httpPort: 4870,
      maxConcurrentJobs: 1,
      logLevel: "info",
      inboxDomain: "lab.example.com",
    });

    const fromDotEnvExample = loadConfig({
      CLEANROOM_DATA_DIR: "./data",
      CLEANROOM_LLM_PROVIDER: "fake",
      CLEANROOM_LLM_MODEL: "",
      CLEANROOM_LLM_API_KEY: "",
      CLEANROOM_LLM_BASE_URL: "",
      CLEANROOM_HTTP_PORT: "4870",
      CLEANROOM_MAX_CONCURRENT_JOBS: "1",
      CLEANROOM_LOG_LEVEL: "info",
      CLEANROOM_NOTIFY_WEBHOOK_URL: "",
      CLEANROOM_PUBLIC_URL: "",
      CLEANROOM_INBOX_DOMAIN: "lab.example.com",
    });
    expect(fromDotEnvExample.llmProvider).toBe("fake");
    expect(fromDotEnvExample.llmModel).toBeUndefined();
    expect(fromDotEnvExample.llmApiKey).toBeUndefined();
    expect(fromDotEnvExample.browserWsEndpoint).toBeUndefined();
  });

  it("parses complete configuration with all optional fields", () => {
    const config = loadConfig({
      CLEANROOM_DATA_DIR: "/var/lib/cleanroom",
      CLEANROOM_BROWSER_WS_ENDPOINT: "ws://browserless.internal:9222?token=placeholder",
      CLEANROOM_LLM_PROVIDER: "openai-compatible",
      CLEANROOM_LLM_MODEL: "gpt-4o-mini",
      CLEANROOM_LLM_API_KEY: "test-key-placeholder",
      CLEANROOM_LLM_BASE_URL: "https://api.example.com/v1",
      CLEANROOM_HTTP_PORT: "8080",
      CLEANROOM_API_TOKEN: "api-token-placeholder",
      CLEANROOM_MAX_CONCURRENT_JOBS: "3",
      CLEANROOM_LOG_LEVEL: "debug",
      CLEANROOM_NOTIFY_WEBHOOK_URL: "https://hooks.example.com/notify",
      CLEANROOM_PUBLIC_URL: "https://cleanroom.example.com",
      CLEANROOM_INBOX_DOMAIN: "inbox.example.com",
      CLEANROOM_INBOX_HMAC_SECRET: "hmac-placeholder",
      CLEANROOM_CREDENTIALS_KEY: "creds-key-placeholder",
    });

    expect(config).toEqual({
      dataDir: "/var/lib/cleanroom",
      browserWsEndpoint: "ws://browserless.internal:9222?token=placeholder",
      llmProvider: "openai-compatible",
      llmModel: "gpt-4o-mini",
      llmApiKey: "test-key-placeholder",
      llmBaseUrl: "https://api.example.com/v1",
      httpPort: 8080,
      apiToken: "api-token-placeholder",
      maxConcurrentJobs: 3,
      logLevel: "debug",
      notifyWebhookUrl: "https://hooks.example.com/notify",
      publicUrl: "https://cleanroom.example.com",
      inboxDomain: "inbox.example.com",
      inboxHmacSecret: "hmac-placeholder",
      credentialsKey: "creds-key-placeholder",
    });
  });

  it("throws ConfigError with clear message when configuration values are invalid", () => {
    expect(() =>
      loadConfig({
        CLEANROOM_DATA_DIR: "   ",
        CLEANROOM_BROWSER_WS_ENDPOINT: "http://not-a-websocket:9222",
        CLEANROOM_LLM_PROVIDER: "invalid-provider",
        CLEANROOM_HTTP_PORT: "99999",
        CLEANROOM_MAX_CONCURRENT_JOBS: "0",
        CLEANROOM_LOG_LEVEL: "verbose",
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({
        CLEANROOM_DATA_DIR: "   ",
        CLEANROOM_BROWSER_WS_ENDPOINT: "http://not-a-websocket:9222",
        CLEANROOM_LLM_PROVIDER: "invalid-provider",
        CLEANROOM_HTTP_PORT: "99999",
        CLEANROOM_MAX_CONCURRENT_JOBS: "0",
        CLEANROOM_LOG_LEVEL: "verbose",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.code).toBe("CONFIG_INVALID");
      expect(configErr.message).toContain("CLEANROOM_DATA_DIR");
      expect(configErr.message).toContain("CLEANROOM_BROWSER_WS_ENDPOINT");
      expect(configErr.message).toContain("CLEANROOM_LLM_PROVIDER");
      expect(configErr.message).toContain("CLEANROOM_HTTP_PORT");
      expect(configErr.message).toContain("CLEANROOM_MAX_CONCURRENT_JOBS");
      expect(configErr.message).toContain("CLEANROOM_LOG_LEVEL");
      expect(configErr.issues.length).toBe(6);
    }
  });

  it("validates browser and LLM requirements on demand via options or helpers", () => {
    const base = loadConfig({ CLEANROOM_LLM_PROVIDER: "gemini" });
    expect(base.llmProvider).toBe("gemini");

    expect(() => assertBrowserConfig(base)).toThrowError(/CLEANROOM_BROWSER_WS_ENDPOINT/);
    expect(() => loadConfig({}, { requireBrowser: true })).toThrowError(
      /CLEANROOM_BROWSER_WS_ENDPOINT/,
    );

    const withBrowser = loadConfig(
      { CLEANROOM_BROWSER_WS_ENDPOINT: "wss://browserless.example.com?token=test" },
      { requireBrowser: true },
    );
    expect(assertBrowserConfig(withBrowser).browserWsEndpoint).toBe(
      "wss://browserless.example.com?token=test",
    );

    // fake provider does not require model or API key even when requireLlm is true
    const fakeLlm = loadConfig({ CLEANROOM_LLM_PROVIDER: "fake" }, { requireLlm: true });
    expect(assertLlmConfig(fakeLlm).llmProvider).toBe("fake");

    // real provider requires model and API key when asserted
    expect(() => assertLlmConfig(base)).toThrowError(/CLEANROOM_LLM_MODEL.*CLEANROOM_LLM_API_KEY/);
    expect(() =>
      loadConfig({ CLEANROOM_LLM_PROVIDER: "openai" }, { requireLlm: true }),
    ).toThrowError(/CLEANROOM_LLM_MODEL/);
  });
});
