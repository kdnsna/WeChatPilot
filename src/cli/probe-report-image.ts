import { createHash, randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { pngDimensions } from "../lib/png.js";
import { readProjectBytes } from "../lib/project-file.js";
import { generateCodexHero } from "../observer/codex-image.js";
import {
  loadEditorialConfig,
  type EditorialConfig,
} from "../observer/editorial-config.js";
import { buildFixedEditorialReport } from "../observer/fixed-editorial-report.js";
import {
  writeReportImageCapability,
  type ReportImageCapability,
} from "../observer/report-image-capability.js";

const MAXIMUM_HERO_BYTES = 20 * 1_024 * 1_024;
const PROBE_ISSUE = { number: 999_999, label: "WP-999999" } as const;

interface ProbeImageArtifact {
  readonly pngPath: string;
  readonly sha256: string;
  readonly promptSha256: string;
}

export interface ProbeReportImageDependencies {
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly loadConfig?: (projectRoot: string) => EditorialConfig;
  readonly generate?: (options: {
    readonly projectRoot: string;
    readonly report: ReturnType<typeof buildFixedEditorialReport>;
    readonly issue: typeof PROBE_ISSUE;
    readonly config: EditorialConfig;
  }) => Promise<ProbeImageArtifact>;
  readonly writeMarker?: (options: {
    readonly projectRoot: string;
    readonly marker: ReportImageCapability;
  }) => void;
}

export interface ProbeReportImageCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class ProbeReportImageUsageError extends Error {
  override readonly name = "ProbeReportImageUsageError";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedHeroPath(projectRoot: string, runId: string): string {
  return join(
    projectRoot,
    "output",
    "run-reports",
    "2026-07-20",
    `${runId}.hero.png`,
  );
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function probeReportImage(options: {
  readonly projectRoot: string;
  readonly dependencies?: ProbeReportImageDependencies;
}): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const config = (dependencies.loadConfig ?? loadEditorialConfig)(
    options.projectRoot,
  );
  const runId = dependencies.createRunId?.() ?? randomUUID();
  const report = buildFixedEditorialReport({
    runId,
    finishedAt: "2026-07-20T01:00:00.000Z",
    issue: PROBE_ISSUE,
    taskId: "codex-image-capability-probe",
    taskName: "Codex Image 2 能力探测",
  });
  const generate = dependencies.generate ?? generateCodexHero;
  const artifact = await generate({
    projectRoot: options.projectRoot,
    report,
    issue: PROBE_ISSUE,
    config,
  });
  const expectedPath = expectedHeroPath(options.projectRoot, runId);
  if (resolve(artifact.pngPath) !== expectedPath) {
    throw new Error("Report image capability probe failed");
  }
  const bytes = readProjectBytes(
    options.projectRoot,
    artifact.pngPath,
    MAXIMUM_HERO_BYTES,
  );
  const dimensions = bytes === null ? null : pngDimensions(bytes);
  if (
    bytes === null ||
    dimensions === null ||
    dimensions.width < 768 ||
    dimensions.height < 768 ||
    sha256(bytes) !== artifact.sha256
  ) {
    throw new Error("Report image capability probe failed");
  }
  const identity = lstatSync(artifact.pngPath);
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new Error("Report image capability probe failed");
  }
  (dependencies.writeMarker ?? writeReportImageCapability)({
    projectRoot: options.projectRoot,
    marker: {
      codexVersion: config.codex.version,
      styleVersion: config.style.version,
      succeededAt: (dependencies.now?.() ?? new Date()).toISOString(),
      artifactSha256: artifact.sha256,
    },
  });
  const finalIdentity = lstatSync(artifact.pngPath);
  if (
    finalIdentity.isSymbolicLink() ||
    !finalIdentity.isFile() ||
    !sameIdentity(identity, finalIdentity) ||
    identity.size !== finalIdentity.size ||
    identity.mtimeMs !== finalIdentity.mtimeMs ||
    identity.ctimeMs !== finalIdentity.ctimeMs
  ) {
    throw new Error("Report image capability probe failed");
  }
  unlinkSync(artifact.pngPath);
}

function projectRootFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return resolve(process.cwd());
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "--project-root" &&
    arguments_[1] !== undefined &&
    arguments_[1].trim() !== ""
  ) {
    return resolve(arguments_[1]);
  }
  throw new ProbeReportImageUsageError();
}

const processIo: ProbeReportImageCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function runProbeReportImageCli(
  arguments_: readonly string[],
  io: ProbeReportImageCliIo = processIo,
  dependencies: { readonly probe?: typeof probeReportImage } = {},
): Promise<0 | 1> {
  try {
    const projectRoot = projectRootFromArguments(arguments_);
    await (dependencies.probe ?? probeReportImage)({ projectRoot });
    io.stdout(`${JSON.stringify({ ok: true, status: "ready" })}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        error:
          error instanceof ProbeReportImageUsageError
            ? error.name
            : "ProbeReportImageError",
        message: "inspect project logs",
      })}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runProbeReportImageCli(process.argv.slice(2));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
