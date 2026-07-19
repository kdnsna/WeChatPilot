import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  deliverRunReport,
  type DeliverRunReportOptions,
  type DeliverRunReportResult,
} from "../delivery/run-report-delivery.js";
import {
  prepareWechatImageSender,
  prepareWechatTextSender,
  type PreparedWechatImageSender,
  type PreparedWechatTextSender,
} from "../delivery/wechat.js";
import {
  renderReportCard,
  type ReportCardArtifact,
} from "../observer/report-card.js";
import { buildRunReport, type RunReport } from "../observer/run-report.js";

const TEST_TASK_ID = "codex-wechat-observer-test";
const TEST_TASK_NAME = "Codex 微信值守员测试";

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

export async function sendFixedRunReportTest(options: {
  readonly projectRoot: string;
  readonly dependencies?: SendRunReportTestDependencies;
}): Promise<DeliverRunReportResult> {
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now?.() ?? new Date();
  const report = fixedReport(
    options.projectRoot,
    now,
    dependencies.createRunId?.() ?? randomUUID(),
  );
  const artifact = (dependencies.render ?? renderReportCard)({
    projectRoot: options.projectRoot,
    report,
  });
  const sendText = await (
    dependencies.prepareText ?? prepareWechatTextSender
  )({ projectRoot: options.projectRoot });
  const sendImage = await (
    dependencies.prepareImage ?? prepareWechatImageSender
  )({ projectRoot: options.projectRoot });
  return await (dependencies.deliver ?? deliverRunReport)({
    projectRoot: options.projectRoot,
    report,
    imagePath: artifact.pngPath,
    sendText,
    sendImage,
    now: () => now,
  });
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
