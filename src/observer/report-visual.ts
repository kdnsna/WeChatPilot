import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { pngDimensions, isValidPng } from "../lib/png.js";
import {
  readProjectBytes,
  writeProjectBytesAtomic,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import { shanghaiDateKey } from "../lib/time.js";
import {
  CodexImageError,
  codexImagePromptSha256,
  generateCodexHero,
  type GeneratedHeroArtifact,
} from "./codex-image.js";
import type { EditorialConfig } from "./editorial-config.js";
import { ProjectRelativeArtifactPathSchema, RunReportSchema, type RunReport } from "./run-report.js";
import type { ReportIssue } from "./report-sequence.js";
import {
  inspectReportVisuals,
  readReportVisualLedger,
  ReportVisualLedgerSchema,
  type ReportVisualLedger,
  REPORT_VISUAL_MAXIMUM_ATTEMPTS as MAXIMUM_ATTEMPTS,
  REPORT_VISUAL_MAXIMUM_HERO_BYTES as MAXIMUM_HERO_BYTES,
  REPORT_VISUAL_STYLE_VERSION as STYLE_VERSION,
} from "./report-visual-state.js";

const RETRY_DELAYS_MS = [5_000, 15_000] as const;
const HASH = /^[a-f0-9]{64}$/u;

export interface PreparedReportVisual {
  readonly mode: "generated" | "fallback";
  readonly attempts: number;
  readonly heroPath: string;
  readonly heroSha256: string;
  readonly styleVersion: "editorial-v1";
  readonly promptSha256?: string;
}

type GenerateHero = (options: {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly issue: ReportIssue;
  readonly config: EditorialConfig;
}) => Promise<GeneratedHeroArtifact>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportSha256(report: RunReport): string {
  return sha256(JSON.stringify(stableValue(report)));
}

function validIssue(report: RunReport, issue: ReportIssue): boolean {
  return (
    Number.isInteger(issue.number) &&
    issue.number > 0 &&
    issue.number <= 999_999 &&
    issue.label === `WP-${String(issue.number).padStart(6, "0")}` &&
    report.issueNumber === issue.number &&
    report.issueLabel === issue.label
  );
}

function ledgerPath(projectRoot: string, runId: string): string {
  return join(
    projectRoot,
    ".state",
    "observer",
    "visuals",
    `${runId}.json`,
  );
}

function writeLedger(
  projectRoot: string,
  path: string,
  ledger: ReportVisualLedger,
): void {
  const parsed = ReportVisualLedgerSchema.parse(ledger);
  writeProjectTextAtomic(projectRoot, path, `${JSON.stringify(parsed)}\n`);
}

function readLedger(
  projectRoot: string,
  path: string,
): ReportVisualLedger | null {
  return readReportVisualLedger(projectRoot, path);
}

function relativeHeroPath(projectRoot: string, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error("Invalid report visual artifact");
  }
  const path = relative(projectRoot, absolutePath);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw new Error("Invalid report visual artifact");
  }
  return ProjectRelativeArtifactPathSchema.parse(path.split(sep).join("/"));
}

function verifiedHero(
  projectRoot: string,
  path: string,
  expectedSha256: string,
  mode: "generated" | "fallback",
): { readonly absolutePath: string; readonly bytes: Buffer } {
  const absolutePath = join(projectRoot, path);
  const bytes = readProjectBytes(projectRoot, absolutePath, MAXIMUM_HERO_BYTES);
  if (bytes === null || sha256(bytes) !== expectedSha256) {
    throw new Error("Invalid report visual artifact");
  }
  const dimensions = pngDimensions(bytes);
  if (
    dimensions === null ||
    (mode === "generated"
      ? dimensions.width < 768 || dimensions.height < 768
      : dimensions.width !== 1_080 || dimensions.height !== 480)
  ) {
    throw new Error("Invalid report visual artifact");
  }
  return { absolutePath, bytes };
}

function preparedFromLedger(
  projectRoot: string,
  ledger: Extract<ReportVisualLedger, { status: "generated" | "fallback" }>,
): PreparedReportVisual {
  const hero = verifiedHero(
    projectRoot,
    ledger.heroPath,
    ledger.heroSha256,
    ledger.status,
  );
  return {
    mode: ledger.status,
    attempts: ledger.attempts,
    heroPath: hero.absolutePath,
    heroSha256: ledger.heroSha256,
    styleVersion: ledger.styleVersion,
    ...(ledger.status === "generated"
      ? { promptSha256: ledger.promptSha256 }
      : {}),
  };
}

function fallbackSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="480" viewBox="0 0 1080 480">',
    '<rect width="1080" height="480" fill="#f3eee4"/>',
    '<path d="M0 0h1080v480H0z" fill="#10233f" opacity="0.96"/>',
    '<circle cx="830" cy="238" r="164" fill="none" stroke="#d97941" stroke-width="22"/>',
    '<circle cx="830" cy="238" r="104" fill="#f3eee4" opacity="0.14"/>',
    '<path d="M570 338 720 170l110 68 120-142" fill="none" stroke="#f3eee4" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.82"/>',
    '<path d="M660 412h356" stroke="#d97941" stroke-width="10" stroke-linecap="round"/>',
    '<rect x="72" y="72" width="300" height="14" rx="7" fill="#d97941"/>',
    '<rect x="72" y="112" width="190" height="8" rx="4" fill="#f3eee4" opacity="0.36"/>',
    "</svg>",
  ].join("");
}

function createFallback(
  projectRoot: string,
  report: RunReport,
  issue: ReportIssue,
  reportHash: string,
  attempts: number,
  path: string,
): PreparedReportVisual {
  const heroPath = join(
    projectRoot,
    "output",
    "run-reports",
    shanghaiDateKey(report.finishedAt),
    `${report.runId}.hero.png`,
  );
  const bytes = Buffer.from(new Resvg(fallbackSvg()).render().asPng());
  if (
    !isValidPng(bytes, {
      width: 1_080,
      height: 480,
      maximumBytes: 5 * 1_024 * 1_024,
    })
  ) {
    throw new Error("Unable to prepare report visual");
  }
  writeProjectBytesAtomic(projectRoot, heroPath, bytes);
  const heroHash = sha256(bytes);
  const ledger: Extract<ReportVisualLedger, { status: "fallback" }> = {
    version: 1,
    status: "fallback",
    runId: report.runId,
    issueNumber: issue.number,
    reportSha256: reportHash,
    attempts,
    stableCode: "IMAGE_GENERATION_UNAVAILABLE",
    heroPath: relativeHeroPath(projectRoot, heroPath),
    heroSha256: heroHash,
    styleVersion: STYLE_VERSION,
  };
  writeLedger(projectRoot, path, ledger);
  return preparedFromLedger(projectRoot, ledger);
}

export async function prepareReportVisual(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly issue: ReportIssue;
  readonly config: EditorialConfig;
  readonly generate?: GenerateHero;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<PreparedReportVisual> {
  let report: RunReport;
  try {
    report = RunReportSchema.parse(options.report);
    if (!validIssue(report, options.issue)) {
      throw new Error("issue mismatch");
    }
  } catch {
    throw new Error("Unable to prepare report visual");
  }
  const reportHash = reportSha256(report);
  const path = ledgerPath(options.projectRoot, report.runId);
  let ledger: ReportVisualLedger;
  try {
    ledger =
      readLedger(options.projectRoot, path) ?? {
        version: 1,
        status: "pending",
        runId: report.runId,
        issueNumber: options.issue.number,
        reportSha256: reportHash,
        attempts: 0,
      };
  } catch {
    throw new Error("Unable to prepare report visual");
  }
  if (
    ledger.runId !== report.runId ||
    ledger.issueNumber !== options.issue.number ||
    ledger.reportSha256 !== reportHash
  ) {
    throw new Error("Unable to prepare report visual");
  }
  if (ledger.status === "generated" || ledger.status === "fallback") {
    try {
      return preparedFromLedger(options.projectRoot, ledger);
    } catch {
      throw new Error("Unable to prepare report visual");
    }
  }
  if (ledger.status === "pending") {
    writeLedger(options.projectRoot, path, ledger);
  }

  const generate = options.generate ?? generateCodexHero;
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  });
  let attempts = ledger.attempts;
  if (attempts >= MAXIMUM_ATTEMPTS) {
    return createFallback(
      options.projectRoot,
      report,
      options.issue,
      reportHash,
      attempts,
      path,
    );
  }

  const promptHash = codexImagePromptSha256(
    options.projectRoot,
    report,
    options.issue,
  );
  while (attempts < MAXIMUM_ATTEMPTS) {
    attempts += 1;
    writeLedger(options.projectRoot, path, {
      version: 1,
      status: "generating",
      runId: report.runId,
      issueNumber: options.issue.number,
      reportSha256: reportHash,
      attempts,
      promptSha256: promptHash,
    });
    try {
      const artifact = await generate({
        projectRoot: options.projectRoot,
        report,
        issue: options.issue,
        config: options.config,
      });
      if (!HASH.test(artifact.sha256) || !HASH.test(artifact.promptSha256)) {
        throw new Error("invalid generation hashes");
      }
      const heroRelativePath = relativeHeroPath(
        options.projectRoot,
        artifact.pngPath,
      );
      verifiedHero(
        options.projectRoot,
        heroRelativePath,
        artifact.sha256,
        "generated",
      );
      const completed: Extract<ReportVisualLedger, { status: "generated" }> = {
        version: 1,
        status: "generated",
        runId: report.runId,
        issueNumber: options.issue.number,
        reportSha256: reportHash,
        attempts,
        promptSha256: artifact.promptSha256,
        heroPath: heroRelativePath,
        heroSha256: artifact.sha256,
        styleVersion: STYLE_VERSION,
      };
      writeLedger(options.projectRoot, path, completed);
      return preparedFromLedger(options.projectRoot, completed);
    } catch (error) {
      if (error instanceof CodexImageError && error.kind === "aborted") {
        throw error;
      }
      if (attempts < MAXIMUM_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempts - 1];
        if (delay !== undefined) {
          await sleep(delay);
        }
      }
    }
  }

  return createFallback(
    options.projectRoot,
    report,
    options.issue,
    reportHash,
    attempts,
    path,
  );
}

export { inspectReportVisuals };
