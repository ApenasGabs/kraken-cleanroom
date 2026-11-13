import {
  type Evidence,
  type FormFieldOption,
  type FormFieldSchema,
  type FormProbeEvidenceData,
  type FormProbeInput,
  type FormProbeResult,
  type FormProbeType,
  type FormSchema,
  type FormSubmitButton,
  type PhaseContext,
  type ScopeGuard,
  canonicalJson,
  computeSha256,
} from "@cleanroom/core";
import type { Page as PlaywrightPage } from "playwright-core";
import { type HtmlElementNode, decodeHtmlEntitiesLight, parseHtmlTree } from "./crawler.js";

// ---------------------------------------------------------------------------
// HTML Label and Field Extraction Helpers
// ---------------------------------------------------------------------------

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractNodeText(node: HtmlElementNode | string): string {
  if (typeof node === "string") {
    return node;
  }
  const parts: string[] = [];
  for (const child of node.children) {
    parts.push(extractNodeText(child));
  }
  return cleanText(parts.join(" "));
}

interface FormDomContext {
  labelsByFor: Map<string, string>;
  labelsByElementNode: Map<HtmlElementNode, string>;
}

function collectLabels(root: HtmlElementNode): FormDomContext {
  const labelsByFor = new Map<string, string>();
  const labelsByElementNode = new Map<HtmlElementNode, string>();

  const walk = (node: HtmlElementNode | string) => {
    if (typeof node === "string") return;

    if (node.tag === "label") {
      const forAttr = node.attrs.for?.trim();
      const labelText = extractNodeText(node);
      if (forAttr && labelText) {
        labelsByFor.set(forAttr, labelText);
      }
      // Se a label envolve diretamente um input/select/textarea
      for (const child of node.children) {
        if (typeof child !== "string") {
          if (child.tag === "input" || child.tag === "select" || child.tag === "textarea") {
            labelsByElementNode.set(child, labelText);
          }
        }
      }
    }

    for (const child of node.children) {
      if (typeof child !== "string") {
        walk(child);
      }
    }
  };

  walk(root);
  return { labelsByFor, labelsByElementNode };
}

function resolveFieldLabel(node: HtmlElementNode, domCtx: FormDomContext): string | undefined {
  const id = node.attrs.id?.trim();
  if (id && domCtx.labelsByFor.has(id)) {
    return domCtx.labelsByFor.get(id);
  }
  if (domCtx.labelsByElementNode.has(node)) {
    return domCtx.labelsByElementNode.get(node);
  }
  if (node.attrs["aria-label"]) {
    return cleanText(node.attrs["aria-label"]);
  }
  if (node.attrs.placeholder) {
    return cleanText(node.attrs.placeholder);
  }
  if (node.attrs.title) {
    return cleanText(node.attrs.title);
  }
  return node.attrs.name?.trim();
}

function parseSelectOptions(selectNode: HtmlElementNode): FormFieldOption[] {
  const options: FormFieldOption[] = [];
  for (const child of selectNode.children) {
    if (typeof child !== "string" && child.tag === "option") {
      const value = child.attrs.value ?? extractNodeText(child);
      const label = extractNodeText(child) || value;
      const selected = "selected" in child.attrs;
      options.push({ value, label, ...(selected ? { selected: true } : {}) });
    }
  }
  return options;
}

function deriveFormId(
  formNode: HtmlElementNode,
  actionUrl: string,
  method: string,
  index: number,
): string {
  if (formNode.attrs.id?.trim()) {
    return formNode.attrs.id.trim();
  }
  if (formNode.attrs.name?.trim()) {
    return formNode.attrs.name.trim();
  }
  const hash = computeSha256(`${actionUrl}|${method}|${index}`).slice(0, 10);
  return `form-${hash}`;
}

// ---------------------------------------------------------------------------
// Form Schema Extraction (docs/04 Fase 2, docs/05 §2)
// ---------------------------------------------------------------------------

/**
 * Extrai schema estruturado de todos os formulários presentes em uma página HTML.
 */
export function extractFormSchemasFromHtml(
  html: string,
  pageUrl: string,
  stateId?: string,
): FormSchema[] {
  const root = parseHtmlTree(html);
  const domCtx = collectLabels(root);
  const forms: FormSchema[] = [];
  let formCounter = 0;

  const findForms = (node: HtmlElementNode | string) => {
    if (typeof node === "string") return;

    if (node.tag === "form") {
      formCounter += 1;
      const rawAction = node.attrs.action?.trim();
      let resolvedAction = pageUrl;
      if (rawAction) {
        try {
          resolvedAction = new URL(rawAction, pageUrl).toString();
        } catch {
          resolvedAction = rawAction;
        }
      }

      const method = (node.attrs.method ?? "get").toLowerCase();
      const formId = deriveFormId(node, resolvedAction, method, formCounter);
      const selector = node.attrs.id
        ? `form#${node.attrs.id}`
        : rawAction
          ? `form[action="${rawAction.replaceAll('"', '\\"')}"]`
          : `form:nth-of-type(${formCounter})`;

      const fields: FormFieldSchema[] = [];
      let submitButton: FormSubmitButton | undefined;

      const walkFormDescendants = (desc: HtmlElementNode | string) => {
        if (typeof desc === "string") return;

        // Detecta botão de submissão
        if (desc.tag === "button" || (desc.tag === "input" && desc.attrs.type === "submit")) {
          const type = (desc.attrs.type ?? (desc.tag === "button" ? "submit" : "")).toLowerCase();
          if (type === "submit" || (desc.tag === "button" && !desc.attrs.type)) {
            const label = extractNodeText(desc) || desc.attrs.value || "Enviar";
            const btnSelector = desc.attrs.id
              ? `button#${desc.attrs.id}`
              : desc.attrs.type === "submit"
                ? `${selector} button[type="submit"], ${selector} input[type="submit"]`
                : `${selector} button`;
            if (!submitButton) {
              submitButton = {
                label,
                selector: btnSelector,
                type: "submit",
              };
            }
          }
        }

        // Detecta campos interativos
        if (desc.tag === "input" || desc.tag === "textarea" || desc.tag === "select") {
          const rawType = (
            desc.attrs.type ??
            (desc.tag === "textarea" ? "textarea" : desc.tag === "select" ? "select" : "text")
          ).toLowerCase();
          // Ignora botões tratados como inputs
          if (
            rawType !== "submit" &&
            rawType !== "button" &&
            rawType !== "reset" &&
            rawType !== "image"
          ) {
            const name =
              desc.attrs.name?.trim() || desc.attrs.id?.trim() || `field_${fields.length + 1}`;
            const label = resolveFieldLabel(desc, domCtx);
            const required =
              "required" in desc.attrs ||
              (desc.attrs["aria-required"] ?? "").toLowerCase() === "true";
            const pattern = desc.attrs.pattern;

            let min: string | number | undefined;
            if (desc.attrs.min !== undefined && desc.attrs.min !== "") {
              const parsedMin = Number(desc.attrs.min);
              min = Number.isFinite(parsedMin) ? parsedMin : desc.attrs.min;
            }

            let max: string | number | undefined;
            if (desc.attrs.max !== undefined && desc.attrs.max !== "") {
              const parsedMax = Number(desc.attrs.max);
              max = Number.isFinite(parsedMax) ? parsedMax : desc.attrs.max;
            }

            let step: string | number | undefined;
            if (desc.attrs.step !== undefined && desc.attrs.step !== "") {
              const parsedStep = Number(desc.attrs.step);
              step = Number.isFinite(parsedStep) ? parsedStep : desc.attrs.step;
            }

            let minLength: number | undefined;
            if (desc.attrs.minlength !== undefined && desc.attrs.minlength !== "") {
              const parsed = Number.parseInt(desc.attrs.minlength, 10);
              if (Number.isFinite(parsed) && parsed >= 0) minLength = parsed;
            }

            let maxLength: number | undefined;
            if (desc.attrs.maxlength !== undefined && desc.attrs.maxlength !== "") {
              const parsed = Number.parseInt(desc.attrs.maxlength, 10);
              if (Number.isFinite(parsed) && parsed >= 0) maxLength = parsed;
            }

            const placeholder = desc.attrs.placeholder;
            const defaultValue =
              desc.attrs.value ?? (desc.tag === "textarea" ? extractNodeText(desc) : undefined);

            const fieldSchema: FormFieldSchema = {
              name,
              type: rawType,
              ...(label ? { label } : {}),
              ...(required ? { required: true } : {}),
              ...(pattern ? { pattern } : {}),
              ...(min !== undefined ? { min } : {}),
              ...(max !== undefined ? { max } : {}),
              ...(step !== undefined ? { step } : {}),
              ...(minLength !== undefined ? { minLength } : {}),
              ...(maxLength !== undefined ? { maxLength } : {}),
              ...(placeholder ? { placeholder } : {}),
              ...(defaultValue !== undefined && defaultValue !== "" ? { defaultValue } : {}),
              ...(desc.tag === "select" ? { options: parseSelectOptions(desc) } : {}),
            };

            fields.push(fieldSchema);
          }
        }

        for (const child of desc.children) {
          if (typeof child !== "string") {
            walkFormDescendants(child);
          }
        }
      };

      for (const child of node.children) {
        if (typeof child !== "string") {
          walkFormDescendants(child);
        }
      }

      forms.push({
        formId,
        ...(node.attrs.name ? { name: node.attrs.name } : {}),
        action: resolvedAction,
        method,
        ...(node.attrs.enctype ? { enctype: node.attrs.enctype } : {}),
        selector,
        url: pageUrl,
        ...(stateId ? { stateId } : {}),
        fields,
        ...(submitButton ? { submitButton } : {}),
      });
    }

    for (const child of node.children) {
      if (typeof child !== "string") {
        findForms(child);
      }
    }
  };

  findForms(root);
  return forms;
}

// ---------------------------------------------------------------------------
// Baseline Valid Value and Probe Generators
// ---------------------------------------------------------------------------

/**
 * Produz um valor válido padrão para preenchimento de campos secundários
 * durante o probing de um campo específico sob teste.
 */
export function getBaselineValidValue(field: FormFieldSchema): unknown {
  if (field.defaultValue !== undefined && field.defaultValue !== "") {
    return field.defaultValue;
  }
  const type = field.type.toLowerCase();

  if (type === "number") {
    if (typeof field.min === "number") {
      return Math.max(1, field.min + 10);
    }
    return 100;
  }
  if (type === "date" || field.name.toLowerCase().includes("date")) {
    return "2099-12-31";
  }
  if (type === "email") {
    return "probe-test@cleanroom.local";
  }
  if (type === "password") {
    return "ValidPassword123!";
  }
  if (type === "checkbox") {
    return true;
  }
  if (type === "select") {
    return field.options?.[0]?.value ?? "option-1";
  }

  // Text, textarea, default
  const min = field.minLength ?? 3;
  const max = field.maxLength ?? 60;
  const base = "Projeto Valido Probing";
  const targetLen = Math.min(max, Math.max(min, 15));
  return base.slice(0, targetLen).padEnd(min, "x");
}

/**
 * Gera a bateria de testes inválidos para um formulário específico.
 * Testa cada campo um por vez com entradas inválidas conforme seu tipo e restrições.
 */
export function generateFormProbes(form: FormSchema): FormProbeInput[] {
  const probes: FormProbeInput[] = [];

  for (const field of form.fields) {
    if (field.type === "hidden") {
      continue;
    }

    // 1. Campo obrigatório vazio
    if (field.required) {
      probes.push({
        field: field.name,
        probeType: "empty_required",
        inputSummary: `valor vazio para campo obrigatório (${field.name})`,
        value: "",
      });
    }

    // 2. Comprimento menor que minLength
    if (field.minLength !== undefined && field.minLength > 0) {
      const shortLen = Math.max(1, field.minLength - 1);
      probes.push({
        field: field.name,
        probeType: "min_length",
        inputSummary: `texto menor que minLength (${shortLen} caracteres, mín ${field.minLength})`,
        value: "a".repeat(shortLen),
      });
    }

    // 3. Comprimento maior que maxLength
    if (field.maxLength !== undefined && field.maxLength > 0) {
      const longLen = field.maxLength + 1;
      probes.push({
        field: field.name,
        probeType: "max_length",
        inputSummary: `texto maior que maxLength (${longLen} caracteres, máx ${field.maxLength})`,
        value: "a".repeat(longLen),
      });
    }

    // 4. Número negativo ou menor que min
    if (
      field.type === "number" ||
      (typeof field.min === "number" && field.min >= 0) ||
      field.name.toLowerCase().includes("budget") ||
      field.name.toLowerCase().includes("orcamento")
    ) {
      const negativeVal = typeof field.min === "number" && field.min >= 0 ? field.min - 1 : -1;
      probes.push({
        field: field.name,
        probeType: "negative_number",
        inputSummary: `número negativo ou menor que mínimo (${negativeVal})`,
        value: negativeVal,
      });
    }

    // 5. Data passada
    if (
      field.type === "date" ||
      field.name.toLowerCase().includes("date") ||
      field.name.toLowerCase().includes("data")
    ) {
      probes.push({
        field: field.name,
        probeType: "past_date",
        inputSummary: "data passada (2000-01-01)",
        value: "2000-01-01",
      });
    }

    // 6. Formato de e-mail inválido
    if (field.type === "email" || field.name.toLowerCase().includes("email")) {
      probes.push({
        field: field.name,
        probeType: "invalid_format",
        inputSummary: "formato de e-mail inválido (sem @)",
        value: "usuario_invalido_sem_arroba",
      });
    }

    // 7. Violação de padrão (regex)
    if (field.pattern) {
      probes.push({
        field: field.name,
        probeType: "pattern_mismatch",
        inputSummary: `violação do padrão regex (${field.pattern})`,
        value: "___INVALID_PATTERN___",
      });
    }
  }

  return probes;
}

/**
 * Constrói o payload para envio de um probe específico, mantendo os outros
 * campos com valores válidos para isolar a validação do campo alvo.
 */
export function buildProbePayload(
  form: FormSchema,
  probe: FormProbeInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of form.fields) {
    if (f.name === probe.field) {
      payload[f.name] = probe.value;
    } else {
      payload[f.name] = getBaselineValidValue(f);
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Destructive Check & Safety Guardrails (docs/10 §1 e §2)
// ---------------------------------------------------------------------------

const DESTRUCTIVE_KEYWORDS_REGEX =
  /\b(?:excluir|deletar|remover|apagar|cancelar|delete|remove|destroy|unsubscribe|sair|logout|sign\s*out)\b/i;

/**
 * Determina se um formulário representa uma ação destrutiva que deve ser ignorada
 * quando `destructiveActions === false`.
 */
export function isDestructiveForm(form: FormSchema, guard?: ScopeGuard): boolean {
  if (guard?.isDestructive(form.action)) {
    return true;
  }
  if (DESTRUCTIVE_KEYWORDS_REGEX.test(form.action)) {
    return true;
  }
  if (form.submitButton?.label) {
    if (guard?.isDestructive(form.submitButton.label)) {
      return true;
    }
    if (DESTRUCTIVE_KEYWORDS_REGEX.test(form.submitButton.label)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Probe Execution (Browserless / Playwright & Fetch-backed)
// ---------------------------------------------------------------------------

export interface ExecuteProbeOptions {
  form: FormSchema;
  probe: FormProbeInput;
  page?: PlaywrightPage | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  guard?: ScopeGuard | undefined;
}

/**
 * Extrai texto de mensagem de erro a partir de um fragmento HTML de resposta.
 */
export function extractErrorMessageFromHtml(html: string): string | undefined {
  const root = parseHtmlTree(html);
  let errorText: string | undefined;

  const walk = (node: HtmlElementNode | string) => {
    if (errorText || typeof node === "string") return;

    const classAttr = (node.attrs.class ?? "").toLowerCase();
    const roleAttr = (node.attrs.role ?? "").toLowerCase();
    const idAttr = (node.attrs.id ?? "").toLowerCase();

    if (
      idAttr.includes("error") ||
      roleAttr === "alert" ||
      classAttr.includes("alert") ||
      classAttr.includes("error") ||
      classAttr.includes("invalid-feedback")
    ) {
      const text = extractNodeText(node);
      if (text.length > 0 && !text.toLowerCase().includes("sucesso")) {
        errorText = text;
        return;
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  };

  walk(root);
  return errorText;
}

/**
 * Executa um probe individual contra o formulário alvo e extrai as mensagens de validação
 * observadas e/ou status HTTP 4xx.
 */
interface BrowserDomElement {
  value?: string;
  validationMessage?: string;
  checkValidity?: () => boolean;
  requestSubmit?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
  querySelector?: (selector: string) => BrowserDomElement | null;
  hidden?: boolean;
  style?: { display?: string };
  textContent?: string | null;
}

interface BrowserGlobalScope {
  document?: {
    querySelector: (selector: string) => BrowserDomElement | null;
  };
  Event?: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
}

export async function executeFormProbe(options: ExecuteProbeOptions): Promise<FormProbeResult> {
  const { form, probe, page, fetchFn } = options;
  const payload = buildProbePayload(form, probe);

  let observedMessage = "";
  let httpStatus: number | undefined;

  // 1. Tenta execução via Playwright Page (se disponível e com suporte a evaluate)
  if (page && typeof page.evaluate === "function") {
    try {
      const evaluationResult = await page.evaluate(
        ({ formSelector, payloadData, targetField }) => {
          const scope = globalThis as unknown as BrowserGlobalScope;
          const doc = scope.document;
          if (!doc) {
            return { found: false, nativeValidationMsg: "", domMsg: "" };
          }
          const formEl = doc.querySelector(formSelector);
          if (!formEl) {
            return { found: false, nativeValidationMsg: "", domMsg: "" };
          }

          // Preenche os campos do formulário
          for (const [name, val] of Object.entries(payloadData)) {
            const input = formEl.querySelector?.(`[name="${name}"], #${name}`);
            if (input) {
              input.value = String(val ?? "");
              const Ev = scope.Event;
              if (Ev && typeof input.dispatchEvent === "function") {
                input.dispatchEvent(new Ev("input", { bubbles: true }));
                input.dispatchEvent(new Ev("change", { bubbles: true }));
                input.dispatchEvent(new Ev("blur", { bubbles: true }));
              }
            }
          }

          // Checa validação nativa HTML5 no campo alvo
          const targetInput = formEl.querySelector?.(`[name="${targetField}"], #${targetField}`);
          let nativeValidationMsg = "";
          if (targetInput && typeof targetInput.checkValidity === "function") {
            if (!targetInput.checkValidity()) {
              nativeValidationMsg = targetInput.validationMessage || "";
            }
          }

          // Dispara submissão do formulário
          try {
            if (typeof formEl.requestSubmit === "function") {
              formEl.requestSubmit();
            } else {
              const Ev = scope.Event;
              if (Ev && typeof formEl.dispatchEvent === "function") {
                formEl.dispatchEvent(new Ev("submit", { bubbles: true, cancelable: true }));
              }
            }
          } catch {
            // Se bloqueado pelo browser nativo, captura
          }

          // Procura elementos de erro exibidos no DOM
          const errorSelectors = [
            "#form-errors",
            "#login-errors",
            "[role='alert']",
            ".alert",
            ".error",
            ".invalid-feedback",
            ".error-message",
            "[aria-invalid='true']",
          ];

          let domMsg = "";
          for (const sel of errorSelectors) {
            const el = doc.querySelector(sel);
            if (el && !el.hidden && el.style?.display !== "none") {
              const text = el.textContent?.trim() || "";
              if (text.length > 0) {
                domMsg = text;
                break;
              }
            }
          }

          return {
            found: true,
            nativeValidationMsg,
            domMsg,
          };
        },
        {
          formSelector: form.selector,
          payloadData: payload,
          targetField: probe.field,
        },
      );

      if (evaluationResult.found) {
        if (evaluationResult.domMsg) {
          observedMessage = evaluationResult.domMsg;
        } else if (evaluationResult.nativeValidationMsg) {
          observedMessage = evaluationResult.nativeValidationMsg;
        }
      }
    } catch {
      // Se a página Playwright falhar ou não puder avaliar, faz fallback para HTTP fetch
    }
  }

  // 2. Execução via HTTP fetch (se a mensagem ainda não foi obtida, ou em ambiente fetch-backed)
  const effectiveFetch = fetchFn ?? globalThis.fetch;
  if (!observedMessage && typeof effectiveFetch === "function") {
    try {
      const isPost = form.method === "post";
      let requestUrl = form.action;
      const headers: Record<string, string> = {
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
      };

      let body: string | undefined;
      if (isPost) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(payload);
      } else {
        const u = new URL(requestUrl);
        for (const [k, v] of Object.entries(payload)) {
          u.searchParams.set(k, String(v ?? ""));
        }
        requestUrl = u.toString();
      }

      const reqInit: RequestInit = {
        method: form.method.toUpperCase(),
        headers,
        ...(body !== undefined ? { body } : {}),
      };

      const res = await effectiveFetch(requestUrl, reqInit);

      httpStatus = res.status;
      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof json.message === "string" && json.message.trim().length > 0) {
          observedMessage = json.message.trim();
        } else if (Array.isArray(json.issues) && json.issues.length > 0) {
          const first = json.issues[0] as { message?: string; field?: string };
          if (first && typeof first.message === "string") {
            observedMessage = first.message.trim();
          }
        } else if (typeof json.error === "string") {
          observedMessage = json.error.trim();
        }
      } else {
        const text = await res.text().catch(() => "");
        const extracted = extractErrorMessageFromHtml(text);
        if (extracted) {
          observedMessage = extracted;
        } else if (text.length > 0 && res.status >= 400) {
          observedMessage = cleanText(text).slice(0, 200);
        }
      }
    } catch {
      // Falha de rede no probe
    }
  }

  // Se o servidor rejeitou com HTTP 4xx ou houve mensagem exibida, o probe foi validado com sucesso
  const passed = Boolean(
    (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) ||
      observedMessage.length > 0,
  );

  return {
    formId: form.formId,
    field: probe.field,
    probeType: probe.probeType,
    inputSummary: probe.inputSummary,
    input: probe.value,
    observedMessage:
      observedMessage || (httpStatus ? `HTTP ${httpStatus}` : "Rejeitado na validação"),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    selector: form.selector,
    url: form.url,
    passed,
  };
}

// ---------------------------------------------------------------------------
// Evidence Persistence Helpers
// ---------------------------------------------------------------------------

/**
 * Persiste evidência estruturada de schema de formulário (`kind: "form_schema"`).
 */
export function recordFormSchemaEvidence(ctx: PhaseContext, form: FormSchema): Evidence {
  const schemaPayload = {
    formId: form.formId,
    ...(form.name ? { name: form.name } : {}),
    action: form.action,
    method: form.method,
    ...(form.enctype ? { enctype: form.enctype } : {}),
    selector: form.selector,
    url: form.url,
    ...(form.stateId ? { stateId: form.stateId } : {}),
    fields: form.fields,
    ...(form.submitButton ? { submitButton: form.submitButton } : {}),
  };

  const sha256 = computeSha256(canonicalJson(schemaPayload));
  const fieldNames = form.fields.map((f) => f.name).join(", ");
  const summary = `Formulário "${form.formId}" em ${form.url} (${form.fields.length} campos: ${fieldNames})`;

  return ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "form_schema",
    phase: "explore",
    sha256,
    url: form.url,
    ...(form.stateId ? { stateId: form.stateId } : {}),
    blob: canonicalJson(schemaPayload),
    summary,
    data: schemaPayload,
  });
}

/**
 * Persiste evidência estruturada de resultado de probe de formulário (`kind: "form_probe"`).
 */
export function recordFormProbeEvidence(
  ctx: PhaseContext,
  form: FormSchema,
  result: FormProbeResult,
): Evidence {
  const probePayload: FormProbeEvidenceData = {
    formId: result.formId,
    field: result.field,
    probeType: result.probeType,
    inputSummary: result.inputSummary,
    input: result.input,
    observedMessage: result.observedMessage,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    selector: result.selector ?? form.selector,
    url: result.url ?? form.url,
    passed: result.passed,
  };

  const sha256 = computeSha256(
    canonicalJson({
      formId: result.formId,
      field: result.field,
      probeType: result.probeType,
      inputSummary: result.inputSummary,
      observedMessage: result.observedMessage,
      httpStatus: result.httpStatus,
    }),
  );

  const statusLabel = result.httpStatus ? ` (HTTP ${result.httpStatus})` : "";
  const summary =
    `Probe em "${result.formId}" campo "${result.field}": ${result.observedMessage}${statusLabel}`.slice(
      0,
      300,
    );

  return ctx.evidence.put({
    jobId: ctx.job.id,
    kind: "form_probe",
    phase: "explore",
    sha256,
    url: result.url ?? form.url,
    ...(form.stateId ? { stateId: form.stateId } : {}),
    blob: canonicalJson(probePayload),
    summary,
    data: probePayload as unknown as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------------------
// High-Level Form Probing Runner
// ---------------------------------------------------------------------------

export interface ProbeFormOptions {
  form: FormSchema;
  ctx: PhaseContext;
  page?: PlaywrightPage | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

export interface FormProbeRunResult {
  formSchemaEvidence: Evidence;
  probeEvidences: Evidence[];
  results: FormProbeResult[];
}

/**
 * Executa o fluxo completo de registro de schema e bateria de probing para um formulário,
 * respeitando as configurações de `limits.formSubmission` do manifesto.
 */
export async function probeForm(options: ProbeFormOptions): Promise<FormProbeRunResult> {
  const { form, ctx, page, fetchFn } = options;

  // 1. Sempre registra o schema do formulário
  const formSchemaEvidence = recordFormSchemaEvidence(ctx, form);

  // 2. Se formSubmission for "none", não executa nenhum probe
  if (ctx.manifest.limits.formSubmission === "none") {
    ctx.log.debug(
      { formId: form.formId },
      "limits.formSubmission é 'none'; extração de schema concluída sem probing",
    );
    return {
      formSchemaEvidence,
      probeEvidences: [],
      results: [],
    };
  }

  // 3. Se o formulário for destrutivo e destructiveActions === false, não faz probing
  if (!ctx.manifest.limits.destructiveActions && isDestructiveForm(form, ctx.guard)) {
    ctx.log.info(
      { formId: form.formId },
      "formulário classificado como destrutivo ignorado durante probing",
    );
    return {
      formSchemaEvidence,
      probeEvidences: [],
      results: [],
    };
  }

  // 4. Executa a bateria de probes inválidos (modo validation-only)
  const probeInputs = generateFormProbes(form);
  const probeEvidences: Evidence[] = [];
  const results: FormProbeResult[] = [];

  for (const probeInput of probeInputs) {
    if (ctx.signal.aborted) {
      break;
    }

    const probeResult = await executeFormProbe({
      form,
      probe: probeInput,
      page,
      fetchFn,
      guard: ctx.guard,
    });

    const probeEvidence = recordFormProbeEvidence(ctx, form, probeResult);
    probeResult.evidenceId = probeEvidence.id;

    probeEvidences.push(probeEvidence);
    results.push(probeResult);

    ctx.emit({
      type: "form_probe_completed",
      phase: "explore",
      data: {
        formId: form.formId,
        field: probeResult.field,
        probeType: probeResult.probeType,
        observedMessage: probeResult.observedMessage,
        httpStatus: probeResult.httpStatus,
        passed: probeResult.passed,
      },
    });
  }

  return {
    formSchemaEvidence,
    probeEvidences,
    results,
  };
}
