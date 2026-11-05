export type ProjectStatus = "draft" | "active" | "archived";
export type PlanTier = "free" | "pro";

export interface DemoProject {
  id: string;
  name: string;
  budget: number;
  targetDate: string;
  status: ProjectStatus;
  createdAt: string;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface ValidationFailure {
  ok: false;
  status: 400 | 409 | 422;
  code: string;
  message: string;
  issues: ValidationIssue[];
}

export interface ValidationSuccess<T> {
  ok: true;
  status: 200 | 201;
  data: T;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface PaginatedProjects {
  items: DemoProject[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    createdProjectsCount: number;
  };
}

export interface DemoStats {
  createdProjectsCount: number;
  deletedProjectsCount: number;
  adminVisitsCount: number;
  validationFailuresCount: number;
  totalProjects: number;
  nonArchivedProjects: number;
  maxFreeProjects: number;
}

export interface DemoStoreOptions {
  defaultPlan?: PlanTier;
  maxFreeProjects?: number;
  defaultPageSize?: number;
  now?: () => Date;
}

export const VALIDATION_MESSAGES = {
  NAME_REQUIRED: "O nome do projeto é obrigatório e deve ter entre 3 e 60 caracteres.",
  NAME_LENGTH_INVALID: "O nome do projeto deve ter entre 3 e 60 caracteres.",
  BUDGET_REQUIRED: "O orçamento é obrigatório e deve ser maior ou igual a 0.",
  BUDGET_MIN_ZERO: "O orçamento deve ser um valor numérico maior ou igual a 0.",
  TARGET_DATE_REQUIRED: "A data de entrega é obrigatória e deve ser uma data futura.",
  TARGET_DATE_MUST_BE_FUTURE: "A data de entrega deve ser uma data futura.",
  PLAN_LIMIT_REACHED:
    "Limite do plano Free atingido (máximo de 3 projetos ativos/rascunho). Faça upgrade para o plano Pro.",
  INVALID_STATUS_TRANSITION:
    "Transição de status inválida. Projetos arquivados são somente leitura.",
  DELETE_ONLY_DRAFT: "Apenas projetos em rascunho (draft) podem ser excluídos.",
  LOGIN_EMAIL_INVALID: "Informe um endereço de e-mail válido.",
  LOGIN_PASSWORD_SHORT: "A senha deve ter pelo menos 8 caracteres.",
} as const;

const INITIAL_PROJECTS: readonly DemoProject[] = [
  {
    id: "proj-1",
    name: "Portal do Cliente",
    budget: 15000,
    targetDate: "2099-03-15",
    status: "draft",
    createdAt: "2026-01-10T10:00:00.000Z",
  },
  {
    id: "proj-2",
    name: "Motor de Faturamento",
    budget: 42000,
    targetDate: "2099-06-30",
    status: "active",
    createdAt: "2026-01-12T14:30:00.000Z",
  },
  {
    id: "proj-3",
    name: "Legado Monolítico",
    budget: 0,
    targetDate: "2025-12-01",
    status: "archived",
    createdAt: "2025-05-01T08:00:00.000Z",
  },
];

export interface DemoStore {
  readonly maxFreeProjects: number;
  readonly defaultPageSize: number;
  getPlan(override?: string | null): PlanTier;
  listProjects(page?: number, pageSize?: number): PaginatedProjects;
  getProject(id: string): DemoProject | undefined;
  createProject(input: unknown, planOverride?: string | null): ValidationResult<DemoProject>;
  transitionStatus(
    id: string,
    nextStatus: ProjectStatus,
  ): ValidationResult<DemoProject> | { ok: false; status: 404; code: string; message: string };
  deleteProject(
    id: string,
  ):
    | ValidationResult<{ deletedId: string }>
    | { ok: false; status: 404; code: string; message: string };
  recordAdminVisit(): number;
  getCreatedProjectsCount(): number;
  getStats(): DemoStats;
  reset(): void;
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createDemoStore(options: DemoStoreOptions = {}): DemoStore {
  const defaultPlan: PlanTier = options.defaultPlan ?? "free";
  const maxFreeProjects = options.maxFreeProjects ?? 3;
  const defaultPageSize = options.defaultPageSize ?? 2;
  const getNow = options.now ?? (() => new Date());

  let projects: DemoProject[] = INITIAL_PROJECTS.map((p) => ({ ...p }));
  let createdProjectsCount = 0;
  let deletedProjectsCount = 0;
  let adminVisitsCount = 0;
  let validationFailuresCount = 0;
  let sequence = INITIAL_PROJECTS.length + 1;

  function getPlan(override?: string | null): PlanTier {
    if (override === "pro") return "pro";
    if (override === "free") return "free";
    return defaultPlan;
  }

  function countNonArchived(): number {
    return projects.filter((p) => p.status !== "archived").length;
  }

  return {
    maxFreeProjects,
    defaultPageSize,
    getPlan,

    listProjects(page = 1, pageSize = defaultPageSize): PaginatedProjects {
      const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
      const safePageSize =
        Number.isFinite(pageSize) && pageSize >= 1 && pageSize <= 50
          ? Math.floor(pageSize)
          : defaultPageSize;
      const total = projects.length;
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const start = (safePage - 1) * safePageSize;
      const items = projects.slice(start, start + safePageSize);
      return {
        items,
        meta: {
          page: safePage,
          pageSize: safePageSize,
          total,
          totalPages,
          hasNextPage: safePage < totalPages,
          createdProjectsCount,
        },
      };
    },

    getProject(id: string): DemoProject | undefined {
      return projects.find((p) => p.id === id);
    },

    createProject(input: unknown, planOverride?: string | null): ValidationResult<DemoProject> {
      if (typeof input !== "object" || input === null) {
        validationFailuresCount += 1;
        return {
          ok: false,
          status: 400,
          code: "INVALID_PAYLOAD",
          message: "Payload inválido.",
          issues: [{ field: "body", code: "INVALID_PAYLOAD", message: "Payload inválido." }],
        };
      }

      const record = input as Record<string, unknown>;
      const issues: ValidationIssue[] = [];

      // 1. Validate name (required, 3-60 chars)
      const rawName = typeof record.name === "string" ? record.name.trim() : "";
      if (rawName.length === 0) {
        issues.push({
          field: "name",
          code: "NAME_REQUIRED",
          message: VALIDATION_MESSAGES.NAME_REQUIRED,
        });
      } else if (rawName.length < 3 || rawName.length > 60) {
        issues.push({
          field: "name",
          code: "NAME_LENGTH_INVALID",
          message: VALIDATION_MESSAGES.NAME_LENGTH_INVALID,
        });
      }

      // 2. Validate budget (required, numeric >= 0)
      const rawBudget = record.budget;
      const parsedBudget =
        typeof rawBudget === "number"
          ? rawBudget
          : typeof rawBudget === "string" && rawBudget.trim() !== ""
            ? Number(rawBudget)
            : Number.NaN;

      if (rawBudget === undefined || rawBudget === null || rawBudget === "") {
        issues.push({
          field: "budget",
          code: "BUDGET_REQUIRED",
          message: VALIDATION_MESSAGES.BUDGET_REQUIRED,
        });
      } else if (!Number.isFinite(parsedBudget) || parsedBudget < 0) {
        issues.push({
          field: "budget",
          code: "BUDGET_MIN_ZERO",
          message: VALIDATION_MESSAGES.BUDGET_MIN_ZERO,
        });
      }

      // 3. Validate targetDate (required, future YYYY-MM-DD date)
      const rawDate = typeof record.targetDate === "string" ? record.targetDate.trim() : "";
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (rawDate.length === 0) {
        issues.push({
          field: "targetDate",
          code: "TARGET_DATE_REQUIRED",
          message: VALIDATION_MESSAGES.TARGET_DATE_REQUIRED,
        });
      } else if (!dateRegex.test(rawDate) || Number.isNaN(Date.parse(`${rawDate}T00:00:00.000Z`))) {
        issues.push({
          field: "targetDate",
          code: "TARGET_DATE_MUST_BE_FUTURE",
          message: VALIDATION_MESSAGES.TARGET_DATE_MUST_BE_FUTURE,
        });
      } else {
        const todayStr = toUtcDateString(getNow());
        if (rawDate <= todayStr) {
          issues.push({
            field: "targetDate",
            code: "TARGET_DATE_MUST_BE_FUTURE",
            message: VALIDATION_MESSAGES.TARGET_DATE_MUST_BE_FUTURE,
          });
        }
      }

      if (issues.length > 0) {
        validationFailuresCount += 1;
        const firstIssue = issues[0] ?? {
          field: "form",
          code: "VALIDATION_ERROR",
          message: "Erro de validação.",
        };
        const hasMissingRequired = issues.some((i) => i.code.endsWith("_REQUIRED"));
        return {
          ok: false,
          status: hasMissingRequired ? 400 : 422,
          code: firstIssue.code,
          message: firstIssue.message,
          issues,
        };
      }

      // 4. Check plan limit (Free: max 3 non-archived projects; Pro: unlimited)
      const effectivePlan = getPlan(
        planOverride ?? (typeof record.plan === "string" ? record.plan : null),
      );
      if (effectivePlan === "free" && countNonArchived() >= maxFreeProjects) {
        validationFailuresCount += 1;
        return {
          ok: false,
          status: 422,
          code: "PLAN_LIMIT_REACHED",
          message: VALIDATION_MESSAGES.PLAN_LIMIT_REACHED,
          issues: [
            {
              field: "plan",
              code: "PLAN_LIMIT_REACHED",
              message: VALIDATION_MESSAGES.PLAN_LIMIT_REACHED,
            },
          ],
        };
      }

      const created: DemoProject = {
        id: `proj-${sequence}`,
        name: rawName,
        budget: parsedBudget,
        targetDate: rawDate,
        status: "draft",
        createdAt: getNow().toISOString(),
      };
      sequence += 1;
      createdProjectsCount += 1;
      projects.unshift(created);

      return {
        ok: true,
        status: 201,
        data: created,
      };
    },

    transitionStatus(id: string, nextStatus: ProjectStatus) {
      const project = projects.find((p) => p.id === id);
      if (!project) {
        return {
          ok: false as const,
          status: 404 as const,
          code: "PROJECT_NOT_FOUND",
          message: `Projeto '${id}' não encontrado.`,
        };
      }

      const validTransition =
        (project.status === "draft" && (nextStatus === "active" || nextStatus === "archived")) ||
        (project.status === "active" && nextStatus === "archived");

      if (!validTransition) {
        return {
          ok: false as const,
          status: 409 as const,
          code: "INVALID_STATUS_TRANSITION",
          message: VALIDATION_MESSAGES.INVALID_STATUS_TRANSITION,
          issues: [
            {
              field: "status",
              code: "INVALID_STATUS_TRANSITION",
              message: VALIDATION_MESSAGES.INVALID_STATUS_TRANSITION,
            },
          ],
        };
      }

      project.status = nextStatus;
      return {
        ok: true as const,
        status: 200 as const,
        data: { ...project },
      };
    },

    deleteProject(id: string) {
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        return {
          ok: false as const,
          status: 404 as const,
          code: "PROJECT_NOT_FOUND",
          message: `Projeto '${id}' não encontrado.`,
        };
      }

      const project = projects[idx];
      if (!project || project.status !== "draft") {
        return {
          ok: false as const,
          status: 409 as const,
          code: "DELETE_ONLY_DRAFT",
          message: VALIDATION_MESSAGES.DELETE_ONLY_DRAFT,
          issues: [
            {
              field: "status",
              code: "DELETE_ONLY_DRAFT",
              message: VALIDATION_MESSAGES.DELETE_ONLY_DRAFT,
            },
          ],
        };
      }

      projects.splice(idx, 1);
      deletedProjectsCount += 1;
      return {
        ok: true as const,
        status: 200 as const,
        data: { deletedId: id },
      };
    },

    recordAdminVisit(): number {
      adminVisitsCount += 1;
      return adminVisitsCount;
    },

    getCreatedProjectsCount(): number {
      return createdProjectsCount;
    },

    getStats(): DemoStats {
      return {
        createdProjectsCount,
        deletedProjectsCount,
        adminVisitsCount,
        validationFailuresCount,
        totalProjects: projects.length,
        nonArchivedProjects: countNonArchived(),
        maxFreeProjects,
      };
    },

    reset(): void {
      projects = INITIAL_PROJECTS.map((p) => ({ ...p }));
      createdProjectsCount = 0;
      deletedProjectsCount = 0;
      adminVisitsCount = 0;
      validationFailuresCount = 0;
      sequence = INITIAL_PROJECTS.length + 1;
    },
  };
}
