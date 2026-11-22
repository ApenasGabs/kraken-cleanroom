#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CORE_VERSION,
  type CleanroomJobService,
  EVIDENCE_KINDS,
  type EvidenceKind,
  JOB_STATES,
  type JobService,
  type JobState,
  type JobStatus,
  type LlmClient,
  ManifestError,
  type ManifestIssueDetail,
  OWNERSHIP_TYPES,
  type OwnershipType,
  type PhaseId,
  deriveJobName,
  initManifest,
  isCleanroomError,
  isTerminalJobState,
  loadConfig,
  loadManifest,
  validateManifest,
} from "@cleanroom/core";
import type { CdpConnector } from "@cleanroom/explorer";
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
import {
  exitCodeForJobState,
  formatEvidencePage,
  formatJobList,
  formatJobStatus,
  formatRunProgressLine,
  renderProgressBar,
} from "./formatters.js";
import {
  type CliJobServiceHandle,
  createCliJobService,
  createPhase1Pipeline,
  parsePhasesOption,
} from "./pipeline.js";

export {
  collectSensitiveValues,
  createCliJobService,
  createPhase1Pipeline,
  defaultCdpProbe,
  deriveJobName,
  exitCodeForJobState,
  formatDoctorReport,
  formatEvidencePage,
  formatJobList,
  formatJobStatus,
  formatRunProgressLine,
  initManifest,
  parsePhasesOption,
  redactDoctorText,
  renderProgressBar,
  runDoctor,
  sanitizeEndpointForDisplay,
  validateManifest,
  type CdpConnectionProbe,
  type CliJobServiceHandle,
  type DoctorCheckResult,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorReport,
  type LlmConnectivityProbe,
  type LlmProbeContext,
};

export const CLI_NAME = "cleanroom";
export const CLI_VERSION = CORE_VERSION;

export interface CliServiceFactoryContext {
  env: Record<string, string | undefined>;
  cwd: string;
  enabledPhases?: readonly PhaseId[] | undefined;
}

export interface CliServiceHandleLike {
  service: JobService | CleanroomJobService;
  dataDir?: string | undefined;
  close?: (() => void) | undefined;
}

export interface CliIo {
  stdout?: ((chunk: string) => void) | undefined;
  stderr?: ((chunk: string) => void) | undefined;
  stdin?: string | AsyncIterable<Buffer | Uint8Array | string> | undefined;
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
  cdpProbe?: CdpConnectionProbe | undefined;
  llmProbe?: LlmConnectivityProbe | undefined;
  cdpTimeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  cdpConnector?: CdpConnector | undefined;
  llmClient?: LlmClient | undefined;
  timeoutMs?: number | undefined;
  jobServiceFactory?:
    | ((ctx: CliServiceFactoryContext) => Promise<CliServiceHandleLike> | CliServiceHandleLike)
    | undefined;
  spawnDetached?:
    | ((
        args: readonly string[],
        options: { cwd: string; env: Record<string, string | undefined> },
      ) => void | Promise<void>)
    | undefined;
  openFile?: ((filePath: string) => void | Promise<void>) | undefined;
  watchPollMs?: number | undefined;
  runPollMs?: number | undefined;
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
    "  run <manifest>       Execute a cleanroom study from a manifest",
    "  status <jobId>       Show job status, phases, counters and LLM usage",
    "  list                 List registered jobs",
    "  resume <jobId>       Resume a paused or interrupted job",
    "  cancel <jobId>       Cancel a running or paused job",
    "  report <jobId>       Output generated report (md or json)",
    "  evidence <jobId>     List evidence collected for a job",
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const timer = setTimeout(res, ms);
    timer.unref?.();
  });
}

function hasWaitForJob(svc: JobService | CleanroomJobService): svc is CleanroomJobService {
  return typeof (svc as CleanroomJobService).waitForJob === "function";
}

function hasStore(svc: JobService | CleanroomJobService): svc is CleanroomJobService {
  return (svc as CleanroomJobService).store !== undefined;
}

function parsePositiveIntOption(raw: string, optionName: string, max = 10_000): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Opção ${optionName} inválida ("${raw}"): informe um inteiro positivo.`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Opção ${optionName} deve estar entre 1 e ${max}.`);
  }
  return value;
}

function toNodeSpawnEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function defaultSpawnDetached(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): void {
  const entryScript = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entryScript, ...args], {
    cwd: options.cwd,
    env: toNodeSpawnEnv(options.env),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function defaultOpenFile(filePath: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function formatErrorLine(err: unknown): string {
  if (isCleanroomError(err)) {
    return `[${err.code}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function waitWithProgress(
  service: JobService | CleanroomJobService,
  jobId: string,
  options: {
    pollMs: number;
    jsonMode: boolean;
    writeOut: (chunk: string) => void;
  },
): Promise<JobStatus> {
  let lastProgress = "";
  let done = false;

  const emitProgress = (status: JobStatus): void => {
    if (options.jsonMode) {
      return;
    }
    const line = formatRunProgressLine(status);
    if (line !== lastProgress) {
      lastProgress = line;
      options.writeOut(`${line}\n`);
    }
  };

  if (hasWaitForJob(service)) {
    const waiter = service.waitForJob(jobId).finally(() => {
      done = true;
    });

    while (!done) {
      try {
        const snap = await service.status(jobId);
        emitProgress(snap);
      } catch {
        // ignora erros transitórios durante polling
      }
      if (done) {
        break;
      }
      await Promise.race([waiter.then(() => undefined), sleep(options.pollMs)]);
    }

    await waiter;
    const finalStatus = await service.status(jobId);
    emitProgress(finalStatus);
    return finalStatus;
  }

  // Fallback genérico para implementações de JobService sem waitForJob
  for (;;) {
    const status = await service.status(jobId);
    emitProgress(status);
    if (isTerminalJobState(status.state) || status.state === "awaiting_human") {
      return status;
    }
    await sleep(options.pollMs);
  }
}

export function createCliProgram(io?: CliIo): {
  program: Command;
  getExitCode: () => number;
} {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = io?.env ?? process.env;
  const cwd = io?.cwd ?? process.cwd();
  const runPollMs = io?.runPollMs ?? 200;
  const watchPollMs = io?.watchPollMs ?? 500;

  let exitCode = 0;

  const openHandle = async (enabledPhases?: readonly PhaseId[]): Promise<CliServiceHandleLike> => {
    if (io?.jobServiceFactory) {
      return io.jobServiceFactory({ env, cwd, enabledPhases });
    }
    return createCliJobService({
      env,
      cwd,
      enabledPhases,
      fetch: io?.fetch,
      cdpConnector: io?.cdpConnector,
      llmClient: io?.llmClient,
      timeoutMs: io?.timeoutMs,
    });
  };

  const resolveDataDir = (handleDataDir?: string): string => {
    if (handleDataDir) {
      return handleDataDir;
    }
    const cfg = loadConfig(env, { requireBrowser: false, requireLlm: false });
    return resolve(cwd, cfg.dataDir);
  };

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

  program
    .command("run")
    .description("Executa um estudo clean room a partir de um manifesto cleanroom.yaml")
    .argument("<manifest>", "Caminho para o arquivo cleanroom.yaml (ou '-' para stdin)")
    .option(
      "--phases <phases>",
      "Lista separada por vírgula das fases a executar (ex.: intake,explore,capture,analyze,synthesize,report)",
    )
    .option("--detach", "Inicia o job em segundo plano e retorna imediatamente com o jobId")
    .option("--json", "Imprime o resultado final em formato JSON")
    .action(
      async (
        manifestArg: string,
        options: { phases?: string; detach?: boolean; json?: boolean },
      ) => {
        let handle: CliServiceHandleLike | undefined;
        try {
          const enabledPhases =
            options.phases !== undefined ? parsePhasesOption(options.phases) : undefined;
          const trimmedArg = manifestArg.trim();
          const manifestYaml =
            trimmedArg === "-"
              ? await readStdinContent(io?.stdin)
              : await readFile(resolve(cwd, trimmedArg), "utf8");

          handle = await openHandle(enabledPhases);
          const dataDir = resolveDataDir(handle.dataDir);

          if (options.detach) {
            const { jobId } = await handle.service.start(manifestYaml, {
              ...(enabledPhases ? { enabledPhases } : {}),
              detached: !io?.jobServiceFactory,
            });

            if (!io?.jobServiceFactory) {
              handle.close?.();
              handle = undefined;
            }

            if (!io?.jobServiceFactory || io?.spawnDetached) {
              const workerArgs = [
                "_worker",
                jobId,
                ...(enabledPhases ? ["--phases", enabledPhases.join(",")] : []),
              ];
              const spawner = io?.spawnDetached ?? defaultSpawnDetached;
              await spawner(workerArgs, { cwd, env });
            }

            if (options.json) {
              writeOut(`${JSON.stringify({ jobId, state: "running", detached: true }, null, 2)}\n`);
            } else {
              writeOut(`Job iniciado em segundo plano: ${jobId}\n`);
            }
            exitCode = 0;
            return;
          }

          const { jobId } = await handle.service.start(manifestYaml, {
            ...(enabledPhases ? { enabledPhases } : {}),
          });

          if (!options.json) {
            writeOut(`Job iniciado: ${jobId}\n`);
          }

          const finalStatus = await waitWithProgress(handle.service, jobId, {
            pollMs: runPollMs,
            jsonMode: Boolean(options.json),
            writeOut,
          });

          if (options.json) {
            writeOut(`${JSON.stringify(finalStatus, null, 2)}\n`);
          } else {
            writeOut(`\n${formatJobStatus(finalStatus)}\n`);
            if (finalStatus.state === "completed") {
              writeOut(`Relatório: ${join(dataDir, "jobs", jobId, "report", "report.md")}\n`);
            }
          }

          exitCode = exitCodeForJobState(finalStatus.state);
        } catch (err) {
          if (err instanceof ManifestError) {
            if (options.json) {
              writeOut(
                `${JSON.stringify({ ok: false, issues: (err as ManifestError).issues }, null, 2)}\n`,
              );
            } else {
              writeErr(`${formatManifestIssues((err as ManifestError).issues)}\n`);
            }
          } else {
            writeErr(`Erro ao executar job: ${formatErrorLine(err)}\n`);
          }
          exitCode = 1;
        } finally {
          handle?.close?.();
        }
      },
    );

  program
    .command("status")
    .description("Exibe o status atual de um job (fases, contadores, handoffs e tokens LLM)")
    .argument("<jobId>", "Identificador do job (ex.: cr-...)")
    .option("--json", "Imprime o status em formato JSON")
    .option("--watch", "Acompanha atualizações até o job pausar ou concluir")
    .action(async (jobId: string, options: { json?: boolean; watch?: boolean }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        handle = await openHandle();
        if (!options.watch) {
          const status = await handle.service.status(jobId);
          if (options.json) {
            writeOut(`${JSON.stringify(status, null, 2)}\n`);
          } else {
            writeOut(`${formatJobStatus(status)}\n`);
          }
          exitCode = 0;
          return;
        }

        let lastSnapshot = "";
        for (;;) {
          const status = await handle.service.status(jobId);
          const serialized = JSON.stringify(status);
          if (serialized !== lastSnapshot) {
            lastSnapshot = serialized;
            if (options.json) {
              writeOut(`${serialized}\n`);
            } else {
              writeOut(`${formatRunProgressLine(status)}\n`);
            }
          }
          if (isTerminalJobState(status.state) || status.state === "awaiting_human") {
            if (!options.json) {
              writeOut(`\n${formatJobStatus(status)}\n`);
            }
            break;
          }
          await sleep(watchPollMs);
        }
        exitCode = 0;
      } catch (err) {
        writeErr(`Erro ao consultar status: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
    });

  program
    .command("list")
    .description("Lista os jobs registrados no banco local")
    .option("--state <state>", `Filtra por estado (${JOB_STATES.join(" | ")})`)
    .option("--limit <n>", "Quantidade máxima de jobs retornados (default: 50)")
    .option("--json", "Imprime a lista em formato JSON")
    .action(async (options: { state?: string; limit?: string; json?: boolean }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        let state: JobState | undefined;
        if (options.state !== undefined) {
          const trimmedState = options.state.trim();
          if (!JOB_STATES.includes(trimmedState as JobState)) {
            writeErr(
              `Erro: --state inválido ("${trimmedState}"). Valores aceitos: ${JOB_STATES.join(", ")}.\n`,
            );
            exitCode = 1;
            return;
          }
          state = trimmedState as JobState;
        }

        const limit =
          options.limit !== undefined
            ? parsePositiveIntOption(options.limit, "--limit", 500)
            : undefined;

        handle = await openHandle();
        const jobs = await handle.service.list({
          ...(state !== undefined ? { state } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });

        if (options.json) {
          writeOut(`${JSON.stringify(jobs, null, 2)}\n`);
        } else {
          writeOut(`${formatJobList(jobs)}\n`);
        }
        exitCode = 0;
      } catch (err) {
        writeErr(`Erro ao listar jobs: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
    });

  program
    .command("resume")
    .description("Retoma um job interrompido ou com handoff resolvido")
    .argument("<jobId>", "Identificador do job")
    .option("--detach", "Retoma em segundo plano e retorna imediatamente")
    .option("--json", "Imprime o resultado final em formato JSON")
    .action(async (jobId: string, options: { detach?: boolean; json?: boolean }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        handle = await openHandle();
        if (options.detach) {
          if (hasStore(handle.service) && !io?.jobServiceFactory) {
            const job = handle.service.store.getJobOrThrow(jobId);
            if (job.state === "awaiting_human") {
              const pending = handle.service.store.getPendingHandoff(jobId);
              if (pending !== null) {
                throw new Error(
                  `Job ${jobId} aguarda o handoff ${pending.id}; resolva-o antes de retomar.`,
                );
              }
            } else if (job.state !== "running") {
              throw new Error(`Job ${jobId} em "${job.state}" não pode ser retomado.`);
            }
            handle.close?.();
            handle = undefined;
            const spawner = io?.spawnDetached ?? defaultSpawnDetached;
            await spawner(["_worker", jobId], { cwd, env });
          } else {
            await handle.service.resume(jobId);
            if (io?.spawnDetached) {
              await io.spawnDetached(["_worker", jobId], { cwd, env });
            }
          }
          if (options.json) {
            writeOut(`${JSON.stringify({ jobId, state: "running", detached: true }, null, 2)}\n`);
          } else {
            writeOut(`Job retomado em segundo plano: ${jobId}\n`);
          }
          exitCode = 0;
          return;
        }

        await handle.service.resume(jobId);
        const finalStatus = await waitWithProgress(handle.service, jobId, {
          pollMs: runPollMs,
          jsonMode: Boolean(options.json),
          writeOut,
        });

        if (options.json) {
          writeOut(`${JSON.stringify(finalStatus, null, 2)}\n`);
        } else {
          writeOut(`\n${formatJobStatus(finalStatus)}\n`);
        }

        exitCode = exitCodeForJobState(finalStatus.state);
      } catch (err) {
        writeErr(`Erro ao retomar job: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
    });

  program
    .command("cancel")
    .description("Cancela um job em execução ou aguardando intervenção humana")
    .argument("<jobId>", "Identificador do job")
    .option("--reason <reason>", "Motivo do cancelamento")
    .option("--json", "Imprime a confirmação em formato JSON")
    .action(async (jobId: string, options: { reason?: string; json?: boolean }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        handle = await openHandle();
        await handle.service.cancel(jobId, options.reason);
        if (options.json) {
          writeOut(
            `${JSON.stringify(
              {
                ok: true,
                jobId,
                state: "cancelled",
                ...(options.reason !== undefined ? { reason: options.reason } : {}),
              },
              null,
              2,
            )}\n`,
          );
        } else {
          const reasonSuffix = options.reason ? ` (${options.reason})` : "";
          writeOut(`Job ${jobId} cancelado${reasonSuffix}.\n`);
        }
        exitCode = 0;
      } catch (err) {
        writeErr(`Erro ao cancelar job: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
    });

  program
    .command("report")
    .description("Exibe ou abre o relatório gerado para um job")
    .argument("<jobId>", "Identificador do job")
    .option("--format <format>", "Formato do relatório (md | json)", "md")
    .option("--open", "Abre o arquivo do relatório no visualizador padrão do sistema")
    .action(async (jobId: string, options: { format?: string; open?: boolean }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        const rawFormat = (options.format ?? "md").trim().toLowerCase();
        if (rawFormat !== "md" && rawFormat !== "markdown" && rawFormat !== "json") {
          writeErr(`Erro: --format inválido ("${rawFormat}"). Valores aceitos: md, json.\n`);
          exitCode = 1;
          return;
        }
        const serviceFormat: "markdown" | "json" = rawFormat === "json" ? "json" : "markdown";

        handle = await openHandle();
        const content = await handle.service.getReport(jobId, serviceFormat);

        if (options.open) {
          const dataDir = resolveDataDir(handle.dataDir);
          const fileName = serviceFormat === "json" ? "index.json" : "report.md";
          const reportPath = resolve(dataDir, "jobs", jobId, "report", fileName);
          const opener = io?.openFile ?? defaultOpenFile;
          await opener(reportPath);
          writeOut(`Relatório aberto: ${reportPath}\n`);
          exitCode = 0;
          return;
        }

        writeOut(content.endsWith("\n") ? content : `${content}\n`);
        exitCode = 0;
      } catch (err) {
        writeErr(`Erro ao obter relatório: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
    });

  program
    .command("evidence")
    .description("Lista evidências coletadas para um job")
    .argument("<jobId>", "Identificador do job")
    .option("--kind <kind>", `Filtra por tipo de evidência (${EVIDENCE_KINDS.join(" | ")})`)
    .option("--limit <n>", "Quantidade máxima de itens por página (default: 20)", "20")
    .option("--cursor <cursor>", "Cursor de paginação retornado na página anterior")
    .option("--json", "Imprime o resultado paginado em formato JSON")
    .action(
      async (
        jobId: string,
        options: { kind?: string; limit?: string; cursor?: string; json?: boolean },
      ) => {
        let handle: CliServiceHandleLike | undefined;
        try {
          let kind: EvidenceKind | undefined;
          if (options.kind !== undefined) {
            const trimmedKind = options.kind.trim();
            if (!EVIDENCE_KINDS.includes(trimmedKind as EvidenceKind)) {
              writeErr(
                `Erro: --kind inválido ("${trimmedKind}"). Valores aceitos: ${EVIDENCE_KINDS.join(", ")}.\n`,
              );
              exitCode = 1;
              return;
            }
            kind = trimmedKind as EvidenceKind;
          }

          const limit = parsePositiveIntOption(options.limit ?? "20", "--limit", 200);

          handle = await openHandle();
          const page = await handle.service.listEvidence(jobId, {
            ...(kind !== undefined ? { kind } : {}),
            limit,
            ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          });

          if (options.json) {
            writeOut(`${JSON.stringify(page, null, 2)}\n`);
          } else {
            writeOut(`${formatEvidencePage(page)}\n`);
          }
          exitCode = 0;
        } catch (err) {
          writeErr(`Erro ao listar evidências: ${formatErrorLine(err)}\n`);
          exitCode = 1;
        } finally {
          handle?.close?.();
        }
      },
    );

  // Comando interno usado pelo --detach para executar o job em processo destacado.
  program
    .command("_worker", { hidden: true })
    .argument("<jobId>", "Identificador do job")
    .option("--phases <phases>", "Fases habilitadas")
    .action(async (jobId: string, options: { phases?: string }) => {
      let handle: CliServiceHandleLike | undefined;
      try {
        const enabledPhases =
          options.phases !== undefined ? parsePhasesOption(options.phases) : undefined;
        handle = await openHandle(enabledPhases);
        if (hasStore(handle.service)) {
          const finalRecord = await handle.service.runner.run(jobId, {
            ...(enabledPhases ? { enabledPhases } : {}),
          });
          exitCode = exitCodeForJobState(finalRecord.state);
        } else {
          await handle.service.resume(jobId);
          exitCode = 0;
        }
      } catch (err) {
        writeErr(`Erro no worker do job ${jobId}: ${formatErrorLine(err)}\n`);
        exitCode = 1;
      } finally {
        handle?.close?.();
      }
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
