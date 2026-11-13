#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CORE_VERSION,
  ManifestError,
  type ManifestIssueDetail,
  OWNERSHIP_TYPES,
  type OwnershipType,
  deriveJobName,
  initManifest,
  loadManifest,
  validateManifest,
} from "@cleanroom/core";
import { MCP_SERVER_NAME } from "@cleanroom/mcp-server";
import { Command, CommanderError } from "commander";
import {
  type CdpConnectionProbe,
  type DoctorCheckResult,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorReport,
  type LlmConnectivityProbe,
  type LlmProbeContext,
  collectSensitiveValues,
  defaultCdpProbe,
  formatDoctorReport,
  redactDoctorText,
  runDoctor,
  sanitizeEndpointForDisplay,
} from "./doctor.js";

export {
  collectSensitiveValues,
  defaultCdpProbe,
  deriveJobName,
  formatDoctorReport,
  initManifest,
  redactDoctorText,
  runDoctor,
  sanitizeEndpointForDisplay,
  validateManifest,
  type CdpConnectionProbe,
  type DoctorCheckResult,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorReport,
  type LlmConnectivityProbe,
  type LlmProbeContext,
};

export const CLI_NAME = "cleanroom";
export const CLI_VERSION = CORE_VERSION;

export interface CliIo {
  stdout?: ((chunk: string) => void) | undefined;
  stderr?: ((chunk: string) => void) | undefined;
  stdin?: string | AsyncIterable<Buffer | Uint8Array | string> | undefined;
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
  cdpProbe?: CdpConnectionProbe | undefined;
  llmProbe?: LlmConnectivityProbe | undefined;
  cdpTimeoutMs?: number | undefined;
}

export function formatHelpText(): string {
  return [
    `${CLI_NAME} v${CLI_VERSION} (${MCP_SERVER_NAME})`,
    "",
    "Usage: cleanroom <command> [options]",
    "",
    "Commands:",
    "  init <url>           Generate a cleanroom.yaml manifest with safe defaults",
    "  validate <manifest>  Validate a cleanroom.yaml manifest (path or '-' for stdin)",
    "  doctor               Check environment, data dir, Browserless CDP and LLM config",
    "",
    "Options:",
    "  -h, --help           Display this help message",
    "  -v, --version        Display CLI version",
  ].join("\n");
}

async function readStdinContent(
  stdinSource?: string | AsyncIterable<Buffer | Uint8Array | string>,
): Promise<string> {
  if (typeof stdinSource === "string") {
    return stdinSource;
  }
  const iterable = stdinSource ?? process.stdin;
  const chunks: string[] = [];
  for await (const chunk of iterable) {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    }
  }
  return chunks.join("");
}

function formatManifestIssues(issues: readonly ManifestIssueDetail[]): string {
  const header = `Manifesto inválido (${issues.length} ${issues.length === 1 ? "problema encontrado" : "problemas encontrados"}):`;
  const items = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [header, ...items].join("\n");
}

export function createCliProgram(io?: CliIo): {
  program: Command;
  getExitCode: () => number;
} {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = io?.env ?? process.env;
  const cwd = io?.cwd ?? process.cwd();

  let exitCode = 0;

  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      `${CLI_NAME} v${CLI_VERSION} (${MCP_SERVER_NAME}) — Analisador comportamental clean room`,
    )
    .version(CLI_VERSION, "-v, --version", "Exibe a versão da CLI")
    .helpOption("-h, --help", "Exibe esta mensagem de ajuda")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str),
    });

  program
    .command("init")
    .description("Gera um manifesto cleanroom.yaml com defaults seguros e comentários explicativos")
    .argument("<url>", "URL de entrada da aplicação alvo (https://... ou http://localhost:...)")
    .option(
      "-o, --output <path>",
      "Caminho do arquivo YAML de saída (ou '-' para imprimir no stdout)",
    )
    .option("--ownership <ownership>", `Relação com o alvo (${OWNERSHIP_TYPES.join(" | ")})`)
    .action(async (url: string, options: { output?: string; ownership?: string }) => {
      try {
        let ownership: OwnershipType | undefined;
        if (options.ownership !== undefined) {
          const trimmedOwnership = options.ownership.trim();
          if (!OWNERSHIP_TYPES.includes(trimmedOwnership as OwnershipType)) {
            writeErr(
              `Erro: --ownership inválido ("${trimmedOwnership}"). Valores aceitos: ${OWNERSHIP_TYPES.join(", ")}.\n`,
            );
            exitCode = 1;
            return;
          }
          ownership = trimmedOwnership as OwnershipType;
        }

        const yaml = await initManifest(url, ownership ? { ownership } : undefined);
        const outTarget = options.output?.trim();

        if (!outTarget || outTarget === "-") {
          writeOut(yaml);
          exitCode = 0;
          return;
        }

        const resolvedOutPath = resolve(cwd, outTarget);
        await mkdir(dirname(resolvedOutPath), { recursive: true });
        await writeFile(resolvedOutPath, yaml, "utf8");
        writeOut(`Manifesto gerado com sucesso em ${resolvedOutPath}\n`);
        exitCode = 0;
      } catch (err) {
        if (err instanceof ManifestError) {
          writeErr(`${formatManifestIssues((err as ManifestError).issues)}\n`);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          writeErr(`Erro ao gerar manifesto: ${message}\n`);
        }
        exitCode = 1;
      }
    });

  program
    .command("validate")
    .description("Valida um manifesto cleanroom.yaml (caminho de arquivo ou '-' para stdin)")
    .argument("<manifest>", "Caminho para o arquivo cleanroom.yaml ou '-' para ler do stdin")
    .option("--json", "Imprime o resultado em formato JSON")
    .action(async (manifestArg: string, options: { json?: boolean }) => {
      try {
        const trimmedArg = manifestArg.trim();
        let inputForLoadManifest: string;

        if (trimmedArg === "-") {
          const stdinYaml = await readStdinContent(io?.stdin);
          inputForLoadManifest = stdinYaml.includes("\n") ? stdinYaml : `${stdinYaml}\n`;
        } else {
          inputForLoadManifest = resolve(cwd, trimmedArg);
        }

        const manifest = await loadManifest(inputForLoadManifest);
        if (options.json) {
          writeOut(`${JSON.stringify({ ok: true, manifest }, null, 2)}\n`);
        } else {
          const targetDesc = manifest.target.url ?? manifest.target.repo ?? manifest.target.type;
          writeOut(`Manifesto válido: ${manifest.job.name} (${targetDesc})\n`);
        }
        exitCode = 0;
      } catch (err) {
        const issues: ManifestIssueDetail[] =
          err instanceof ManifestError
            ? [...(err as ManifestError).issues]
            : [
                {
                  path: "manifest",
                  message: err instanceof Error ? err.message : String(err),
                },
              ];

        if (options.json) {
          writeOut(`${JSON.stringify({ ok: false, issues }, null, 2)}\n`);
        } else {
          writeErr(`${formatManifestIssues(issues)}\n`);
        }
        exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description(
      "Verifica diretório de dados, conectividade CDP com Browserless e configuração de LLM sem expor segredos",
    )
    .option("--json", "Imprime o diagnóstico em formato JSON")
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor({
        env,
        cwd,
        cdpProbe: io?.cdpProbe,
        llmProbe: io?.llmProbe,
        cdpTimeoutMs: io?.cdpTimeoutMs,
      });

      if (options.json) {
        writeOut(`${redactDoctorText(JSON.stringify(report, null, 2), env)}\n`);
      } else {
        writeOut(`${formatDoctorReport(report, env)}\n`);
      }

      exitCode = report.ok ? 0 : 1;
    });

  return {
    program,
    getExitCode: () => exitCode,
  };
}

export async function runCli(argv: readonly string[], io?: CliIo): Promise<number> {
  if (argv.length === 0) {
    const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
    writeOut(`${formatHelpText()}\n`);
    return 0;
  }

  const { program, getExitCode } = createCliProgram(io);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return getExitCode();
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.help" ||
        err.code === "commander.version"
      ) {
        return 0;
      }
      return err.exitCode || 1;
    }
    const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Erro inesperado na CLI: ${message}\n`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Erro fatal: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
