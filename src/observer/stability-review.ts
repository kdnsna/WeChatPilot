import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listFinalRunReports } from "./run-state.js";

interface Counter { readonly count: number; readonly observed: boolean }
export interface StabilityReview {
  readonly version: 1;
  readonly daysObserved: number;
  readonly evidenceComplete: boolean;
  readonly readyForPlatformAbstraction: boolean;
  readonly runs: { readonly success: number; readonly failed: number; readonly skipped: number };
  readonly sourceDegradations: Counter;
  readonly codexRewrites: Counter;
  readonly linkReplacements: Counter;
  readonly linkGateFailures: Counter;
  readonly wechatDefiniteFailures: Counter;
  readonly wechatIndeterminateSends: Counter;
  readonly duplicateBlocks: Counter;
  readonly staleLockRecoveries: Counter;
  readonly manualInterventions: Counter;
  readonly digestDurationMs: { readonly count: number; readonly min: number; readonly p50: number; readonly p95: number; readonly max: number };
  readonly deliveryDurationMs: { readonly count: number; readonly min: number; readonly p50: number; readonly p95: number; readonly max: number };
}

function distribution(values: readonly number[]) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const percentile = (p: number): number => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
  return { count: sorted.length, min: sorted[0] ?? 0, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 };
}

function jsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/gu).flatMap((line) => {
    if (line.trim() === "") return [];
    try { const value = JSON.parse(line) as unknown; return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : []; }
    catch { return []; }
  });
}

export function buildStabilityReview(projectRoot: string): StabilityReview {
  const reports = listFinalRunReports(projectRoot);
  const dates = new Set(reports.map((report) => report.startedAt.slice(0, 10)));
  const runs = {
    success: reports.filter((report) => report.status === "success").length,
    failed: reports.filter((report) => ["failed", "timed-out", "cancelled", "interrupted"].includes(report.status)).length,
    skipped: reports.filter((report) => report.status === "skipped").length,
  };
  const logDirectory = join(projectRoot, "logs");
  const logFiles = existsSync(logDirectory) ? readdirSync(logDirectory).filter((name) => /^(?:collection|digest)-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)) : [];
  const events = logFiles.flatMap((name) => jsonLines(join(logDirectory, name)));
  const completedCollections = events.filter((event) => event.message === "collection completed");
  const generatedDigests = events.filter((event) => event.message === "digest generated");
  const completedLinkGates = events.filter((event) => event.message === "digest link gate completed");
  const failedLinkGates = events.filter((event) => event.message === "digest link gate failed");
  const sourceDegradations = completedCollections.filter((event) => (event.context as { degraded?: unknown } | undefined)?.degraded === true).length;
  const codexRewrites = generatedDigests.reduce((total, event) => {
    const attempts = (event.context as { attempts?: unknown } | undefined)?.attempts;
    return total + (typeof attempts === "number" && attempts > 1 ? attempts - 1 : 0);
  }, 0);
  const deliveryDirectory = join(projectRoot, ".state", "delivery");
  const deliveryFiles = existsSync(deliveryDirectory) ? readdirSync(deliveryDirectory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)) : [];
  const ledgers = deliveryFiles.flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(deliveryDirectory, name), "utf8")) as Record<string, unknown>]; } catch { return []; }
  });
  const deliveryDurations = ledgers.flatMap((ledger) => {
    const start = typeof ledger.startedAt === "string" ? Date.parse(ledger.startedAt) : Number.NaN;
    const endValue = ledger.sentAt ?? ledger.updatedAt;
    const end = typeof endValue === "string" ? Date.parse(endValue) : Number.NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [end - start] : [];
  });
  let lockMetrics: { staleLockRecoveries: number; manualInterventions: number } | null = null;
  try {
    const value = JSON.parse(readFileSync(join(projectRoot, ".state", "stability-metrics.json"), "utf8")) as Record<string, unknown>;
    if (Number.isSafeInteger(value.staleLockRecoveries) && Number.isSafeInteger(value.manualInterventions)) {
      lockMetrics = value as { staleLockRecoveries: number; manualInterventions: number };
    }
  } catch { /* Missing metrics keep the stability gate closed. */ }
  const linkReplacements = completedLinkGates.reduce((total, event) => {
    const replacements = (event.context as { replacements?: unknown } | undefined)?.replacements;
    return total + (typeof replacements === "number" && replacements >= 0 ? replacements : 0);
  }, 0);
  const allRequiredInstrumentationObserved =
    completedCollections.length > 0 && generatedDigests.length > 0 && completedLinkGates.length > 0 && lockMetrics !== null;
  return {
    version: 1,
    daysObserved: dates.size,
    evidenceComplete: dates.size >= 7 && allRequiredInstrumentationObserved,
    readyForPlatformAbstraction: false,
    runs,
    sourceDegradations: { count: sourceDegradations, observed: completedCollections.length > 0 },
    codexRewrites: { count: codexRewrites, observed: generatedDigests.length > 0 },
    linkReplacements: { count: linkReplacements, observed: completedLinkGates.length > 0 },
    linkGateFailures: { count: failedLinkGates.length, observed: completedLinkGates.length + failedLinkGates.length > 0 },
    wechatDefiniteFailures: { count: ledgers.filter((ledger) => ledger.status === "failed").length, observed: deliveryFiles.length > 0 },
    wechatIndeterminateSends: { count: ledgers.filter((ledger) => ledger.status === "indeterminate" || ledger.status === "sending").length, observed: deliveryFiles.length > 0 },
    duplicateBlocks: { count: reports.filter((report) => report.status === "skipped").length, observed: reports.length > 0 },
    staleLockRecoveries: { count: lockMetrics?.staleLockRecoveries ?? 0, observed: lockMetrics !== null },
    manualInterventions: { count: lockMetrics?.manualInterventions ?? 0, observed: lockMetrics !== null },
    digestDurationMs: distribution(reports.map((report) => report.durationMs)),
    deliveryDurationMs: distribution(deliveryDurations),
  };
}
