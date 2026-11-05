import picomatch from "picomatch";
import { DestructiveActionError, MethodNotAllowedError, OutOfScopeError } from "./errors.js";
import { type Manifest, type ManifestMethod, mergeForbiddenPaths } from "./manifest.js";

export interface RobotsPolicy {
  disallow: string[];
  allow: string[];
}

export interface ScopeGuardOptions {
  /**
   * Conteúdo bruto do `robots.txt` ou regras já parseadas para avaliar quando
   * `manifest.limits.respectRobotsTxt === true`.
   */
  robotsTxt?: string | RobotsPolicy | undefined;
  /**
   * User-Agent a considerar ao interpretar blocos `User-agent:` do `robots.txt`.
   * Default: `"kraken-cleanroom"`.
   */
  userAgent?: string | undefined;
  /**
   * Relógio customizado (retorna timestamp em ms) para testes determinísticos de `throttle()`.
   */
  now?: (() => number) | undefined;
  /**
   * Função de espera customizada (recebe ms) para testes determinísticos de `throttle()`.
   */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface ScopeGuard {
  readonly manifest: Manifest;
  readonly forbiddenPaths: readonly string[];
  assertMethod(method: ManifestMethod): void;
  canNavigate(url: string): boolean;
  assertCanNavigate(url: string): void;
  isDestructive(labelOrAction: string): boolean;
  assertNotDestructive(labelOrAction: string): void;
  throttle(): Promise<void>;
  setRobotsTxt(robotsTxt: string | RobotsPolicy): void;
}

const DESTRUCTIVE_KEYWORDS_REGEX =
  /\b(?:excluir|deletar|remover|apagar|cancelar\s+assinatura|delete|remove|destroy|unsubscribe|sair|logout|sign\s*out|publicar|publish|enviar\s+convite|invite|pagar|pay|comprar|buy|checkout)\b/i;

const DESTRUCTIVE_ACTION_PATH_REGEX =
  /(?:^|[/_.-])(?:logout|signout|sign-out|delete|remove|destroy|unsubscribe|checkout|pay|purchase|cancel-subscription)(?:$|[/_?#.-])/i;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRobotsPattern(rawPattern: string): string {
  const withoutComment = rawPattern.split("#")[0]?.trim() ?? "";
  return withoutComment;
}

export function parseRobotsTxt(
  content: string,
  targetUserAgent = "kraken-cleanroom",
): RobotsPolicy {
  const lines = content.split(/\r?\n/);
  const normalizedTargetUa = targetUserAgent.toLowerCase();

  interface Group {
    agents: string[];
    disallow: string[];
    allow: string[];
  }

  const groups: Group[] = [];
  let currentGroup: Group | null = null;
  let lastSeenDirectiveWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) {
      lastSeenDirectiveWasAgent = false;
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    const directive = line.slice(0, colonIndex).trim().toLowerCase();
    const value = normalizeRobotsPattern(line.slice(colonIndex + 1));

    if (directive === "user-agent") {
      const ua = value.toLowerCase();
      if (!currentGroup || !lastSeenDirectiveWasAgent) {
        currentGroup = { agents: [ua], disallow: [], allow: [] };
        groups.push(currentGroup);
      } else {
        currentGroup.agents.push(ua);
      }
      lastSeenDirectiveWasAgent = true;
      continue;
    }

    lastSeenDirectiveWasAgent = false;
    if (!currentGroup) {
      continue;
    }

    if (directive === "disallow") {
      if (value.length > 0) {
        currentGroup.disallow.push(value);
      }
    } else if (directive === "allow") {
      if (value.length > 0) {
        currentGroup.allow.push(value);
      }
    }
  }

  const specificGroups = groups.filter((g) =>
    g.agents.some((ua) => ua !== "*" && normalizedTargetUa.includes(ua)),
  );
  const wildcardGroups = groups.filter((g) => g.agents.includes("*"));
  const relevantGroups = specificGroups.length > 0 ? specificGroups : wildcardGroups;

  const disallow: string[] = [];
  const allow: string[] = [];

  for (const group of relevantGroups) {
    disallow.push(...group.disallow);
    allow.push(...group.allow);
  }

  return { disallow, allow };
}

function robotsPatternMatches(pathAndQuery: string, pattern: string): boolean {
  if (pattern.length === 0) {
    return false;
  }

  const endsWithDollar = pattern.endsWith("$");
  const cleanPattern = endsWithDollar ? pattern.slice(0, -1) : pattern;

  const escaped = cleanPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  const regexStr = `^${escaped}${endsWithDollar ? "$" : ""}`;
  try {
    const regex = new RegExp(regexStr);
    return regex.test(pathAndQuery);
  } catch {
    return pathAndQuery.startsWith(cleanPattern);
  }
}

export function isAllowedByRobots(pathAndQuery: string, policy: RobotsPolicy): boolean {
  let longestDisallow = -1;
  for (const pattern of policy.disallow) {
    if (robotsPatternMatches(pathAndQuery, pattern)) {
      if (pattern.length > longestDisallow) {
        longestDisallow = pattern.length;
      }
    }
  }

  if (longestDisallow === -1) {
    return true;
  }

  let longestAllow = -1;
  for (const pattern of policy.allow) {
    if (robotsPatternMatches(pathAndQuery, pattern)) {
      if (pattern.length > longestAllow) {
        longestAllow = pattern.length;
      }
    }
  }

  // Na especificação do robots.txt (RFC 9309), a regra mais específica (maior comprimento) vence;
  // em caso de empate, Allow prevalece sobre Disallow.
  return longestAllow >= longestDisallow;
}

function safeDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createScopeGuard(manifest: Manifest, options?: ScopeGuardOptions): ScopeGuard {
  const forbiddenPaths = Object.freeze(mergeForbiddenPaths(manifest.limits.forbiddenPaths));
  const isForbiddenMatcher = picomatch([...forbiddenPaths], {
    dot: true,
    nocase: true,
  });

  const allowedOriginsSet = new Set<string>(manifest.target.allowedOrigins);
  if (manifest.target.url) {
    try {
      allowedOriginsSet.add(new URL(manifest.target.url).origin);
    } catch {
      // Ignorado se target.url não for parseável
    }
  }

  let robotsPolicy: RobotsPolicy | null = null;
  if (options?.robotsTxt !== undefined) {
    robotsPolicy =
      typeof options.robotsTxt === "string"
        ? parseRobotsTxt(options.robotsTxt, options.userAgent)
        : options.robotsTxt;
  }

  const rateLimitRps = Math.max(0.1, manifest.limits.rateLimitRps);
  // Capacidade máxima do balde: permite 1 requisição imediata e aplica espaçamento estrito
  // de 1000 / rateLimitRps ms para chamadas subsequentes.
  const bucketCapacity = 1;
  let tokens = bucketCapacity;
  const nowFn = options?.now ?? (() => Date.now());
  const sleepFn = options?.sleep ?? defaultSleep;
  let lastRefillMs = nowFn();
  let throttleQueue: Promise<void> = Promise.resolve();

  function matchesForbiddenPath(parsedUrl: URL): boolean {
    const rawPathname = parsedUrl.pathname || "/";
    const decodedPathname = safeDecodePath(rawPathname);
    const trimmedRaw = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;
    const trimmedDecoded =
      decodedPathname.length > 1 ? decodedPathname.replace(/\/+$/, "") : decodedPathname;

    const candidates = [
      rawPathname,
      decodedPathname,
      trimmedRaw,
      trimmedDecoded,
      rawPathname.replace(/^\/+/, ""),
      decodedPathname.replace(/^\/+/, ""),
      `${rawPathname}${parsedUrl.search}`,
      `${decodedPathname}${parsedUrl.search}`,
    ];

    return candidates.some((candidate) => candidate.length > 0 && isForbiddenMatcher(candidate));
  }

  const guard: ScopeGuard = {
    manifest,
    forbiddenPaths,

    assertMethod(method: ManifestMethod): void {
      if (manifest.methods[method] !== true) {
        throw new MethodNotAllowedError(
          `O método "${method}" não está habilitado no manifesto deste job (methods.${method} = false).`,
          { method },
        );
      }

      if (method === "authenticatedSession" && manifest.accounts.strategy === "none") {
        throw new MethodNotAllowedError(
          'O método "authenticatedSession" exige uma estratégia de conta configurada (accounts.strategy != "none").',
          { method },
        );
      }
    },

    canNavigate(url: string): boolean {
      let parsed: URL;
      try {
        parsed = manifest.target.url ? new URL(url, manifest.target.url) : new URL(url);
      } catch {
        return false;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }

      if (!allowedOriginsSet.has(parsed.origin)) {
        return false;
      }

      if (matchesForbiddenPath(parsed)) {
        return false;
      }

      if (manifest.limits.respectRobotsTxt && robotsPolicy !== null) {
        const pathAndQuery = `${parsed.pathname}${parsed.search}`;
        if (!isAllowedByRobots(pathAndQuery, robotsPolicy)) {
          return false;
        }
      }

      return true;
    },

    assertCanNavigate(url: string): void {
      if (!guard.canNavigate(url)) {
        throw new OutOfScopeError(
          `Navegação bloqueada pelo ScopeGuard: a URL "${url}" está fora de allowedOrigins, coincide com forbiddenPaths ou é bloqueada pelo robots.txt.`,
          { url },
        );
      }
    },

    isDestructive(labelOrAction: string): boolean {
      const normalized = labelOrAction.trim();
      if (normalized.length === 0) {
        return true; // Na dúvida, tratar como destrutivo (docs/04 Fase 2)
      }

      if (DESTRUCTIVE_KEYWORDS_REGEX.test(normalized)) {
        return true;
      }

      if (DESTRUCTIVE_ACTION_PATH_REGEX.test(normalized)) {
        return true;
      }

      return false;
    },

    assertNotDestructive(labelOrAction: string): void {
      if (manifest.limits.destructiveActions) {
        return;
      }
      if (guard.isDestructive(labelOrAction)) {
        throw new DestructiveActionError(
          `Ação destrutiva bloqueada pelo ScopeGuard: "${labelOrAction}" (limits.destructiveActions = false).`,
          { actionLabel: labelOrAction },
        );
      }
    },

    throttle(): Promise<void> {
      const next = throttleQueue.then(async () => {
        const currentMs = nowFn();
        const elapsedSec = Math.max(0, (currentMs - lastRefillMs) / 1000);
        tokens = Math.min(bucketCapacity, tokens + elapsedSec * rateLimitRps);
        lastRefillMs = currentMs;

        if (tokens >= 1) {
          tokens -= 1;
          return;
        }

        const deficit = 1 - tokens;
        const waitMs = Math.ceil((deficit / rateLimitRps) * 1000);
        tokens = 0;
        lastRefillMs = currentMs + waitMs;
        if (waitMs > 0) {
          await sleepFn(waitMs);
        }
      });

      throttleQueue = next.catch(() => {
        // Evita travar a fila caso ocorra erro inesperado
      });

      return next;
    },

    setRobotsTxt(robotsTxt: string | RobotsPolicy): void {
      robotsPolicy =
        typeof robotsTxt === "string" ? parseRobotsTxt(robotsTxt, options?.userAgent) : robotsTxt;
    },
  };

  return guard;
}
