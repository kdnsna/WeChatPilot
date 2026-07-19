import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquireScheduledRunLock,
  type ScheduledRunLock,
} from "../app/scheduled-lock.js";
import {
  runScheduledDigest,
  type RunScheduledDigestOptions,
  type ScheduledDigestResult,
} from "../app/scheduled.js";

export interface ScheduledCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface ScheduledCliDependencies {
  readonly acquireLock?: (options: {
    readonly projectRoot: string;
  }) => Promise<ScheduledRunLock>;
  readonly run?: (
    options: RunScheduledDigestOptions,
  ) => Promise<ScheduledDigestResult>;
}

const processIo: ScheduledCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function projectRootFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--project-root") {
    throw new RangeError("Usage: scheduled --project-root ABSOLUTE_PATH");
  }
  const value = arguments_[1];
  if (value === undefined || !isAbsolute(value)) {
    throw new RangeError("scheduled project root must be an absolute path");
  }
  return resolve(value);
}

function publicErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }
  const safeNames = new Set([
    "Error",
    "RangeError",
    "ScheduledRunBusyError",
    "DailyDigestAlreadySentError",
    "DailyDigestDeliveryBusyError",
    "DailyDigestDeliveryIndeterminateError",
    "DailyDigestRetryLimitError",
    "WechatDeliveryRejectedError",
    "WechatDeliveryIndeterminateError",
    "WechatLoginExpiredError",
    "WechatPartialDeliveryError",
  ]);
  return safeNames.has(error.name) ? error.name : "ScheduledRunError";
}

export async function runScheduledCli(
  arguments_: readonly string[],
  io: ScheduledCliIo = processIo,
  dependencies: ScheduledCliDependencies = {},
  signal?: AbortSignal,
): Promise<0 | 1> {
  let lock: ScheduledRunLock | undefined;
  try {
    const projectRoot = projectRootFromArguments(arguments_);
    lock = await (dependencies.acquireLock ?? acquireScheduledRunLock)({
      projectRoot,
    });
    const result = await (dependencies.run ?? runScheduledDigest)({
      projectRoot,
      ...(process.env.GITHUB_TOKEN === undefined
        ? {}
        : { githubToken: process.env.GITHUB_TOKEN }),
      ...(signal === undefined ? {} : { signal }),
    });
    io.stdout(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        ok: false,
        error: publicErrorName(error),
        message: "scheduled digest failed; inspect the project logs",
      })}\n`,
    );
    return 1;
  } finally {
    await lock?.release();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await runScheduledCli(
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
