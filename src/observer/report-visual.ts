import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";

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

const MAXIMUM_LEDGER_BYTES = 64 * 1_024;
const MAXIMUM_HERO_BYTES = 20 * 1_024 * 1_024;
const MAXIMUM_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 15_000] as const;
const STYLE_VERSION = "editorial-v1" as const;
const HASH = /^[a-f0-9]{64}$/u;

const baseShape = {
  version: z.literal(1),
  runId: z.uuid(),
  issueNumber: z.number().int().positive().max(999_999),
  reportSha256: z.string().regex(HASH),
  attempts: z.number().int().min(0).max(MAXIMUM_ATTEMPTS),
} as const;

const ReportVisualLedgerSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...baseShape,
      status: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("generating"),
      attempts: z.number().int().min(1).max(MAXIMUM_ATTEMPTS),
      promptSha256: z.string().regex(HASH),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("generated"),
      attempts: z.number().int().min(1).max(MAXIMUM_ATTEMPTS),
      promptSha256: z.string().regex(HASH),
      heroPath: ProjectRelativeArtifactPathSchema,
      heroSha256: z.string().regex(HASH),
      styleVersion: z.literal(STYLE_VERSION),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("fallback"),
      stableCode: z.literal("IMAGE_GENERATION_UNAVAILABLE"),
      heroPath: ProjectRelativeArtifactPathSchema,
      heroSha256: z.string().regex(HASH),
      styleVersion: z.literal(STYLE_VERSION),
    })
    .strict(),
]);

type ReportVisualLedger = z.infer<typeof ReportVisualLedgerSchema>;

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
  const bytes = readProjectBytes(projectRoot, path, MAXIMUM_LEDGER_BYTES);
  if (bytes === null) {
    return null;
  }
  return ReportVisualLedgerSchema.parse(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
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

function recordArtifactValid(
  projectRoot: string,
  ledger: ReportVisualLedger,
): boolean {
  if (ledger.status !== "generated" && ledger.status !== "fallback") {
    return true;
  }
  try {
    preparedFromLedger(projectRoot, ledger);
    return true;
  } catch {
    return false;
  }
}

export function inspectReportVisuals(projectRoot: string): {
  readonly pending: number;
  readonly fallback: number;
  readonly invalid: number;
} {
  let pending = 0;
  let fallback = 0;
  let invalid = 0;
  const directory = join(projectRoot, ".state", "observer", "visuals");
  let entries;
  try {
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      return { pending, fallback, invalid: 1 };
    }
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pending, fallback, invalid };
    }
    return { pending, fallback, invalid: 1 };
  }

  for (const entry of entries) {
    try {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error("invalid entry");
      }
      const path = join(directory, entry.name);
      const ledger = readLedger(projectRoot, path);
      if (
        ledger === null ||
        entry.name !== `${ledger.runId}.json` ||
        !recordArtifactValid(projectRoot, ledger)
      ) {
        throw new Error("invalid record");
      }
      if (ledger.status === "pending" || ledger.status === "generating") {
        pending += 1;
      } else if (ledger.status === "fallback") {
        fallback += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  return { pending, fallback, invalid };
}
