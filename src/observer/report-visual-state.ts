import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { pngDimensions } from "../lib/png.js";
import { readProjectBytes } from "../lib/project-file.js";
import { ProjectRelativeArtifactPathSchema } from "./run-report.js";

export const REPORT_VISUAL_MAXIMUM_LEDGER_BYTES = 64 * 1_024;
export const REPORT_VISUAL_MAXIMUM_HERO_BYTES = 20 * 1_024 * 1_024;
export const REPORT_VISUAL_MAXIMUM_ATTEMPTS = 3;
export const REPORT_VISUAL_STYLE_VERSION = "editorial-v1" as const;
const HASH = /^[a-f0-9]{64}$/u;

const baseShape = {
  version: z.literal(1),
  runId: z.uuid(),
  issueNumber: z.number().int().positive().max(999_999),
  reportSha256: z.string().regex(HASH),
  attempts: z
    .number()
    .int()
    .min(0)
    .max(REPORT_VISUAL_MAXIMUM_ATTEMPTS),
} as const;

export const ReportVisualLedgerSchema = z.discriminatedUnion("status", [
  z.object({ ...baseShape, status: z.literal("pending") }).strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("generating"),
      attempts: z.number().int().min(1).max(REPORT_VISUAL_MAXIMUM_ATTEMPTS),
      promptSha256: z.string().regex(HASH),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("generated"),
      attempts: z.number().int().min(1).max(REPORT_VISUAL_MAXIMUM_ATTEMPTS),
      promptSha256: z.string().regex(HASH),
      heroPath: ProjectRelativeArtifactPathSchema,
      heroSha256: z.string().regex(HASH),
      styleVersion: z.literal(REPORT_VISUAL_STYLE_VERSION),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      status: z.literal("fallback"),
      stableCode: z.literal("IMAGE_GENERATION_UNAVAILABLE"),
      heroPath: ProjectRelativeArtifactPathSchema,
      heroSha256: z.string().regex(HASH),
      styleVersion: z.literal(REPORT_VISUAL_STYLE_VERSION),
    })
    .strict(),
]);

export type ReportVisualLedger = z.infer<typeof ReportVisualLedgerSchema>;

export function readReportVisualLedger(
  projectRoot: string,
  path: string,
): ReportVisualLedger | null {
  const bytes = readProjectBytes(
    projectRoot,
    path,
    REPORT_VISUAL_MAXIMUM_LEDGER_BYTES,
  );
  if (bytes === null) {
    return null;
  }
  return ReportVisualLedgerSchema.parse(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
}

function completedArtifactValid(
  projectRoot: string,
  ledger: ReportVisualLedger,
): boolean {
  if (ledger.status !== "generated" && ledger.status !== "fallback") {
    return true;
  }
  try {
    const bytes = readProjectBytes(
      projectRoot,
      join(projectRoot, ledger.heroPath),
      REPORT_VISUAL_MAXIMUM_HERO_BYTES,
    );
    if (
      bytes === null ||
      createHash("sha256").update(bytes).digest("hex") !== ledger.heroSha256
    ) {
      return false;
    }
    const dimensions = pngDimensions(bytes);
    return (
      dimensions !== null &&
      (ledger.status === "generated"
        ? dimensions.width >= 768 && dimensions.height >= 768
        : dimensions.width === 1_080 && dimensions.height === 480)
    );
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
      const ledger = readReportVisualLedger(
        projectRoot,
        join(directory, entry.name),
      );
      if (
        ledger === null ||
        entry.name !== `${ledger.runId}.json` ||
        !completedArtifactValid(projectRoot, ledger)
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
