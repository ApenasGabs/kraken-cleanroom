import {
  BrowserUnavailableError,
  DEFAULT_REPORT_VIEWPORTS,
  type Logger,
  type Manifest,
  redactUrlTokens,
} from "@cleanroom/core";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page as PlaywrightPage,
  chromium,
} from "playwright-core";

export interface ViewportSize {
  width: number;
  height: number;
}

export type ViewportInput = ViewportSize | readonly [number, number];

export interface CdpConnectOptions {
  timeout?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export type CdpConnector = (wsEndpoint: string, options?: CdpConnectOptions) => Promise<Browser>;

export interface BrowserSessionOptions {
  /**
   * Endpoint WebSocket CDP do Browserless (ex.: `ws://host:9222?token=...`).
   * Se omitido, lê `process.env.CLEANROOM_BROWSER_WS_ENDPOINT`.
   */
  wsEndpoint?: string | undefined;
  /** ID do job associado a este contexto isolado. */
  jobId?: string | undefined;
  /** Manifesto do job (usado para extrair `report.viewports`). */
  manifest?: Manifest | undefined;
  /** Lista explícita de viewports suportados (sobrescreve `manifest.report.viewports`). */
  viewports?: readonly ViewportInput[] | undefined;
  /** Viewport inicial/padrão do contexto (default: maior viewport desktop da lista, ex. 1440x900). */
  defaultViewport?: ViewportInput | undefined;
  /** Timeout de conexão CDP em milissegundos (default: 15000). */
  connectTimeoutMs?: number | undefined;
  /** User-Agent customizado do contexto. */
  userAgent?: string | undefined;
  /** Opções extras repassadas a `browser.newContext()` (ex.: `recordHar`, `locale`). */
  contextOptions?: BrowserContextOptions | undefined;
  /** Logger opcional do job/fase. */
  log?: Logger | undefined;
  /** Conector CDP injetável para testes unitários determinísticos. */
  cdpConnector?: CdpConnector | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 CleanroomExplorer/0.1";

export function sanitizeCdpText(text: string): string {
  let sanitized = redactUrlTokens(text);
  sanitized = sanitized.replace(
    /([?&](?:token|api[_-]?key|key|secret|password|auth|access[_-]?token)=)([^&#\s]+)/gi,
    "$1[REDACTED]",
  );
  sanitized = sanitized.replace(/((?:wss?|https?):\/\/)([^/@\s]+:[^/@\s]+)@/gi, "$1[REDACTED]@");
  return sanitized;
}

export function normalizeViewport(input: ViewportInput): ViewportSize {
  const width = Array.isArray(input) ? input[0] : (input as ViewportSize).width;
  const height = Array.isArray(input) ? input[1] : (input as ViewportSize).height;

  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 200 ||
    height < 200 ||
    width > 7680 ||
    height > 4320
  ) {
    throw new RangeError(
      `Viewport inválido (${String(width)}x${String(height)}): largura deve estar entre 200..7680 e altura entre 200..4320.`,
    );
  }

  return { width, height };
}

export function resolveViewportsList(
  viewportsInput?: readonly ViewportInput[] | undefined,
  manifest?: Manifest | undefined,
): ViewportSize[] {
  const rawList: readonly ViewportInput[] =
    viewportsInput && viewportsInput.length > 0
      ? viewportsInput
      : manifest?.report.viewports && manifest.report.viewports.length > 0
        ? manifest.report.viewports
        : DEFAULT_REPORT_VIEWPORTS;

  const seen = new Set<string>();
  const normalized: ViewportSize[] = [];
  for (const item of rawList) {
    const vp = normalizeViewport(item);
    const key = `${vp.width}x${vp.height}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(vp);
    }
  }
  return normalized;
}

export function selectDesktopViewport(viewports: readonly ViewportSize[]): ViewportSize {
  const first = viewports[0];
  if (!first) {
    return { width: 1440, height: 900 };
  }
  let widest = first;
  for (const vp of viewports) {
    if (vp.width > widest.width || (vp.width === widest.width && vp.height > widest.height)) {
      widest = vp;
    }
  }
  return { width: widest.width, height: widest.height };
}

function validateWsEndpoint(rawEndpoint: string | undefined): string {
  const trimmed = rawEndpoint?.trim();
  if (!trimmed) {
    throw new BrowserUnavailableError(
      "CLEANROOM_BROWSER_WS_ENDPOINT não configurado. Defina um endpoint WebSocket CDP válido (ws:// ou wss://).",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new BrowserUnavailableError(
      `CLEANROOM_BROWSER_WS_ENDPOINT inválido ("${sanitizeCdpText(trimmed)}"): esperado URL ws:// ou wss://.`,
      { cause: err },
    );
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new BrowserUnavailableError(
      `CLEANROOM_BROWSER_WS_ENDPOINT deve usar protocolo ws:// ou wss:// (recebido "${parsed.protocol}").`,
    );
  }

  return trimmed;
}

const defaultCdpConnector: CdpConnector = (wsEndpoint, options) =>
  chromium.connectOverCDP(wsEndpoint, {
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options?.headers !== undefined ? { headers: options.headers } : {}),
  });

/**
 * Gerencia uma sessão remota no Browserless via CDP (`chromium.connectOverCDP`),
 * isolando um único `BrowserContext` por job, controlando viewports e garantindo
 * fechamento limpo (`context.close()` + `browser.close()`) em blocos `finally`.
 */
export class BrowserSession implements AsyncDisposable {
  readonly jobId: string | undefined;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly viewports: readonly ViewportSize[];
  readonly defaultViewport: ViewportSize;

  private currentViewportState: ViewportSize;
  private primaryPage: PlaywrightPage | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly log: Logger | undefined;

  private constructor(params: {
    jobId?: string | undefined;
    browser: Browser;
    context: BrowserContext;
    viewports: readonly ViewportSize[];
    defaultViewport: ViewportSize;
    log?: Logger | undefined;
  }) {
    this.jobId = params.jobId;
    this.browser = params.browser;
    this.context = params.context;
    this.viewports = Object.freeze([...params.viewports]);
    this.defaultViewport = { ...params.defaultViewport };
    this.currentViewportState = { ...params.defaultViewport };
    this.log = params.log;
  }

  /**
   * Conecta ao Browserless via CDP e cria um `BrowserContext` isolado para o job.
   * Caso a criação do contexto falhe após conectar o browser, garante `browser.close()` em `finally`.
   */
  static async connect(options?: BrowserSessionOptions): Promise<BrowserSession> {
    const rawEndpoint = options?.wsEndpoint ?? process.env.CLEANROOM_BROWSER_WS_ENDPOINT;
    const wsEndpoint = validateWsEndpoint(rawEndpoint);
    const redactedEndpoint = sanitizeCdpText(wsEndpoint);
    const timeout = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const connector = options?.cdpConnector ?? defaultCdpConnector;

    const viewports = resolveViewportsList(options?.viewports, options?.manifest);
    const defaultViewport = options?.defaultViewport
      ? normalizeViewport(options.defaultViewport)
      : selectDesktopViewport(viewports);

    let browser: Browser;
    try {
      browser = await connector(wsEndpoint, { timeout });
    } catch (err) {
      const msg =
        err instanceof Error ? sanitizeCdpText(err.message) : sanitizeCdpText(String(err));
      throw new BrowserUnavailableError(
        `Falha ao conectar ao Browserless via CDP (${redactedEndpoint}): ${msg}`,
        { cause: err },
      );
    }

    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        ...options?.contextOptions,
        viewport: { width: defaultViewport.width, height: defaultViewport.height },
        userAgent: options?.userAgent ?? options?.contextOptions?.userAgent ?? DEFAULT_USER_AGENT,
      });

      options?.log?.debug(
        {
          jobId: options?.jobId,
          endpoint: redactedEndpoint,
          defaultViewport,
          viewportsCount: viewports.length,
        },
        "sessão CDP e BrowserContext isolado criados",
      );

      return new BrowserSession({
        jobId: options?.jobId ?? options?.manifest?.job.name,
        browser,
        context,
        viewports,
        defaultViewport,
        log: options?.log,
      });
    } catch (err) {
      try {
        if (context) {
          await context.close();
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
      const msg =
        err instanceof Error ? sanitizeCdpText(err.message) : sanitizeCdpText(String(err));
      throw new BrowserUnavailableError(
        `Falha ao criar BrowserContext isolado no Browserless (${redactedEndpoint}): ${msg}`,
        { cause: err },
      );
    }
  }

  /**
   * Executa `fn` com uma `BrowserSession` ativa e garante `session.close()` em bloco `finally`.
   */
  static async withSession<T>(
    options: BrowserSessionOptions | undefined,
    fn: (session: BrowserSession) => Promise<T>,
  ): Promise<T> {
    const session = await BrowserSession.connect(options);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get currentViewport(): ViewportSize {
    return { ...this.currentViewportState };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BrowserUnavailableError("A BrowserSession já foi encerrada.");
    }
  }

  /**
   * Cria uma nova aba/página dentro do `BrowserContext` isolado do job,
   * já dimensionada para o `currentViewport`.
   */
  async newPage(): Promise<PlaywrightPage> {
    this.assertOpen();
    const page = await this.context.newPage();
    await page.setViewportSize({
      width: this.currentViewportState.width,
      height: this.currentViewportState.height,
    });
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      this.primaryPage = page;
    }
    return page;
  }

  /**
   * Retorna a página principal do job (criando-a sob demanda caso ainda não exista).
   */
  async getPage(): Promise<PlaywrightPage> {
    this.assertOpen();
    if (this.primaryPage && !this.primaryPage.isClosed()) {
      return this.primaryPage;
    }
    return this.newPage();
  }

  /**
   * Altera o viewport da página informada (ou da página principal / páginas abertas no contexto).
   */
  async setViewport(viewport: ViewportInput, page?: PlaywrightPage): Promise<ViewportSize> {
    this.assertOpen();
    const normalized = normalizeViewport(viewport);
    this.currentViewportState = { ...normalized };

    if (page) {
      await page.setViewportSize(normalized);
      return normalized;
    }

    const openPages = this.context.pages().filter((p) => !p.isClosed());
    if (openPages.length > 0) {
      for (const openPage of openPages) {
        await openPage.setViewportSize(normalized);
      }
    } else if (this.primaryPage && !this.primaryPage.isClosed()) {
      await this.primaryPage.setViewportSize(normalized);
    }

    return normalized;
  }

  /**
   * Executa `fn` com a página redimensionada para `viewport` e restaura o viewport anterior em `finally`.
   */
  async withViewport<T>(
    viewport: ViewportInput,
    fn: (page: PlaywrightPage, vp: ViewportSize) => Promise<T>,
    page?: PlaywrightPage,
  ): Promise<T> {
    this.assertOpen();
    const targetPage = page ?? (await this.getPage());
    const previousViewport = this.currentViewport;
    const applied = await this.setViewport(viewport, targetPage);
    try {
      return await fn(targetPage, applied);
    } finally {
      if (!this.closed && !targetPage.isClosed()) {
        await this.setViewport(previousViewport, targetPage);
      }
    }
  }

  /**
   * Itera sobre todos os viewports configurados na sessão, aplicando cada um à página
   * e restaurando o viewport original em `finally`.
   */
  async forEachViewport<T>(
    fn: (viewport: ViewportSize, page: PlaywrightPage) => Promise<T>,
    page?: PlaywrightPage,
  ): Promise<T[]> {
    this.assertOpen();
    const targetPage = page ?? (await this.getPage());
    const previousViewport = this.currentViewport;
    const results: T[] = [];
    try {
      for (const vp of this.viewports) {
        await this.setViewport(vp, targetPage);
        results.push(await fn({ ...vp }, targetPage));
      }
      return results;
    } finally {
      if (!this.closed && !targetPage.isClosed()) {
        await this.setViewport(previousViewport, targetPage);
      }
    }
  }

  /**
   * Fecha o `BrowserContext` isolado e a conexão CDP (`Browser`) em blocos `finally` encadeados.
   * Método idempotente: múltiplas chamadas aguardam a mesma promessa de fechamento.
   */
  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    let contextError: unknown;
    let browserError: unknown;

    try {
      await this.context.close();
    } catch (err) {
      contextError = err;
    } finally {
      try {
        await this.browser.close();
      } catch (err) {
        browserError = err;
      }
    }

    this.primaryPage = null;
    this.log?.debug({ jobId: this.jobId }, "sessão CDP encerrada");

    const firstError = contextError ?? browserError;
    if (firstError !== undefined) {
      const msg =
        firstError instanceof Error
          ? sanitizeCdpText(firstError.message)
          : sanitizeCdpText(String(firstError));
      throw new BrowserUnavailableError(`Erro ao encerrar sessão CDP: ${msg}`, {
        cause: firstError,
      });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function withBrowserSession<T>(
  options: BrowserSessionOptions | undefined,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  return BrowserSession.withSession(options, fn);
}
