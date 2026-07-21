import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runObserverJob,
  type RunObserverJobOptions,
} from "../app/observer.js";
import {
  RunReportDeliveryBlockedError,
  RunReportDeliveryBusyError,
  RunReportDeliveryIndeterminateError,
  RunReportRetryLimitError,
} from "../delivery/run-report-delivery.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatLoginExpiredError,
  WechatMediaPreparationError,
  WechatPartialDeliveryError,
} from "../delivery/wechat.js";
import { ObserverTaskBusyError } from "../observer/task-lock.js";

const FIXED_JOB = "daily-tech-digest" as const;

export interface ObserverCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface ObserverCliDependencies {
  readonly run?: (options: RunObserverJobOptions) => ReturnType<typeof runObserverJob>;
}

class ObserverCliUsageError extends Error {
  override readonly name = "ObserverCliUsageError";
}

const processIo: ObserverCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function parseArguments(arguments_: readonly string[]): {
  readonly projectRoot: string;
  readonly jobId: typeof FIXED_JOB;
} {
  if (
    (arguments_.length !== 4 && arguments_.length !== 6) ||
    arguments_[0] !== "--project-root" ||
    arguments_[2] !== "--job" ||
    arguments_[3] !== FIXED_JOB
  ) {
    throw new ObserverCliUsageError();
  }
  const projectRoot = arguments_[1];
  if (projectRoot === undefined || projectRoot.trim() === "") {
    throw new ObserverCliUsageError();
  }
  const resolvedRoot = resolve(projectRoot);
  if (
    arguments_.length === 6 &&
    (arguments_[4] !== "--runtime-manifest" ||
      arguments_[5] === undefined ||
      resolve(arguments_[5]) !== join(resolvedRoot, ".state", "runtime.json"))
  ) {
    throw new ObserverCliUsageError();
  }
  return { projectRoot: resolvedRoot, jobId: FIXED_JOB };
}

function publicErrorName(error: unknown): string {
  if (error instanceof ObserverCliUsageError) {
    return error.name;
  }
  if (
    error instanceof ObserverTaskBusyError ||
    error instanceof RunReportDeliveryBusyError ||
    error instanceof RunReportDeliveryIndeterminateError ||
    error instanceof RunReportRetryLimitError ||
    error instanceof RunReportDeliveryBlockedError ||
    error instanceof WechatDeliveryRejectedError ||
    error instanceof WechatDeliveryIndeterminateError ||
    error instanceof WechatLoginExpiredError ||
    error instanceof WechatPartialDeliveryError ||
    error instanceof WechatMediaPreparationError
  ) {
    return error.name;
  }
  return "ObserverJobError";
}

export async function runObserverCli(
  arguments_: readonly string[],
  io: ObserverCliIo = processIo,
  dependencies: ObserverCliDependencies = {},
  signal?: AbortSignal,
): Promise<0 | 1> {
  try {
    const parsed = parseArguments(arguments_);
    const report = await (dependencies.run ?? runObserverJob)({
      projectRoot: parsed.projectRoot,
      jobId: parsed.jobId,
      ...(signal === undefined ? {} : { signal }),
    });
    io.stdout(
      `${JSON.stringify({
        ok: true,
        status: report.status,
        runId: report.runId.slice(0, 8),
      })}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        error: publicErrorName(error),
        message: "inspect project logs",
      })}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await runObserverCli(
      process.argv.slice(2),
      processIo,
      {},
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
