import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  deliverRunReport,
  runDeliveryDisposition,
  type DeliverRunReportOptions,
  type DeliverRunReportResult,
  type RunDeliveryDisposition,
  RunReportDeliveryBlockedError,
  RunReportDeliveryIndeterminateError,
} from "../delivery/run-report-delivery.js";
import {
  prepareWechatImageSender,
  prepareWechatTextSender,
  type PreparedWechatImageSender,
  type PreparedWechatTextSender,
} from "../delivery/wechat.js";
import type { ReportCardArtifact } from "../observer/report-card.js";
import {
  buildRunReport,
  ProjectRelativeArtifactPathSchema,
  RunReportSchema,
  type RunReport,
} from "../observer/run-report.js";
import { writeProjectTextAtomic } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import { shanghaiDateKey } from "../lib/time.js";
import {
  acquireObserverTaskLock,
  ObserverTaskBusyError,
  type AcquireObserverTaskLockOptions,
  type ObserverTaskLock,
} from "../observer/task-lock.js";

const TEST_TASK_ID = "codex-wechat-observer-test";
const TEST_TASK_NAME = "Codex 微信值守员测试";
const CHECKPOINT_MAXIMUM_BYTES = 64 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function canonicalImagePath(report: RunReport): string {
  return `output/run-reports/${shanghaiDateKey(report.finishedAt)}/${report.runId}.png`;
}

const TestCardCheckpointSchema = z
  .object({
    version: z.literal(1),
    report: RunReportSchema,
    imagePath: ProjectRelativeArtifactPathSchema,
  })
  .strict()
  .refine(
    (checkpoint) =>
      checkpoint.imagePath === canonicalImagePath(checkpoint.report),
    "test-card image path must be canonical",
  );

type TestCardCheckpoint = z.infer<typeof TestCardCheckpointSchema>;

export interface SendRunReportTestDependencies {
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly render?: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => ReportCardArtifact;
  readonly prepareText?: (options: {
    readonly projectRoot: string;
  }) => Promise<PreparedWechatTextSender>;
  readonly prepareImage?: (options: {
    readonly projectRoot: string;
  }) => Promise<PreparedWechatImageSender>;
  readonly deliver?: (
    options: DeliverRunReportOptions,
  ) => Promise<DeliverRunReportResult>;
  readonly deliveryDisposition?: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => RunDeliveryDisposition;
  readonly acquireTaskLock?: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
}

export interface SendRunReportTestCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface SendRunReportTestCliDependencies {
  readonly send?: (options: {
    readonly projectRoot: string;
  }) => Promise<DeliverRunReportResult>;
}

class SendRunReportTestUsageError extends Error {
  override readonly name = "SendRunReportTestUsageError";
}

function checkpointError(): Error {
  const error = new Error("Invalid test-card checkpoint");
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function checkpointDirectories(projectRoot: string): readonly string[] {
  return [
    resolveProjectPath(projectRoot, ".state"),
    resolveProjectPath(projectRoot, ".state", "observer"),
  ];
}

function checkpointFile(projectRoot: string): string {
  return resolveProjectPath(
    projectRoot,
    ".state",
    "observer",
    "test-card.json",
  );
}

function ensureCheckpointDirectory(projectRoot: string): void {
  try {
    for (const directory of checkpointDirectories(projectRoot)) {
      assertNoSymlinkComponents(projectRoot, directory);
      try {
        mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw checkpointError();
      }
      chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    }
  } catch {
    throw checkpointError();
  }
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readCheckpoint(projectRoot: string): TestCardCheckpoint | null {
  ensureCheckpointDirectory(projectRoot);
  const path = checkpointFile(projectRoot);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
      before.size <= 0 ||
      before.size > CHECKPOINT_MAXIMUM_BYTES
    ) {
      throw checkpointError();
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !sameFile(before, opened) ||
      !opened.isFile() ||
      (opened.mode & 0o777) !== PRIVATE_FILE_MODE ||
      opened.size !== before.size
    ) {
      throw checkpointError();
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        throw checkpointError();
      }
      offset += bytesRead;
    }
    const raw = content.toString("utf8");
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      !sameFile(opened, after) ||
      !sameFile(opened, finalPath) ||
      !after.isFile() ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      (after.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (finalPath.mode & 0o777) !== PRIVATE_FILE_MODE ||
      after.size !== opened.size ||
      finalPath.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw checkpointError();
    }
    return TestCardCheckpointSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw checkpointError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function writeCheckpoint(
  projectRoot: string,
  checkpoint: TestCardCheckpoint,
): void {
  try {
    ensureCheckpointDirectory(projectRoot);
    const parsed = TestCardCheckpointSchema.parse(checkpoint);
    const path = checkpointFile(projectRoot);
    writeProjectTextAtomic(
      projectRoot,
      path,
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    const metadata = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      metadata.size > CHECKPOINT_MAXIMUM_BYTES
    ) {
      throw checkpointError();
    }
  } catch {
    throw checkpointError();
  }
}

function fixedReport(
  projectRoot: string,
  now: Date,
  runId: string,
): RunReport {
  const timestamp = now.toISOString();
  return buildRunReport({
    projectRoot,
    authority: {
      runId,
      taskId: TEST_TASK_ID,
      taskName: TEST_TASK_NAME,
      projectLabel: "WeChatPilot",
      status: "success",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    draft: {
      version: 1,
      summary: ["值守员文字与 PNG 报告卡发送链路验证成功"],
      metrics: [
        { label: "报告类型", value: "确定性本地渲染" },
        { label: "发送目标", value: "已绑定本人微信" },
      ],
      failure: null,
      artifacts: [],
    },
  });
}

async function createCheckpoint(options: {
  readonly projectRoot: string;
  readonly now: Date;
  readonly dependencies: SendRunReportTestDependencies;
}): Promise<TestCardCheckpoint> {
  const report = fixedReport(
    options.projectRoot,
    options.now,
    options.dependencies.createRunId?.() ?? randomUUID(),
  );
  const render =
    options.dependencies.render ??
    (await import("../observer/report-card.js")).renderReportCard;
  const artifact = render({ projectRoot: options.projectRoot, report });
  const imagePath = canonicalImagePath(report);
  const expectedImagePath = resolveProjectPath(options.projectRoot, imagePath);
  if (resolve(artifact.pngPath) !== expectedImagePath) {
    throw checkpointError();
  }
  const checkpoint = TestCardCheckpointSchema.parse({
    version: 1,
    report,
    imagePath,
  });
  writeCheckpoint(options.projectRoot, checkpoint);
  return checkpoint;
}

async function sendFixedRunReportTestWhileLocked(options: {
  readonly projectRoot: string;
  readonly dependencies?: SendRunReportTestDependencies;
}): Promise<DeliverRunReportResult> {
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now?.() ?? new Date();
  const disposition = dependencies.deliveryDisposition ?? runDeliveryDisposition;
  let checkpoint = readCheckpoint(options.projectRoot);
  if (checkpoint !== null) {
    const state = disposition({
      projectRoot: options.projectRoot,
      report: checkpoint.report,
    });
    if (state === "indeterminate") {
      throw new RunReportDeliveryIndeterminateError();
    }
    if (state === "blocked") {
      throw new RunReportDeliveryBlockedError();
    }
    if (state === "sent") {
      checkpoint = await createCheckpoint({
        projectRoot: options.projectRoot,
        now,
        dependencies,
      });
    }
  } else {
    checkpoint = await createCheckpoint({
      projectRoot: options.projectRoot,
      now,
      dependencies,
    });
  }
  const report = checkpoint.report;
  const imagePath = resolveProjectPath(options.projectRoot, checkpoint.imagePath);
  const sendText = await (
    dependencies.prepareText ?? prepareWechatTextSender
  )({ projectRoot: options.projectRoot });
  const sendImage = await (
    dependencies.prepareImage ?? prepareWechatImageSender
  )({ projectRoot: options.projectRoot });
  return await (dependencies.deliver ?? deliverRunReport)({
    projectRoot: options.projectRoot,
    report,
    imagePath,
    sendText,
    sendImage,
    now: () => now,
  });
}

export async function sendFixedRunReportTest(options: {
  readonly projectRoot: string;
  readonly dependencies?: SendRunReportTestDependencies;
}): Promise<DeliverRunReportResult> {
  const dependencies = options.dependencies ?? {};
  const lock = await (
    dependencies.acquireTaskLock ?? acquireObserverTaskLock
  )({
    projectRoot: options.projectRoot,
    taskId: TEST_TASK_ID,
  });
  try {
    return await sendFixedRunReportTestWhileLocked(options);
  } finally {
    await lock.release();
  }
}

function projectRootFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return resolve(process.cwd());
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "--project-root" &&
    arguments_[1] !== undefined &&
    isAbsolute(arguments_[1])
  ) {
    return resolve(arguments_[1]);
  }
  throw new SendRunReportTestUsageError();
}

const processIo: SendRunReportTestCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function runSendRunReportTestCli(
  arguments_: readonly string[],
  io: SendRunReportTestCliIo = processIo,
  dependencies: SendRunReportTestCliDependencies = {},
): Promise<0 | 1> {
  try {
    const projectRoot = projectRootFromArguments(arguments_);
    const result = await (dependencies.send ?? sendFixedRunReportTest)({
      projectRoot,
    });
    io.stdout(
      `${JSON.stringify({ ok: true, status: result.status, image: result.image })}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        error:
          error instanceof SendRunReportTestUsageError
            ? error.name
            : error instanceof ObserverTaskBusyError
              ? error.name
            : "SendRunReportTestError",
        message: "inspect project logs",
      })}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runSendRunReportTestCli(process.argv.slice(2));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
