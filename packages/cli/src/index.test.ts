import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliIo,
  deriveJobName,
  runCli,
  runDoctor,
  sanitizeEndpointForDisplay,
} from "./index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EXAMPLE_MANIFEST_PATH = resolve(__dirname, "../../../examples/cleanroom.example.yaml");

function createCapturedIo(overrides?: Partial<CliIo>): {
  io: CliIo;
  getStdout: () => string;
  getStderr: () => string;
} {
  let stdoutBuf = "";
  let stderrBuf = "";

  const io: CliIo = {
    stdout: (chunk: string) => {
      stdoutBuf += chunk;
    },
    stderr: (chunk: string) => {
      stderrBuf += chunk;
    },
    ...overrides,
  };

  return {
    io,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

describe("@cleanroom/cli — init, validate, doctor (F0-05)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cleanroom-cli-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("cleanroom init & deriveJobName", () => {
    it("1. deriveJobName gera slugs válidos [a-z0-9-] entre 3 e 40 caracteres", () => {
      expect(deriveJobName("https://demo.playwright.dev/todomvc")).toBe(
        "demo-playwright-dev-todomvc",
      );
      expect(deriveJobName("https://www.Example.COM/App/Dashboard/index.html")).toBe(
        "example-com-app-dashboard-index",
      );

      const longUrl =
        "https://very-long-subdomain.enterprise-application.example.com/modules/financial-reporting/v2/overview";
      const longSlug = deriveJobName(longUrl);
      expect(longSlug.length).toBeGreaterThanOrEqual(3);
      expect(longSlug.length).toBeLessThanOrEqual(40);
      expect(longSlug).toMatch(/^[a-z0-9-]+$/);
      expect(longSlug.endsWith("-")).toBe(false);

      const shortSlug = deriveJobName("http://localhost:3000");
      expect(shortSlug).toBe("localhost");
      expect(shortSlug.length).toBeGreaterThanOrEqual(3);
    });

    it("2. cleanroom init https://demo.playwright.dev/todomvc | cleanroom validate - passa com código 0", async () => {
      const initCapture = createCapturedIo();
      const initCode = await runCli(
        ["init", "https://demo.playwright.dev/todomvc"],
        initCapture.io,
      );

      expect(initCode).toBe(0);
      expect(initCapture.getStderr()).toBe("");
      const generatedYaml = initCapture.getStdout();
      expect(generatedYaml).toContain("# Manifesto kraken-cleanroom");
      expect(generatedYaml).toContain("name: demo-playwright-dev-todomvc");
      expect(generatedYaml).toContain('  - "https://demo.playwright.dev"');
      expect(generatedYaml).toContain("ownership: third-party");
      expect(generatedYaml).toContain("tosReviewed: true");

      const validateCapture = createCapturedIo({
        stdin: Readable.from([Buffer.from(generatedYaml, "utf8")]),
      });
      const validateCode = await runCli(["validate", "-"], validateCapture.io);

      expect(validateCode).toBe(0);
      expect(validateCapture.getStderr()).toBe("");
      expect(validateCapture.getStdout()).toContain(
        "Manifesto válido: demo-playwright-dev-todomvc",
      );
    });

    it("3. cleanroom init suporta -o <arquivo> e --ownership own|third-party|client-authorized", async () => {
      const outPath = join(tempDir, "nested", "cleanroom.yaml");
      const captureOwn = createCapturedIo({ cwd: tempDir });
      const codeOwn = await runCli(
        ["init", "http://localhost:4321/projects", "-o", outPath, "--ownership", "own"],
        captureOwn.io,
      );

      expect(codeOwn).toBe(0);
      const writtenContent = await readFile(outPath, "utf8");
      expect(writtenContent).toContain("ownership: own");
      expect(writtenContent).toContain('  - "http://localhost:4321"');

      const validateFile = createCapturedIo({ cwd: tempDir });
      expect(await runCli(["validate", outPath], validateFile.io)).toBe(0);

      // Testa --ownership client-authorized e -o -
      const captureClient = createCapturedIo();
      const codeClient = await runCli(
        [
          "init",
          "https://portal.cliente.example.com",
          "-o",
          "-",
          "--ownership",
          "client-authorized",
        ],
        captureClient.io,
      );
      expect(codeClient).toBe(0);
      expect(captureClient.getStdout()).toContain("ownership: client-authorized");

      const validateClient = createCapturedIo({ stdin: captureClient.getStdout() });
      expect(await runCli(["validate", "-"], validateClient.io)).toBe(0);
    });

    it("4. cleanroom init falha com código != 0 para URL inválida ou --ownership inválido", async () => {
      const badUrlCapture = createCapturedIo();
      const badUrlCode = await runCli(["init", "not-a-valid-url"], badUrlCapture.io);
      expect(badUrlCode).toBe(1);
      expect(badUrlCapture.getStderr()).toContain("target.url");

      const badOwnershipCapture = createCapturedIo();
      const badOwnershipCode = await runCli(
        ["init", "https://demo.playwright.dev/todomvc", "--ownership", "pirate"],
        badOwnershipCapture.io,
      );
      expect(badOwnershipCode).toBe(1);
      expect(badOwnershipCapture.getStderr()).toContain("--ownership inválido");
    });
  });

  describe("cleanroom validate", () => {
    it("5. valida arquivo válido (examples/cleanroom.example.yaml) e suporta --json", async () => {
      const capture = createCapturedIo();
      const code = await runCli(["validate", EXAMPLE_MANIFEST_PATH], capture.io);
      expect(code).toBe(0);
      expect(capture.getStdout()).toContain("Manifesto válido: todomvc-demo");

      const jsonCapture = createCapturedIo();
      const jsonCode = await runCli(["validate", EXAMPLE_MANIFEST_PATH, "--json"], jsonCapture.io);
      expect(jsonCode).toBe(0);
      const parsed = JSON.parse(jsonCapture.getStdout()) as {
        ok: boolean;
        manifest: { job: { name: string } };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.manifest.job.name).toBe("todomvc-demo");
    });

    it("6. retorna código != 0 e imprime issues formatadas para arquivo inválido e stdin '-' inválido", async () => {
      const invalidFilePath = join(tempDir, "invalid.yaml");
      const invalidYaml = [
        "version: 1",
        "job:",
        "  name: INVALID_SLUG!",
        "target:",
        "  url: https://demo.playwright.dev/todomvc",
        "ownership: third-party",
        "authorization:",
        "  basis: curta",
        "  tosReviewed: false",
      ].join("\n");
      await writeFile(invalidFilePath, invalidYaml, "utf8");

      const fileCapture = createCapturedIo();
      const fileCode = await runCli(["validate", invalidFilePath], fileCapture.io);
      expect(fileCode).toBe(1);
      expect(fileCapture.getStderr()).toContain("Manifesto inválido");
      expect(fileCapture.getStderr()).toContain("job.name");
      expect(fileCapture.getStderr()).toContain("authorization.basis");
      expect(fileCapture.getStderr()).toContain("authorization.tosReviewed");

      const stdinCapture = createCapturedIo({ stdin: invalidYaml });
      const stdinCode = await runCli(["validate", "-"], stdinCapture.io);
      expect(stdinCode).toBe(1);
      expect(stdinCapture.getStderr()).toContain("authorization.tosReviewed");

      const jsonInvalidCapture = createCapturedIo({ stdin: invalidYaml });
      const jsonInvalidCode = await runCli(["validate", "-", "--json"], jsonInvalidCapture.io);
      expect(jsonInvalidCode).toBe(1);
      const parsedErr = JSON.parse(jsonInvalidCapture.getStdout()) as {
        ok: boolean;
        issues: Array<{ path: string; message: string }>;
      };
      expect(parsedErr.ok).toBe(false);
      expect(parsedErr.issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("cleanroom doctor", () => {
    it("7. com variáveis de ambiente ausentes mostra claramente o que falta sem vazar segredos", async () => {
      const capture = createCapturedIo({
        cwd: tempDir,
        env: {
          CLEANROOM_DATA_DIR: join(tempDir, "data"),
          CLEANROOM_API_TOKEN: "api-token-placeholder",
          CLEANROOM_CREDENTIALS_KEY: "creds-key-placeholder",
        },
      });

      const code = await runCli(["doctor"], capture.io);
      expect(code).toBe(1);

      const out = capture.getStdout();
      expect(out).toContain("CLEANROOM_BROWSER_WS_ENDPOINT");
      expect(out).toContain("CLEANROOM_LLM_PROVIDER");
      expect(out).toContain("CLEANROOM_LLM_MODEL");
      expect(out).toContain("CLEANROOM_LLM_API_KEY");
      expect(out).toContain("Variáveis de ambiente ausentes:");
      expect(out).not.toContain("api-token-placeholder");
      expect(out).not.toContain("creds-key-placeholder");
    });

    it("8. reporta variáveis específicas faltantes quando provedor LLM real está incompleto", async () => {
      const capture = createCapturedIo({
        cwd: tempDir,
        env: {
          CLEANROOM_DATA_DIR: join(tempDir, "data"),
          CLEANROOM_BROWSER_WS_ENDPOINT: "ws://browserless.local:9222?token=example_token",
          CLEANROOM_LLM_PROVIDER: "openai",
          CLEANROOM_LLM_API_KEY: "test-key-placeholder",
        },
        cdpProbe: {
          async connectAndOpenBlank() {
            return { browserVersion: "Chromium/130.0" };
          },
        },
      });

      const code = await runCli(["doctor"], capture.io);
      expect(code).toBe(1);

      const out = capture.getStdout();
      expect(out).toContain("CLEANROOM_LLM_MODEL");
      expect(out).not.toContain("example_token");
      expect(out).not.toContain("test-key-placeholder");
      expect(out).toContain("token=[REDACTED]");
    });

    it("9. passa com código 0 quando dataDir é gravável, CDP abre about:blank e LLM está configurado, jamais expondo tokens", async () => {
      let probedEndpoint = "";
      let probedTimeout = 0;

      const capture = createCapturedIo({
        cwd: tempDir,
        env: {
          CLEANROOM_DATA_DIR: join(tempDir, "data"),
          CLEANROOM_BROWSER_WS_ENDPOINT: "ws://browserless.internal:9222?token=fake_token",
          CLEANROOM_LLM_PROVIDER: "gemini",
          CLEANROOM_LLM_MODEL: "gemini-2.5-pro",
          CLEANROOM_LLM_API_KEY: "test-key-placeholder",
        },
        cdpProbe: {
          async connectAndOpenBlank(wsEndpoint, timeoutMs) {
            probedEndpoint = wsEndpoint;
            probedTimeout = timeoutMs;
            return { browserVersion: "HeadlessChrome/131.0" };
          },
        },
      });

      const code = await runCli(["doctor"], capture.io);
      expect(code).toBe(0);
      expect(probedEndpoint).toBe("ws://browserless.internal:9222?token=fake_token");
      expect(probedTimeout).toBe(10_000);

      const out = capture.getStdout();
      expect(out).toContain("[OK] Diretório de dados (CLEANROOM_DATA_DIR)");
      expect(out).toContain("[OK] Browserless / Chrome CDP (CLEANROOM_BROWSER_WS_ENDPOINT)");
      expect(out).toContain("[OK] Provedor LLM (CLEANROOM_LLM_PROVIDER / MODEL / API_KEY)");
      expect(out).toContain("about:blank");
      expect(out).toContain("token=[REDACTED]");
      expect(out).not.toContain("fake_token");
      expect(out).not.toContain("test-key-placeholder");
    });

    it("10. redige segredos mesmo se exceção de conexão CDP ou LLM ecoar o token ou API key na mensagem de erro", async () => {
      const env = {
        CLEANROOM_DATA_DIR: join(tempDir, "data"),
        CLEANROOM_BROWSER_WS_ENDPOINT:
          "ws://user:test-pass@browserless.internal:9222?token=fake_token",
        CLEANROOM_LLM_PROVIDER: "openai" as const,
        CLEANROOM_LLM_MODEL: "gpt-4.1",
        CLEANROOM_LLM_API_KEY: "test-key-placeholder",
      };

      const report = await runDoctor({
        cwd: tempDir,
        env,
        cdpProbe: {
          async connectAndOpenBlank(wsEndpoint) {
            throw new Error(`WebSocket connection to '${wsEndpoint}' failed: 401 Unauthorized`);
          },
        },
        llmProbe: async ({ apiKey }) => {
          throw new Error(`Invalid API key provided: ${apiKey}`);
        },
      });

      expect(report.ok).toBe(false);
      const jsonCapture = createCapturedIo({
        cwd: tempDir,
        env,
        cdpProbe: {
          async connectAndOpenBlank(wsEndpoint) {
            throw new Error(`WebSocket connection to '${wsEndpoint}' failed`);
          },
        },
        llmProbe: async ({ apiKey }) => {
          throw new Error(`Invalid API key: ${apiKey}`);
        },
      });

      const exitCode = await runCli(["doctor", "--json"], jsonCapture.io);
      expect(exitCode).toBe(1);

      const jsonText = jsonCapture.getStdout();
      expect(jsonText).not.toContain("test-pass");
      expect(jsonText).not.toContain("fake_token");
      expect(jsonText).not.toContain("test-key-placeholder");
      expect(jsonText).toContain("[REDACTED]");
      expect(sanitizeEndpointForDisplay(env.CLEANROOM_BROWSER_WS_ENDPOINT)).not.toContain(
        "fake_token",
      );
    });

    it("11. detecta diretório CLEANROOM_DATA_DIR não gravável", async () => {
      const regularFileAsParent = join(tempDir, "arquivo-comum");
      await writeFile(regularFileAsParent, "conteudo", "utf8");

      const report = await runDoctor({
        cwd: tempDir,
        env: {
          CLEANROOM_DATA_DIR: join(regularFileAsParent, "subpasta"),
          CLEANROOM_BROWSER_WS_ENDPOINT: "ws://localhost:9222?token=placeholder",
          CLEANROOM_LLM_PROVIDER: "fake",
        },
        cdpProbe: {
          async connectAndOpenBlank() {
            return {};
          },
        },
      });

      expect(report.ok).toBe(false);
      const dataCheck = report.checks.find((c) => c.id === "dataDir");
      expect(dataCheck?.status).toBe("fail");
      expect(dataCheck?.message).toContain("Não foi possível gravar em CLEANROOM_DATA_DIR");
    });
  });

  describe("help e version", () => {
    it("12. exibe help quando chamado sem argumentos ou com --help e versão com --version", async () => {
      const emptyCapture = createCapturedIo();
      expect(await runCli([], emptyCapture.io)).toBe(0);
      expect(emptyCapture.getStdout()).toContain("Usage: cleanroom <command> [options]");

      const helpCapture = createCapturedIo();
      expect(await runCli(["--help"], helpCapture.io)).toBe(0);
      expect(helpCapture.getStdout()).toContain("init");
      expect(helpCapture.getStdout()).toContain("validate");
      expect(helpCapture.getStdout()).toContain("doctor");

      const versionCapture = createCapturedIo();
      expect(await runCli(["--version"], versionCapture.io)).toBe(0);
      expect(versionCapture.getStdout().trim()).toBe("0.1.0");
    });
  });
});
