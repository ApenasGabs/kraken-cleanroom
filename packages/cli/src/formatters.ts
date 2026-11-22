import {
  DEFAULT_PHASE_ORDER,
  type Evidence,
  type JobState,
  type JobStatus,
  type JobSummary,
  type Page,
} from "@cleanroom/core";

export function exitCodeForJobState(state: JobState): number {
  switch (state) {
    case "completed":
      return 0;
    case "awaiting_human":
      return 2;
    case "blocked":
      return 3;
    default:
      return 1;
  }
}

export function renderProgressBar(done: number, total: number, width = 14): string {
  const safeTotal = Math.max(1, total);
  const clamped = Math.max(0, Math.min(safeTotal, done));
  const filled = Math.round((clamped / safeTotal) * width);
  const empty = Math.max(0, width - filled);
  return `[${"#".repeat(filled)}${"-".repeat(empty)}] ${clamped}/${safeTotal}`;
}

export function formatRunProgressLine(status: JobStatus): string {
  const phases = status.phases.length > 0 ? status.phases : [];
  const total = phases.length > 0 ? phases.length : DEFAULT_PHASE_ORDER.length;
  const completedCount = phases.filter((p) => p.status === "done" || p.status === "skipped").length;
  const bar = renderProgressBar(completedCount, total);
  const activePhase = status.currentPhase ?? status.state;
  const c = status.counters;
  return `${bar} ${activePhase} | pages=${c.pages} evidence=${c.evidence} findings=${c.findings} rules=${c.rules}`;
}

export function formatJobStatus(status: JobStatus): string {
  const lines: string[] = [
    `Job: ${status.jobId}`,
    `Estado: ${status.state}${status.currentPhase ? ` (fase atual: ${status.currentPhase})` : ""}`,
    `Atualizado em: ${status.updatedAt} (iniciado em: ${status.startedAt})`,
    `Contadores: pages=${status.counters.pages}, evidence=${status.counters.evidence}, findings=${status.counters.findings}, rules=${status.counters.rules}`,
    `LLM tokens: in=${status.llm.tokensIn}, out=${status.llm.tokensOut}`,
  ];

  if (status.pendingHandoff) {
    lines.push(
      `Handoff pendente: ${status.pendingHandoff.id} (${status.pendingHandoff.kind}) — ${status.pendingHandoff.message}`,
    );
  }
  if (status.error) {
    lines.push(`Erro: ${status.error}`);
  }

  if (status.phases.length > 0) {
    lines.push("Fases:");
    for (const p of status.phases) {
      const statsStr = p.stats
        ? ` (${Object.entries(p.stats)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")})`
        : "";
      lines.push(`  - ${p.id}: ${p.status}${statsStr}`);
    }
  }

  return lines.join("\n");
}

export function formatJobList(jobs: readonly JobSummary[]): string {
  if (jobs.length === 0) {
    return "Nenhum job encontrado.";
  }

  const lines = ["Jobs registrados:"];
  for (const job of jobs) {
    const errSuffix = job.error ? ` — erro: ${job.error}` : "";
    lines.push(
      `  - ${job.jobId}  [${job.state}]  ${job.name}  (updated: ${job.updatedAt})${errSuffix}`,
    );
  }
  return lines.join("\n");
}

export function formatEvidencePage(page: Page<Evidence>): string {
  if (page.items.length === 0) {
    return "Nenhuma evidência encontrada.";
  }

  const lines = [`Evidências (${page.items.length} item(ns)):`];
  for (const ev of page.items) {
    const urlPart = ev.url ? ` | ${ev.url}` : "";
    const blobPart = ev.blobPath ? ` | blob=${ev.blobPath}` : "";
    lines.push(`  - ${ev.id} [${ev.kind}/${ev.phase}]${urlPart}${blobPart}`);
    lines.push(`    ${ev.summary}`);
  }
  if (page.nextCursor) {
    lines.push(`Próxima página (--cursor): ${page.nextCursor}`);
  }
  return lines.join("\n");
}
