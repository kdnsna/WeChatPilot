import { join } from "node:path";

import { z } from "zod";

import {
  readProjectBytes,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import type { EditorialConfig } from "./editorial-config.js";

const MAXIMUM_MARKER_BYTES = 8 * 1_024;
const HASH = /^[a-f0-9]{64}$/u;

const ReportImageCapabilitySchema = z
  .object({
    codexVersion: z.string().min(1).max(64),
    styleVersion: z.literal("editorial-v1"),
    succeededAt: z.iso.datetime({ offset: true }),
    artifactSha256: z.string().regex(HASH),
  })
  .strict();

export type ReportImageCapability = z.infer<
  typeof ReportImageCapabilitySchema
>;

function markerPath(projectRoot: string): string {
  return join(
    projectRoot,
    ".state",
    "observer",
    "report-image-capability.json",
  );
}

export function writeReportImageCapability(options: {
  readonly projectRoot: string;
  readonly marker: ReportImageCapability;
}): void {
  const marker = ReportImageCapabilitySchema.parse(options.marker);
  writeProjectTextAtomic(
    options.projectRoot,
    markerPath(options.projectRoot),
    `${JSON.stringify(marker)}\n`,
  );
}

export function reportImageCapabilityReady(options: {
  readonly projectRoot: string;
  readonly config: EditorialConfig;
}): boolean {
  try {
    const bytes = readProjectBytes(
      options.projectRoot,
      markerPath(options.projectRoot),
      MAXIMUM_MARKER_BYTES,
    );
    if (bytes === null) {
      return false;
    }
    const marker = ReportImageCapabilitySchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    return (
      marker.codexVersion === options.config.codex.version &&
      marker.styleVersion === options.config.style.version
    );
  } catch {
    return false;
  }
}
