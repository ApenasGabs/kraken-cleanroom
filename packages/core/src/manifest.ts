import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ManifestError, type ManifestIssueDetail } from "./errors.js";

export const TARGET_TYPES = ["web-spa", "web-ssr", "web-unknown", "repo"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const OWNERSHIP_TYPES = ["own", "third-party", "client-authorized"] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

export const FORM_SUBMISSION_MODES = ["none", "validation-only", "full"] as const;
export type FormSubmissionMode = (typeof FORM_SUBMISSION_MODES)[number];

export const ACCOUNT_STRATEGIES = ["none", "provided", "signup"] as const;
export type AccountStrategy = (typeof ACCOUNT_STRATEGIES)[number];

export const ACCOUNT_IDENTITIES = ["owner"] as const;
export type AccountIdentity = (typeof ACCOUNT_IDENTITIES)[number];

export const CHALLENGE_ACTIONS = ["handoff", "abort"] as const;
export type ChallengeAction = (typeof CHALLENGE_ACTIONS)[number];

export const PAYMENT_ACTIONS = ["require-approval", "abort"] as const;
export type PaymentAction = (typeof PAYMENT_ACTIONS)[number];

export const REPORT_SECTIONS = [
  "executive-summary",
  "product-vision",
  "functional-map",
  "domain-model",
  "business-rules",
  "state-machines",
  "main-flows",
  "api-contract",
  "roles-permissions",
  "validations-messages",
  "external-integrations",
  "acceptance-criteria",
  "gaps-hypotheses",
  "appendix",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const DEFAULT_FORBIDDEN_PATHS = [
  "**/logout",
  "**/delete*",
  "**/admin/**",
  "**/checkout/**",
] as const;

export const DEFAULT_REPORT_VIEWPORTS: readonly (readonly [number, number])[] = [
  [375, 812],
  [768, 1024],
  [1440, 900],
];

export const MANIFEST_METHODS = [
  "behavioralUi",
  "networkHar",
  "publicDocs",
  "staticBundles",
  "binaryAnalysis",
  "sourceRepo",
  "authenticatedSession",
] as const;
export type ManifestMethod = (typeof MANIFEST_METHODS)[number];

function isValidHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalhostHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") {
      return false;
    }
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function mergeForbiddenPaths(userPaths?: readonly string[] | undefined): string[] {
  const merged = new Set<string>(DEFAULT_FORBIDDEN_PATHS);
  if (userPaths) {
    for (const pattern of userPaths) {
      const trimmed = pattern.trim();
      if (trimmed.length > 0) {
        merged.add(trimmed);
      }
    }
  }
  return Array.from(merged);
}

const jobSchema = z.object({
  name: z
    .string({
      required_error: "O nome do job (job.name) é obrigatório.",
      invalid_type_error: "O nome do job (job.name) deve ser uma string.",
    })
    .min(3, "O nome do job (job.name) deve ter no mínimo 3 caracteres.")
    .max(40, "O nome do job (job.name) deve ter no máximo 40 caracteres.")
    .regex(
      /^[a-z0-9-]+$/,
      "O nome do job (job.name) deve ser um slug válido contendo apenas letras minúsculas, números e hífens ([a-z0-9-]).",
    ),
  description: z
    .string({
      invalid_type_error: "A descrição do job (job.description) deve ser uma string.",
    })
    .optional(),
  goals: z
    .array(
      z
        .string({
          invalid_type_error: "Cada objetivo em job.goals deve ser uma string.",
        })
        .min(1, "Objetivos em job.goals não podem ser vazios."),
      {
        invalid_type_error: "job.goals deve ser uma lista de strings.",
      },
    )
    .default([]),
});

const targetSchema = z.object({
  url: z
    .string({
      invalid_type_error: "target.url deve ser uma URL válida em formato string.",
    })
    .refine(isValidHttpOrHttpsUrl, {
      message: "target.url deve ser uma URL válida com protocolo https:// (ou http://localhost).",
    })
    .optional(),
  type: z
    .enum(TARGET_TYPES, {
      errorMap: () => ({
        message: `target.type deve ser um dos seguintes valores: ${TARGET_TYPES.join(", ")}.`,
      }),
    })
    .default("web-unknown"),
  allowedOrigins: z
    .array(
      z
        .string({
          invalid_type_error: "Cada item de target.allowedOrigins deve ser uma string.",
        })
        .refine((val) => normalizeOrigin(val) !== null, {
          message: "Cada item de target.allowedOrigins deve ser uma URL/origin http(s) válida.",
        })
        .transform((val) => normalizeOrigin(val) ?? val),
      {
        invalid_type_error: "target.allowedOrigins deve ser uma lista de origins.",
      },
    )
    .optional(),
  docsUrls: z
    .array(
      z
        .string({
          invalid_type_error: "Cada item de target.docsUrls deve ser uma string.",
        })
        .refine(isValidHttpOrHttpsUrl, {
          message: "Cada item de target.docsUrls deve ser uma URL http(s) válida.",
        }),
      {
        invalid_type_error: "target.docsUrls deve ser uma lista de URLs.",
      },
    )
    .default([]),
  repo: z
    .string({
      invalid_type_error: "target.repo deve ser uma string.",
    })
    .min(1, "target.repo não pode ser vazio.")
    .optional(),
});

const authorizationSchema = z.object({
  basis: z
    .string({
      required_error: "A justificativa de autorização (authorization.basis) é obrigatória.",
      invalid_type_error: "authorization.basis deve ser uma string.",
    })
    .trim()
    .min(10, "authorization.basis deve ter no mínimo 10 caracteres."),
  tosReviewed: z.boolean({
    required_error: "authorization.tosReviewed é obrigatório.",
    invalid_type_error: "authorization.tosReviewed deve ser um booleano.",
  }),
  evidence: z
    .string({
      invalid_type_error: "authorization.evidence deve ser uma string ou null.",
    })
    .nullable()
    .optional()
    .default(null),
});

const methodsSchema = z
  .object({
    behavioralUi: z.boolean().default(true),
    networkHar: z.boolean().default(true),
    publicDocs: z.boolean().default(true),
    staticBundles: z.boolean().default(true),
    binaryAnalysis: z.boolean().default(false),
    sourceRepo: z.boolean().default(false),
    authenticatedSession: z.boolean().default(false),
  })
  .default({});

const limitsSchema = z
  .object({
    maxPages: z
      .number({ invalid_type_error: "limits.maxPages deve ser um número inteiro." })
      .int("limits.maxPages deve ser um número inteiro.")
      .min(1, "limits.maxPages deve estar entre 1 e 2000.")
      .max(2000, "limits.maxPages deve estar entre 1 e 2000.")
      .default(150),
    maxDepth: z
      .number({ invalid_type_error: "limits.maxDepth deve ser um número inteiro." })
      .int("limits.maxDepth deve ser um número inteiro.")
      .min(1, "limits.maxDepth deve estar entre 1 e 20.")
      .max(20, "limits.maxDepth deve estar entre 1 e 20.")
      .default(6),
    maxDurationMin: z
      .number({ invalid_type_error: "limits.maxDurationMin deve ser um número inteiro." })
      .int("limits.maxDurationMin deve ser um número inteiro.")
      .min(5, "limits.maxDurationMin deve estar entre 5 e 480 minutos.")
      .max(480, "limits.maxDurationMin deve estar entre 5 e 480 minutos.")
      .default(60),
    rateLimitRps: z
      .number({ invalid_type_error: "limits.rateLimitRps deve ser um número." })
      .min(0.1, "limits.rateLimitRps deve estar entre 0.1 e 5 requisições por segundo.")
      .max(5, "limits.rateLimitRps deve estar entre 0.1 e 5 requisições por segundo.")
      .default(1),
    maxAccounts: z
      .number({ invalid_type_error: "limits.maxAccounts deve ser um número inteiro." })
      .int("limits.maxAccounts deve ser um número inteiro.")
      .min(0, "limits.maxAccounts deve ser 0 ou 1 (máximo 1 conta por política).")
      .max(1, "limits.maxAccounts deve ser 0 ou 1 (máximo 1 conta por política).")
      .default(0),
    forbiddenPaths: z
      .array(
        z
          .string({ invalid_type_error: "Cada item em limits.forbiddenPaths deve ser uma string." })
          .min(1, "Padrões em limits.forbiddenPaths não podem ser vazios."),
      )
      .default([...DEFAULT_FORBIDDEN_PATHS])
      .transform((paths) => mergeForbiddenPaths(paths)),
    destructiveActions: z.boolean().default(false),
    formSubmission: z
      .enum(FORM_SUBMISSION_MODES, {
        errorMap: () => ({
          message: `limits.formSubmission deve ser um dos valores: ${FORM_SUBMISSION_MODES.join(", ")}.`,
        }),
      })
      .default("validation-only"),
    respectRobotsTxt: z.boolean().default(true),
  })
  .default({});

const accountsSchema = z
  .object({
    strategy: z
      .enum(ACCOUNT_STRATEGIES, {
        errorMap: () => ({
          message: `accounts.strategy deve ser um dos valores: ${ACCOUNT_STRATEGIES.join(", ")}.`,
        }),
      })
      .default("none"),
    emailAlias: z.string().min(1, "accounts.emailAlias não pode ser vazio.").optional(),
    credentialRef: z.string().min(1, "accounts.credentialRef não pode ser vazio.").optional(),
    identity: z
      .enum(ACCOUNT_IDENTITIES, {
        errorMap: () => ({
          message:
            'accounts.identity deve ser "owner" (identidade real do dono; não há suporte a identidades falsas).',
        }),
      })
      .default("owner"),
  })
  .default({});

const humanInTheLoopSchema = z
  .object({
    captcha: z
      .enum(CHALLENGE_ACTIONS, {
        errorMap: () => ({
          message:
            'humanInTheLoop.captcha deve ser "handoff" ou "abort" (resolução automática é proibida).',
        }),
      })
      .default("handoff"),
    smsOtp: z
      .enum(CHALLENGE_ACTIONS, {
        errorMap: () => ({
          message:
            'humanInTheLoop.smsOtp deve ser "handoff" ou "abort" (resolução automática é proibida).',
        }),
      })
      .default("handoff"),
    payments: z
      .enum(PAYMENT_ACTIONS, {
        errorMap: () => ({
          message:
            'humanInTheLoop.payments deve ser "require-approval" ou "abort" (pagamento automático é proibido).',
        }),
      })
      .default("abort"),
    handoffTimeoutMin: z
      .number({
        invalid_type_error: "humanInTheLoop.handoffTimeoutMin deve ser um número inteiro.",
      })
      .int("humanInTheLoop.handoffTimeoutMin deve ser um número inteiro.")
      .min(1, "humanInTheLoop.handoffTimeoutMin deve ser no mínimo 1 minuto.")
      .max(1440, "humanInTheLoop.handoffTimeoutMin deve ser no máximo 1440 minutos.")
      .default(30),
  })
  .default({});

const cleanupSchema = z
  .object({
    deleteAccountAtEnd: z.boolean().default(true),
    purgeHarSecrets: z.boolean().default(true),
    retainDays: z
      .number({ invalid_type_error: "cleanup.retainDays deve ser um número inteiro." })
      .int("cleanup.retainDays deve ser um número inteiro.")
      .min(1, "cleanup.retainDays deve ser de no mínimo 1 dia.")
      .max(365, "cleanup.retainDays deve ser de no máximo 365 dias.")
      .default(90),
  })
  .default({});

const viewportTupleSchema = z.tuple(
  [
    z
      .number({ invalid_type_error: "Largura do viewport deve ser um número inteiro positivo." })
      .int()
      .min(200, "Largura do viewport deve ser >= 200px.")
      .max(7680, "Largura do viewport deve ser <= 7680px."),
    z
      .number({ invalid_type_error: "Altura do viewport deve ser um número inteiro positivo." })
      .int()
      .min(200, "Altura do viewport deve ser >= 200px.")
      .max(4320, "Altura do viewport deve ser <= 4320px."),
  ],
  {
    invalid_type_error: "Cada viewport em report.viewports deve ser uma tupla [largura, altura].",
  },
);

const reportSchema = z
  .object({
    language: z.string().min(2).default("pt-BR"),
    viewports: z
      .array(viewportTupleSchema)
      .min(1, "report.viewports deve conter pelo menos um viewport.")
      .default(() => DEFAULT_REPORT_VIEWPORTS.map(([w, h]) => [w, h] as [number, number])),
    include: z
      .array(
        z.enum(REPORT_SECTIONS, {
          errorMap: () => ({
            message: `Seção de relatório inválida em report.include. Valores aceitos: ${REPORT_SECTIONS.join(", ")}.`,
          }),
        }),
      )
      .min(1, "report.include deve conter pelo menos uma seção.")
      .default(() => [...REPORT_SECTIONS]),
  })
  .default({});

const rawManifestSchema = z
  .object({
    version: z.literal(1, {
      errorMap: () => ({
        message: "A versão do manifesto (version) deve ser exatamente 1.",
      }),
    }),
    job: jobSchema,
    target: targetSchema,
    ownership: z.enum(OWNERSHIP_TYPES, {
      errorMap: () => ({
        message: `ownership deve ser um dos valores: ${OWNERSHIP_TYPES.join(", ")}.`,
      }),
    }),
    authorization: authorizationSchema,
    methods: methodsSchema,
    limits: limitsSchema,
    accounts: accountsSchema,
    humanInTheLoop: humanInTheLoopSchema,
    cleanup: cleanupSchema,
    report: reportSchema,
  })
  .superRefine((data, ctx) => {
    // Validação de target.url vs target.type e protocolo (https obrigatório exceto localhost quando own)
    if (data.target.type !== "repo" && !data.target.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "url"],
        message: 'target.url é obrigatório quando target.type não é "repo".',
      });
    }

    if (
      data.target.type === "repo" &&
      (!data.target.repo || data.target.repo.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "repo"],
        message: 'target.repo é obrigatório quando target.type é "repo".',
      });
    }

    if (data.methods.sourceRepo && (!data.target.repo || data.target.repo.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "repo"],
        message: "target.repo é obrigatório quando methods.sourceRepo é true.",
      });
    }

    if (data.target.url) {
      const httpsOk = isHttpsUrl(data.target.url);
      const localHttpOk = data.ownership === "own" && isLocalhostHttpUrl(data.target.url);

      if (!httpsOk && !localHttpOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target", "url"],
          message:
            'target.url deve usar protocolo https:// para alvos remotos ("third-party" ou "client-authorized"). Protocolo http:// só é permitido para localhost ou 127.0.0.1 quando ownership é "own".',
        });
      }
    }

    // Regra cruzada #1: ownership == third-party exige authorization.tosReviewed == true
    if (data.ownership === "third-party" && data.authorization.tosReviewed !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorization", "tosReviewed"],
        message:
          'Quando ownership é "third-party", authorization.tosReviewed deve ser obrigatoriamente true (confirmação de revisão dos Termos de Uso).',
      });
    }

    // Regra cruzada #2: methods.binaryAnalysis == true exige ownership == own
    if (data.methods.binaryAnalysis === true && data.ownership !== "own") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["methods", "binaryAnalysis"],
        message:
          'O método methods.binaryAnalysis só é permitido quando ownership é "own" (proibido em alvos de terceiros ou clientes).',
      });
    }

    // Regra cruzada #3: ownership == client-authorized exige authorization.evidence não vazio
    if (
      data.ownership === "client-authorized" &&
      (!data.authorization.evidence || data.authorization.evidence.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorization", "evidence"],
        message:
          'Quando ownership é "client-authorized", authorization.evidence deve ser preenchido com a referência ao contrato ou autorização formal.',
      });
    }

    // Regra cruzada #4: methods.authenticatedSession == true exige accounts.strategy != none
    if (data.methods.authenticatedSession === true && data.accounts.strategy === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts", "strategy"],
        message:
          'Quando methods.authenticatedSession é true, accounts.strategy não pode ser "none" (use "provided" ou "signup").',
      });
    }

    // Regra cruzada #5: accounts.strategy == signup exige limits.maxAccounts == 1
    if (data.accounts.strategy === "signup" && data.limits.maxAccounts !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limits", "maxAccounts"],
        message: 'Quando accounts.strategy é "signup", limits.maxAccounts deve ser exatamente 1.',
      });
    }

    // Regra cruzada #6: target.url deve estar em target.allowedOrigins
    if (data.target.url) {
      const targetOrigin = normalizeOrigin(data.target.url);
      const effectiveAllowedOrigins =
        data.target.allowedOrigins ?? (targetOrigin ? [targetOrigin] : []);

      if (targetOrigin && !effectiveAllowedOrigins.includes(targetOrigin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target", "allowedOrigins"],
          message: `A origem de target.url (${targetOrigin}) deve estar contida em target.allowedOrigins.`,
        });
      }
    }

    // Regra cruzada #7: forbiddenPaths padrão sempre é mesclado (impossível remover **/logout)
    for (const requiredPattern of DEFAULT_FORBIDDEN_PATHS) {
      if (!data.limits.forbiddenPaths.includes(requiredPattern)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["limits", "forbiddenPaths"],
          message: `O padrão de segurança obrigatório "${requiredPattern}" não pode ser removido de limits.forbiddenPaths.`,
        });
      }
    }
  });

export const manifestSchema = rawManifestSchema.transform((data) => {
  const targetOrigin = data.target.url ? normalizeOrigin(data.target.url) : null;
  const allowedOrigins =
    data.target.allowedOrigins ?? (targetOrigin !== null ? [targetOrigin] : []);

  return {
    ...data,
    target: {
      type: data.target.type,
      ...(data.target.url !== undefined ? { url: data.target.url } : {}),
      allowedOrigins,
      docsUrls: data.target.docsUrls,
      ...(data.target.repo !== undefined ? { repo: data.target.repo } : {}),
    },
    limits: {
      ...data.limits,
      forbiddenPaths: mergeForbiddenPaths(data.limits.forbiddenPaths),
    },
  };
});

export type ManifestInput = z.input<typeof manifestSchema>;
export type Manifest = z.output<typeof manifestSchema>;

export interface LoadManifestOptions {
  /**
   * Se true (default: false), exige que `accounts.strategy === "none"`,
   * lançando `ManifestError` caso estratégias da Fase 2 (`provided` ou `signup`)
   * sejam acionadas em execução da Fase 1.
   */
  enforcePhase1Execution?: boolean | undefined;
}

function buildManifestError(
  issues: readonly ManifestIssueDetail[],
  cause?: unknown,
): ManifestError {
  const formatted = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return new ManifestError(`Manifesto inválido: ${formatted}`, {
    issues,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isProbablyYamlContent(pathOrYaml: string): boolean {
  if (pathOrYaml.includes("\n") || pathOrYaml.includes("\r")) {
    return true;
  }
  const trimmed = pathOrYaml.trimStart();
  return trimmed.startsWith("version:") || trimmed.startsWith("{") || trimmed.startsWith("---");
}

async function resolveYamlString(pathOrYaml: string): Promise<string> {
  if (isProbablyYamlContent(pathOrYaml)) {
    return pathOrYaml;
  }
  try {
    return await readFile(pathOrYaml, "utf8");
  } catch (err) {
    const message =
      err instanceof Error
        ? `Não foi possível ler o arquivo de manifesto "${pathOrYaml}": ${err.message}`
        : `Não foi possível ler o arquivo de manifesto "${pathOrYaml}".`;
    throw buildManifestError([{ path: "manifest", message }], err);
  }
}

export function parseManifestObject(rawObject: unknown, options?: LoadManifestOptions): Manifest {
  const parsed = manifestSchema.safeParse(rawObject);
  if (!parsed.success) {
    const issues: ManifestIssueDetail[] = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "manifest",
      message: issue.message,
    }));
    throw buildManifestError(issues);
  }

  const manifest = parsed.data;
  if (options?.enforcePhase1Execution && manifest.accounts.strategy !== "none") {
    throw buildManifestError([
      {
        path: "accounts.strategy",
        message: `A estratégia de conta "${manifest.accounts.strategy}" só é executável a partir da Fase 2. Na Fase 1, use accounts.strategy: "none".`,
      },
    ]);
  }

  return manifest;
}

export function parseManifestYaml(yamlContent: string, options?: LoadManifestOptions): Manifest {
  if (yamlContent.trim().length === 0) {
    throw buildManifestError([
      {
        path: "manifest",
        message: "O conteúdo do manifesto YAML está vazio.",
      },
    ]);
  }

  const doc = parseDocument(yamlContent, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const issues: ManifestIssueDetail[] = doc.errors.map((err) => ({
      path: "yaml",
      message: `Erro de sintaxe YAML: ${err.message}`,
    }));
    throw buildManifestError(issues);
  }

  const rawObject: unknown = doc.toJS();
  if (typeof rawObject !== "object" || rawObject === null || Array.isArray(rawObject)) {
    throw buildManifestError([
      {
        path: "manifest",
        message: "O manifesto YAML deve ser um objeto mapeado na raiz.",
      },
    ]);
  }

  return parseManifestObject(rawObject, options);
}

export async function loadManifest(
  pathOrYaml: string,
  options?: LoadManifestOptions,
): Promise<Manifest> {
  const yamlContent = await resolveYamlString(pathOrYaml);
  return parseManifestYaml(yamlContent, options);
}
