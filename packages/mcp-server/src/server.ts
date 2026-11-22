import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  CONFIDENCE_LEVELS,
  type CleanroomJobService,
  EVIDENCE_KINDS,
  type Evidence,
  JOB_STATES,
  type JobService,
  type JobState,
  type Logger,
  OWNERSHIP_TYPES,
  isCleanroomError,
} from "@cleanroom/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type McpJobServiceHandle,
  type McpRuntimeOptions,
  createMcpJobService,
  createStderrLogger,
} from "./runtime.js";

const JOB_STATE_VALUES = [
  "created",
  "validating_manifest",
  "rejected",
  "running",
  "awaiting_human",
  "blocked",
  "failed",
  "completed",
  "cancelled",
] as const satisfies readonly JobState[];

export const MAX_REPORT_MARKDOWN_BYTES = 200 * 1024; // 200 KB (docs/07 §2)
export const MAX_SCREENSHOT_IMAGE_BYTES = 1024 * 1024; // 1 MB (docs/07 §2)

export const MCP_TOOL_NAMES = [
  "cleanroom_init_manifest",
  "cleanroom_validate_manifest",
  "cleanroom_start_job",
  "cleanroom_status",
  "cleanroom_list_jobs",
  "cleanroom_cancel_job",
  "cleanroom_resume_job",
  "cleanroom_get_report",
  "cleanroom_list_rules",
  "cleanroom_list_evidence",
  "cleanroom_get_evidence",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface TruncatedReportResult {
  content: string;
  truncated: boolean;
  originalBytes: number;
  maxBytes: number;
}

export type EvidenceBlobReader = (
  jobId: string,
  evidence: Evidence,
) => Promise<Buffer | null> | Buffer | null;

export interface CreateCleanroomMcpServerOptions {
  service: JobService | CleanroomJobService;
  logger?: Logger | undefined;
  dataDir?: string | undefined;
  readEvidenceBlob?: EvidenceBlobReader | undefined;
}

export interface CleanroomMcpServerHandle {
  server: McpServer;
  service: JobService | CleanroomJobService;
  logger: Logger;
  close: () => Promise<void>;
}

export interface StartMcpStdioServerOptions extends McpRuntimeOptions {
  service?: (JobService | CleanroomJobService) | undefined;
  dataDir?: string | undefined;
  readEvidenceBlob?: EvidenceBlobReader | undefined;
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
}

export interface StartedMcpStdioServer {
  server: McpServer;
  transport: StdioServerTransport;
  runtime: McpJobServiceHandle | undefined;
  closed: Promise<void>;
  close: () => Promise<void>;
}

function jsonTextResult(payload: unknown): CallToolResult {
  const content: TextContent[] = [
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ];
  return { content };
}

function formatErrorPayload(err: unknown): Record<string, unknown> {
  if (isCleanroomError(err)) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

async function runTool(
  logger: Logger,
  toolName: McpToolName,
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (err) {
    logger.warn({ tool: toolName, err }, "Falha ao executar ferramenta MCP");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(formatErrorPayload(err), null, 2),
        },
      ],
    };
  }
}

function sliceUtf8ToMaxBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  // Recua bytes de continuação UTF-8 (10xxxxxx) para não cortar um code point ao meio.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  // Se o byte anterior iniciar um caractere multi-byte incompleto, também garante corte limpo.
  const sliced = buf.subarray(0, end).toString("utf8");
  return sliced.endsWith("\uFFFD") ? sliced.slice(0, -1) : sliced;
}

/**
 * Trunca relatórios Markdown acima de `maxBytes` (default 200 KB) adicionando aviso
 * e indicando o endpoint REST equivalente (docs/07 §2).
 */
export function truncateReportMarkdown(
  content: string,
  jobId: string,
  maxBytes = MAX_REPORT_MARKDOWN_BYTES,
): TruncatedReportResult {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      originalBytes,
      maxBytes,
    };
  }

  const notice =
    `\n\n> [AVISO] Relatório Markdown truncado em ${Math.round(maxBytes / 1024)} KB ` +
    `(tamanho original: ${originalBytes} bytes). Para baixar o conteúdo completo, ` +
    `use a API REST GET /v1/jobs/${jobId}/report?format=md ou leia jobs/${jobId}/report/report.md.\n`;

  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const prefixBudget = Math.max(0, maxBytes - noticeBytes);
  const prefix = sliceUtf8ToMaxBytes(content, prefixBudget);
  const combined = prefixBudget > 0 ? `${prefix}${notice}` : sliceUtf8ToMaxBytes(notice, maxBytes);

  return {
    content: combined,
    truncated: true,
    originalBytes,
    maxBytes,
  };
}

function createDefaultBlobReader(
  service: JobService | CleanroomJobService,
  dataDir?: string,
): EvidenceBlobReader {
  return (jobId, evidence) => {
    const withStore = service as Partial<CleanroomJobService>;
    if (withStore.evidence !== undefined && typeof withStore.evidence.readBlob === "function") {
      return withStore.evidence.readBlob(jobId, evidence.id);
    }
    if (dataDir !== undefined && evidence.blobPath !== undefined) {
      const jobDir = resolve(dataDir, "jobs", jobId);
      const fullPath = resolve(jobDir, evidence.blobPath);
      if (fullPath.startsWith(`${jobDir}${sep}`) && existsSync(fullPath)) {
        return readFileSync(fullPath);
      }
    }
    return null;
  };
}

/**
 * Cria e registra o servidor MCP `@cleanroom/mcp-server` (`kraken-cleanroom`)
 * com todas as ferramentas da Fase 1 (docs/07 §2, exceto handoff).
 */
export function createCleanroomMcpServer(
  options: CreateCleanroomMcpServerOptions,
): CleanroomMcpServerHandle {
  const { service } = options;
  const logger = options.logger ?? createStderrLogger({ name: MCP_SERVER_NAME });
  const readBlob = options.readEvidenceBlob ?? createDefaultBlobReader(service, options.dataDir);

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  server.registerTool(
    "cleanroom_init_manifest",
    {
      title: "Gerar manifesto clean room",
      description:
        "Gera um manifesto cleanroom.yaml com defaults seguros para estudo comportamental clean room (sala limpa, sem copiar código ou assets do alvo). Apenas gera e valida o YAML para revisão humana; não inicia execução de job.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe("URL inicial da aplicação alvo (https://... ou http://localhost:...)."),
        ownership: z
          .enum(OWNERSHIP_TYPES)
          .optional()
          .describe("Relação com o alvo: own, third-party ou client-authorized."),
        goals: z
          .array(z.string().min(1))
          .optional()
          .describe("Perguntas funcionais e objetivos do estudo clean room."),
      },
    },
    async ({ url, ownership, goals }) =>
      runTool(logger, "cleanroom_init_manifest", async () => {
        const yaml = await service.initManifest(url, {
          ...(ownership !== undefined ? { ownership } : {}),
          ...(goals !== undefined ? { goals } : {}),
        });
        return jsonTextResult({ yaml });
      }),
  );

  server.registerTool(
    "cleanroom_validate_manifest",
    {
      title: "Validar manifesto clean room",
      description:
        "Valida o YAML de um manifesto clean room contra o schema v1 e guardrails de escopo e ética. Um job só pode ser iniciado com manifesto válido.",
      inputSchema: {
        yaml: z.string().min(1).describe("Conteúdo YAML completo do manifesto cleanroom."),
      },
    },
    async ({ yaml }) =>
      runTool(logger, "cleanroom_validate_manifest", async () => {
        const result = await service.validateManifest(yaml);
        if (result.ok) {
          return jsonTextResult({
            ok: true,
            issues: [],
            manifest: result.manifest,
          });
        }
        return jsonTextResult({
          ok: false,
          issues: result.issues,
        });
      }),
  );

  server.registerTool(
    "cleanroom_start_job",
    {
      title: "Iniciar estudo clean room",
      description:
        "Inicia um job assíncrono de análise comportamental clean room (observação de UI, rede própria, docs e bundles públicos para especificação funcional). Recusa automaticamente qualquer manifesto inválido.",
      inputSchema: {
        yaml: z
          .string()
          .min(1)
          .describe("Conteúdo YAML de um manifesto cleanroom válido e aprovado."),
      },
    },
    async ({ yaml }) =>
      runTool(logger, "cleanroom_start_job", async () => {
        const { jobId } = await service.start(yaml);
        return jsonTextResult({ jobId });
      }),
  );

  server.registerTool(
    "cleanroom_status",
    {
      title: "Consultar status do job",
      description:
        "Consulta o estado atual de um job clean room, progresso por fase, contadores de páginas/evidências/achados/regras e consumo de tokens LLM.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job (ex.: cr-...)."),
      },
    },
    async ({ jobId }) =>
      runTool(logger, "cleanroom_status", async () => {
        const status = await service.status(jobId);
        return jsonTextResult(status);
      }),
  );

  server.registerTool(
    "cleanroom_list_jobs",
    {
      title: "Listar jobs clean room",
      description:
        "Lista os jobs de estudo clean room registrados no banco local, com filtro opcional por estado e limite de itens.",
      inputSchema: {
        state: z
          .enum(JOB_STATE_VALUES)
          .optional()
          .describe(`Filtra por estado do job (${JOB_STATES.join(" | ")}).`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Quantidade máxima de jobs retornados (1 a 500)."),
      },
    },
    async ({ state, limit }) =>
      runTool(logger, "cleanroom_list_jobs", async () => {
        const jobs = await service.list({
          ...(state !== undefined ? { state } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return jsonTextResult(jobs);
      }),
  );

  server.registerTool(
    "cleanroom_cancel_job",
    {
      title: "Cancelar job clean room",
      description:
        "Cancela um job clean room em execução ou pausado, preservando checkpoints já gravados e registrando o motivo.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job a cancelar."),
        reason: z.string().min(1).optional().describe("Motivo opcional do cancelamento."),
      },
    },
    async ({ jobId, reason }) =>
      runTool(logger, "cleanroom_cancel_job", async () => {
        await service.cancel(jobId, reason);
        return jsonTextResult({ ok: true, jobId });
      }),
  );

  server.registerTool(
    "cleanroom_resume_job",
    {
      title: "Retomar job clean room",
      description:
        "Retoma um job clean room interrompido a partir do último checkpoint de fase salvo, respeitando integralmente o manifesto original validado.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job a retomar."),
      },
    },
    async ({ jobId }) =>
      runTool(logger, "cleanroom_resume_job", async () => {
        await service.resume(jobId);
        return jsonTextResult({ ok: true, jobId });
      }),
  );

  server.registerTool(
    "cleanroom_get_report",
    {
      title: "Obter relatório clean room",
      description:
        "Retorna a especificação funcional clean room gerada pelo job em Markdown ou JSON (index.json), sem código/assets copiados do alvo. Relatórios Markdown acima de 200 KB são truncados com aviso indicando o endpoint REST.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job concluído."),
        format: z
          .enum(["markdown", "json"])
          .default("markdown")
          .describe("Formato desejado do relatório: 'markdown' (padrão) ou 'json'."),
      },
    },
    async ({ jobId, format }) =>
      runTool(logger, "cleanroom_get_report", async () => {
        const raw = await service.getReport(jobId, format);
        if (format === "markdown") {
          const result = truncateReportMarkdown(raw, jobId);
          return jsonTextResult({
            content: result.content,
            truncated: result.truncated,
            ...(result.truncated
              ? { originalBytes: result.originalBytes, maxBytes: result.maxBytes }
              : {}),
          });
        }
        return jsonTextResult({ content: raw, truncated: false });
      }),
  );

  server.registerTool(
    "cleanroom_list_rules",
    {
      title: "Listar regras de negócio inferidas",
      description:
        "Lista as regras de negócio funcionais (BR-NNN) sintetizadas para o job clean room, todas rastreáveis a evidências observadas e filtráveis por módulo ou confiança.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job."),
        module: z.string().min(1).optional().describe("Filtra pelo identificador do módulo."),
        confidence: z
          .enum(CONFIDENCE_LEVELS)
          .optional()
          .describe(`Filtra por nível de confiança (${CONFIDENCE_LEVELS.join(" | ")}).`),
      },
    },
    async ({ jobId, module, confidence }) =>
      runTool(logger, "cleanroom_list_rules", async () => {
        const rules = await service.listRules(jobId, {
          ...(module !== undefined ? { module } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
        });
        return jsonTextResult(rules);
      }),
  );

  server.registerTool(
    "cleanroom_list_evidence",
    {
      title: "Listar evidências do estudo",
      description:
        "Lista metadados paginados das evidências coletadas em estudo clean room para um job (sem incluir blobs binários), com filtro por tipo e cursor.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job."),
        kind: z
          .enum(EVIDENCE_KINDS)
          .optional()
          .describe(`Filtra por tipo de evidência (${EVIDENCE_KINDS.join(" | ")}).`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Quantidade máxima de evidências por página (1 a 500)."),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("Cursor de paginação retornado pela consulta anterior."),
      },
    },
    async ({ jobId, kind, limit, cursor }) =>
      runTool(logger, "cleanroom_list_evidence", async () => {
        const page = await service.listEvidence(jobId, {
          ...(kind !== undefined ? { kind } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return jsonTextResult(page);
      }),
  );

  server.registerTool(
    "cleanroom_get_evidence",
    {
      title: "Obter detalhe da evidência",
      description:
        "Retorna os metadados de uma evidência específica do estudo clean room. Para evidências do tipo 'screenshot', retorna também a imagem PNG em base64 quando o arquivo tiver até 1 MB.",
      inputSchema: {
        jobId: z.string().min(1).describe("Identificador do job."),
        evidenceId: z.string().min(1).describe("Identificador da evidência (ex.: ev-...)."),
      },
    },
    async ({ jobId, evidenceId }) =>
      runTool(logger, "cleanroom_get_evidence", async () => {
        const evidence = await service.getEvidence(jobId, evidenceId);
        const content: Array<TextContent | ImageContent> = [
          {
            type: "text",
            text: JSON.stringify(evidence, null, 2),
          },
        ];

        if (evidence.kind === "screenshot") {
          const blob = await readBlob(jobId, evidence);
          if (blob !== null && blob.byteLength > 0) {
            if (blob.byteLength <= MAX_SCREENSHOT_IMAGE_BYTES) {
              content.push({
                type: "image",
                data: blob.toString("base64"),
                mimeType: "image/png",
              });
            } else {
              content.push({
                type: "text",
                text:
                  `Aviso: screenshot (${blob.byteLength} bytes) excede o limite de 1 MB ` +
                  `(${MAX_SCREENSHOT_IMAGE_BYTES} bytes) para retorno inline via MCP. ` +
                  `Consulte o arquivo local em jobs/${jobId}/${evidence.blobPath ?? "evidence/screenshots"} ` +
                  `ou o endpoint REST GET /v1/jobs/${jobId}/evidence/${evidenceId}/blob.`,
              });
            }
          }
        }

        return { content };
      }),
  );

  return {
    server,
    service,
    logger,
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Inicia o servidor MCP `kraken-cleanroom` conectado via transporte `stdio`.
 * Garante que todos os logs operacionais sejam gravados em `stderr` (fd 2)
 * ou arquivo do job, mantendo `stdout` reservado exclusivamente ao protocolo JSON-RPC.
 */
export async function startMcpStdioServer(
  options: StartMcpStdioServerOptions = {},
): Promise<StartedMcpStdioServer> {
  const runtime =
    options.service === undefined
      ? createMcpJobService({
          env: options.env,
          cwd: options.cwd,
          enabledPhases: options.enabledPhases,
          fetch: options.fetch,
          cdpConnector: options.cdpConnector,
          llmClient: options.llmClient,
          logger: options.logger,
          stderr: options.stderr,
          timeoutMs: options.timeoutMs,
          now: options.now,
        })
      : undefined;

  const logger =
    options.logger ??
    runtime?.logger ??
    createStderrLogger({ name: MCP_SERVER_NAME, stderr: options.stderr });

  const service = options.service ?? runtime?.service;
  if (service === undefined) {
    throw new Error("Serviço de jobs indisponível para inicializar o servidor MCP.");
  }

  const handle = createCleanroomMcpServer({
    service,
    logger,
    dataDir: options.dataDir ?? runtime?.dataDir,
    readEvidenceBlob: options.readEvidenceBlob,
  });

  const transport = new StdioServerTransport(
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout,
  );

  let resolveClosed!: () => void;
  const closed = new Promise<void>((res) => {
    resolveClosed = res;
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await handle.close();
    } catch {
      // ignora erro no encerramento do servidor MCP
    }
    try {
      await runtime?.close();
    } catch {
      // ignora erro no encerramento do banco/serviço
    }
    resolveClosed();
  };

  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    previousOnClose?.();
    void shutdown();
  };

  transport.onerror = (err) => {
    logger.warn({ err }, "Erro no transporte MCP stdio");
  };

  await handle.server.connect(transport);
  logger.info({ server: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, "MCP stdio pronto");

  return {
    server: handle.server,
    transport,
    runtime,
    closed,
    close: shutdown,
  };
}
