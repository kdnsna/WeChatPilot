import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  renderEditorialReportCard,
  type EditorialCardArtifact,
} from "../observer/editorial-card.js";
import {
  loadEditorialConfig,
  type EditorialConfig,
} from "../observer/editorial-config.js";
import {
  buildFixedEditorialReport,
  FIXED_PREVIEW_FINISHED_AT,
  FIXED_PREVIEW_RUN_ID,
} from "../observer/fixed-editorial-report.js";
import {
  prepareReportVisual,
  type PreparedReportVisual,
} from "../observer/report-visual.js";
import {
  assignReportIssue,
  type ReportIssue,
} from "../observer/report-sequence.js";

export interface RenderRunReportPreviewDependencies {
  readonly assignIssue?: (options: {
    readonly projectRoot: string;
    readonly runId: string;
  }) => Promise<ReportIssue>;
  readonly loadConfig?: (projectRoot: string) => EditorialConfig;
  readonly prepareVisual?: (options: {
    readonly projectRoot: string;
    readonly report: ReturnType<typeof buildFixedEditorialReport>;
    readonly issue: ReportIssue;
    readonly config: EditorialConfig;
  }) => Promise<PreparedReportVisual>;
  readonly render?: typeof renderEditorialReportCard;
}

export interface RenderRunReportPreviewCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class RenderRunReportPreviewUsageError extends Error {
  override readonly name = "RenderRunReportPreviewUsageError";
}

export async function renderFixedEditorialPreview(options: {
  readonly projectRoot: string;
  readonly dependencies?: RenderRunReportPreviewDependencies;
}): Promise<EditorialCardArtifact> {
  const dependencies = options.dependencies ?? {};
  const issue = await (dependencies.assignIssue ?? assignReportIssue)({
    projectRoot: options.projectRoot,
    runId: FIXED_PREVIEW_RUN_ID,
  });
  const config = (dependencies.loadConfig ?? loadEditorialConfig)(
    options.projectRoot,
  );
  if (config.mode !== "editorial") {
    throw new Error("Unable to render editorial report preview");
  }
  const report = buildFixedEditorialReport({
    runId: FIXED_PREVIEW_RUN_ID,
    finishedAt: FIXED_PREVIEW_FINISHED_AT,
    issue,
    taskId: "codex-wechat-editorial-preview",
    taskName: "Codex 编辑部情报固定预览",
  });
  const visual = await (dependencies.prepareVisual ?? prepareReportVisual)({
    projectRoot: options.projectRoot,
    report,
    issue,
    config,
  });
  const artifact = (dependencies.render ?? renderEditorialReportCard)({
    projectRoot: options.projectRoot,
    report,
    visual,
  });
  const expected = join(
    options.projectRoot,
    "output",
    "run-reports",
    "2026-07-20",
    `${FIXED_PREVIEW_RUN_ID}.png`,
  );
  if (resolve(artifact.pngPath) !== expected) {
    throw new Error("Unable to render editorial report preview");
  }
  return artifact;
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
  throw new RenderRunReportPreviewUsageError();
}

const processIo: RenderRunReportPreviewCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function runRenderRunReportPreviewCli(
  arguments_: readonly string[],
  io: RenderRunReportPreviewCliIo = processIo,
  dependencies: {
    readonly render?: typeof renderFixedEditorialPreview;
  } = {},
): Promise<0 | 1> {
  try {
    const projectRoot = projectRootFromArguments(arguments_);
    await (dependencies.render ?? renderFixedEditorialPreview)({ projectRoot });
    io.stdout(`${JSON.stringify({ ok: true, status: "rendered" })}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        error:
          error instanceof RenderRunReportPreviewUsageError
            ? error.name
            : "RenderRunReportPreviewError",
        message: "inspect project logs",
      })}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runRenderRunReportPreviewCli(process.argv.slice(2));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
