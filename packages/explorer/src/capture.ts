import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Evidence,
  HarEntry,
  HarLog,
  NetworkCallEvidenceData,
  Phase,
  PhaseContext,
  PhaseResult,
  PublicScriptInfo,
  SanitizedHarResult,
} from "@cleanroom/core";
import { type HarSanitizerOptions, sanitizeHar } from "./har-sanitizer.js";

export interface CapturePhaseOptions {
  /** HAR bruto explícito para testes ou execução direta em memória. */
  rawHar?: HarLog | string | undefined;
  /** Caminho do arquivo HAR bruto a ler (sobrescreve o padrão do job). */
  rawHarPath?: string | undefined;
  /** Opções de sanitização do HAR. */
  sanitizerOptions?: HarSanitizerOptions | undefined;
}

export interface CaptureRunResult {
  phaseResult: PhaseResult;
  sanitized: SanitizedHarResult;
  harFilePath: string;
  scriptsIndexPath: string;
  networkCallEvidences: Evidence[];
}

/**
 * Cria uma estrutura mínima e válida de log HAR 1.2 a partir de entradas.
 */
export function createHarLog(
  entries: HarEntry[],
  meta?: { creatorName?: string; creatorVersion?: string },
): HarLog {
  return {
    log: {
      version: "1.2",
      creator: {
        name: meta?.creatorName ?? "kraken-cleanroom-capture",
        version: meta?.creatorVersion ?? "0.1.0",
      },
      browser: {
        name: "CleanroomExplorer",
        version: "0.1.0",
      },
      pages: [
        {
          startedDateTime: new Date().toISOString(),
          id: "cleanroom_capture_page",
          title: "Cleanroom Capture Session",
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries,
    },
  };
}

/**
 * Constrói uma entrada HAR a partir de uma resposta e requisição HTTP observadas.
 */
export function buildHarEntryFromHttp(params: {
  url: string;
  method?: string;
  status: number;
  statusText?: string;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  reqBody?: string;
  resBody?: string;
  resourceType?: string;
  startedDateTime?: string;
  durationMs?: number;
}): HarEntry {
  const method = (params.method ?? "GET").toUpperCase();
  const reqHeaders = params.reqHeaders ?? {};
  const resHeaders = params.resHeaders ?? {};

  const harReqHeaders = Object.entries(reqHeaders).map(([name, value]) => ({ name, value }));
  const harResHeaders = Object.entries(resHeaders).map(([name, value]) => ({ name, value }));

  const queryString: { name: string; value: string }[] = [];
  try {
    const parsed = new URL(params.url);
    parsed.searchParams.forEach((value, name) => {
      queryString.push({ name, value });
    });
  } catch {
    // ignora
  }

  const reqMimeType =
    reqHeaders["content-type"] ??
    reqHeaders["Content-Type"] ??
    (params.reqBody?.startsWith("{") ? "application/json" : "text/plain");
  const resMimeType =
    resHeaders["content-type"] ??
    resHeaders["Content-Type"] ??
    (params.resBody?.startsWith("{") ? "application/json" : "text/html; charset=utf-8");

  const entry: HarEntry = {
    _resourceType:
      params.resourceType ?? (queryString.length > 0 || params.reqBody ? "fetch" : "document"),
    startedDateTime: params.startedDateTime ?? new Date().toISOString(),
    time: params.durationMs ?? 10,
    request: {
      method,
      url: params.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: harReqHeaders,
      queryString,
      ...(params.reqBody ? { postData: { mimeType: reqMimeType, text: params.reqBody } } : {}),
      headersSize: -1,
      bodySize: params.reqBody ? Buffer.byteLength(params.reqBody, "utf8") : 0,
    },
    response: {
      status: params.status,
      statusText:
        params.statusText ??
        (params.status === 200 ? "OK" : params.status === 201 ? "Created" : ""),
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: harResHeaders,
      content: {
        size: params.resBody ? Buffer.byteLength(params.resBody, "utf8") : 0,
        mimeType: resMimeType,
        text: params.resBody ?? "",
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: params.resBody ? Buffer.byteLength(params.resBody, "utf8") : 0,
    },
    cache: {},
    timings: { send: 1, wait: 5, receive: 4 },
  };

  return entry;
}

/**
 * Executa a Fase 3 (capture):
 * 1. Recupera o tráfego de rede gravado durante o explore (ou injetado/coletado).
 * 2. Aplica sanitização rigorosa eliminando cookies, tokens, chaves e credenciais.
 * 3. Persiste o HAR sanitizado em `jobs/<jobId>/evidence/har/har.json`.
 * 4. Indexa requisições `fetch/xhr` como evidências `network_call` (com shapes sem valores).
 * 5. Salva o catálogo de scripts públicos para uso do `bundleAnalyzer` (`F1-10`).
 */
export async function runCapturePhase(
  ctx: PhaseContext,
  options?: CapturePhaseOptions,
): Promise<CaptureRunResult> {
  ctx.log.info({ jobId: ctx.job.id }, "iniciando Fase 3 (capture)");

  let rawHarLog: HarLog | undefined;

  // 1. Tenta carregar do options direto
  if (options?.rawHar) {
    rawHarLog =
      typeof options.rawHar === "string" ? (JSON.parse(options.rawHar) as HarLog) : options.rawHar;
  }

  // 2. Tenta carregar do caminho especificado ou default do job
  const jobDir = ctx.evidence.resolveJobDir(ctx.job.id);
  const defaultRawHarPath = options?.rawHarPath ?? join(jobDir, "raw", "network.har");

  if (!rawHarLog && existsSync(defaultRawHarPath)) {
    try {
      const fileContent = readFileSync(defaultRawHarPath, "utf8");
      rawHarLog = JSON.parse(fileContent) as HarLog;
    } catch (err) {
      ctx.log.warn(
        { err, rawHarPath: defaultRawHarPath },
        "falha ao ler HAR bruto do disco, tentando fontes alternativas",
      );
    }
  }

  // 3. Fallback: verifica se há entradas gravadas no checkpoint ou em arquivos temporários
  if (!rawHarLog) {
    const rawAltPath = join(jobDir, "evidence", "har", "raw.har");
    if (existsSync(rawAltPath)) {
      try {
        rawHarLog = JSON.parse(readFileSync(rawAltPath, "utf8")) as HarLog;
      } catch {
        // ignora
      }
    }
  }

  // 4. Se não encontrar HAR em disco (ex: em testes com fake/intake apenas),
  // monta um HAR a partir das evidências http_response já registradas no job
  if (!rawHarLog) {
    const httpEvidences = ctx.evidence.list({
      jobId: ctx.job.id,
      kind: "http_response",
      limit: 200,
    });
    const fallbackEntries: HarEntry[] = [];

    for (const ev of httpEvidences.items) {
      if (ev.url) {
        const status = typeof ev.data.status === "number" ? ev.data.status : 200;
        const resBody = typeof ev.data.body === "string" ? ev.data.body : undefined;
        fallbackEntries.push(
          buildHarEntryFromHttp({
            url: ev.url,
            status,
            ...(resBody !== undefined ? { resBody } : {}),
            startedDateTime: ev.createdAt,
          }),
        );
      }
    }

    rawHarLog = createHarLog(fallbackEntries);
  }

  // 5. Executa a sanitização rigorosa (clean room)
  const sanitized = sanitizeHar(rawHarLog, options?.sanitizerOptions);

  // 6. Garante diretório de destino `jobs/<jobId>/evidence/har/` e persiste `har.json`
  const harEvidenceDir = join(jobDir, "evidence", "har");
  mkdirSync(harEvidenceDir, { recursive: true });
  const harFilePath = join(harEvidenceDir, "har.json");
  const sanitizedHarJson = JSON.stringify(sanitized.har, null, 2);
  writeFileSync(harFilePath, sanitizedHarJson, "utf8");

  // Também persiste o HAR como evidência estruturada via EvidenceStore
  const harSha256 = createHash("sha256").update(sanitizedHarJson).digest("hex");
  ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "http_response",
    phase: "capture",
    sha256: harSha256,
    blob: sanitizedHarJson,
    blobSubdir: "har",
    blobExt: "har",
    summary: `HAR sanitizado com ${sanitized.har.log.entries.length} entradas e ${sanitized.apiCalls.length} chamadas de API`,
    data: {
      entriesCount: sanitized.har.log.entries.length,
      apiCallsCount: sanitized.apiCalls.length,
      publicScriptsCount: sanitized.publicScripts.length,
      stats: sanitized.stats,
      harPath: "evidence/har/har.json",
    },
  });

  // 7. Persiste catálogo de scripts públicos para o bundleAnalyzer (`F1-10`)
  const analysisDir = join(jobDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const scriptsIndexPath = join(analysisDir, "scripts-index.json");
  writeFileSync(scriptsIndexPath, JSON.stringify(sanitized.publicScripts, null, 2), "utf8");

  // 8. Indexa requisições `fetch/xhr` como evidências `network_call`
  const networkCallEvidences: Evidence[] = [];
  for (const call of sanitized.apiCalls) {
    const callSha256 = createHash("sha256")
      .update(JSON.stringify({ method: call.method, url: call.url, status: call.status }))
      .digest("hex");

    const reqShapeSummary = call.reqShape ? ` (req: ${JSON.stringify(call.reqShape)})` : "";
    const resShapeSummary = call.resShape ? ` (res: ${JSON.stringify(call.resShape)})` : "";
    const summary =
      `network_call ${call.method} ${call.pathTemplate} -> ${call.status}${reqShapeSummary}${resShapeSummary}`.slice(
        0,
        300,
      );

    const ev = ctx.evidence.put({
      jobId: ctx.job.id,
      kind: "network_call",
      phase: "capture",
      url: call.url,
      sha256: callSha256,
      summary,
      data: call as unknown as Record<string, unknown>,
    });
    networkCallEvidences.push(ev);
  }

  // 9. Atualiza o checkpoint da fase capture
  const checkpoint = {
    harFilePath: "evidence/har/har.json",
    entriesCount: sanitized.har.log.entries.length,
    apiCallsCount: sanitized.apiCalls.length,
    scriptsCount: sanitized.publicScripts.length,
    stats: sanitized.stats,
    updatedAt: new Date().toISOString(),
  };
  ctx.saveCheckpoint(checkpoint);

  const phaseResult: PhaseResult = {
    status: "ok",
    stats: {
      entriesRecorded: sanitized.har.log.entries.length,
      apiCallsIndexed: sanitized.apiCalls.length,
      scriptsIndexed: sanitized.publicScripts.length,
      headersRemoved: sanitized.stats.headersRemoved,
      cookiesPurged: sanitized.stats.cookiesPurged,
      queryParamsRedacted: sanitized.stats.queryParamsRedacted,
      bodyFieldsRedacted: sanitized.stats.bodyFieldsRedacted,
      bodiesTruncated: sanitized.stats.bodiesTruncated,
    },
  };

  ctx.log.info(
    {
      jobId: ctx.job.id,
      apiCallsCount: sanitized.apiCalls.length,
      scriptsCount: sanitized.publicScripts.length,
      headersRemoved: sanitized.stats.headersRemoved,
      cookiesPurged: sanitized.stats.cookiesPurged,
    },
    "Fase 3 (capture) concluída com sucesso",
  );

  return {
    phaseResult,
    sanitized,
    harFilePath,
    scriptsIndexPath,
    networkCallEvidences,
  };
}

/**
 * Cria a definição da Fase 3 (capture) para registro no JobRunner.
 */
export function createCapturePhase(options?: CapturePhaseOptions): Phase {
  return {
    id: "capture",
    isEnabled(manifest): boolean {
      return manifest.target.type !== "repo" && manifest.methods.networkHar === true;
    },
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      const res = await runCapturePhase(ctx, options);
      return res.phaseResult;
    },
  };
}

export const capturePhase: Phase = createCapturePhase();
