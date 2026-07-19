import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";

import { resolveProjectPath } from "../lib/paths.js";
import { ObserverJobSchema, type ObserverJob } from "./config.js";
import { parseScheduledDigestResult } from "./job-adapters.js";
import {
  RunAuthoritySchema,
  RunReportDraftSchema,
  type RunAuthority,
  type RunReportDraft,
} from "./run-report.js";
import {
  startRunRecord,
  updateRunChildPid,
  type StartRunRecordOptions,
  type UpdateRunChildPidOptions,
} from "./run-state.js";
import {
  acquireObserverTaskLock,
  type AcquireObserverTaskLockOptions,
  type ObserverTaskLock,
} from "./task-lock.js";

const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;
const SAFE_ERROR_MESSAGE = "Invalid managed observer job";

const ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "CODEX_HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "__CF_USER_TEXT_ENCODING",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "GITHUB_TOKEN",
] as const;

type TerminalStatus = RunAuthority["status"];
type FailureKind =
  | "spawn"
  | "nonzero"
  | "timeout"
  | "cancelled"
  | "output-limit"
  | "invalid-result"
  | "child-error";

const FAILURE_TEXT: Readonly<
  Record<FailureKind, { readonly summary: string; readonly failure: string | null }>
> = {
  spawn: {
    summary: "任务进程无法启动",
    failure: "受管任务启动失败",
  },
  nonzero: {
    summary: "任务执行失败",
    failure: "任务进程以非零状态退出",
  },
  timeout: {
    summary: "任务执行超时",
    failure: "任务超过审计超时限制",
  },
  cancelled: {
    summary: "任务已取消",
    failure: null,
  },
  "output-limit": {
    summary: "任务执行失败",
    failure: "任务输出超过安全上限",
  },
  "invalid-result": {
    summary: "任务执行失败",
    failure: "任务未返回有效的结构化结果",
  },
  "child-error": {
    summary: "任务执行失败",
    failure: "受管任务进程发生错误",
  },
};

export interface ManagedChildProcess {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: string, listener: (...arguments_: any[]) => void): this;
  removeListener(event: string, listener: (...arguments_: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ManagedSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: ["ignore", "pipe", "pipe"];
  },
) => ManagedChildProcess;

export interface ManagedJobDependencies {
  readonly spawn?: ManagedSpawn;
  readonly uuid?: () => string;
  readonly randomUUID?: () => string;
  readonly now?: () => Date;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly startRunRecord?: (options: StartRunRecordOptions) => unknown;
  readonly updateRunChildPid?: (options: UpdateRunChildPidOptions) => unknown;
  readonly acquireTaskLock?: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
}

export interface ManagedJobOutcome {
  readonly authority: RunAuthority;
  readonly draft: RunReportDraft | null;
}

export interface RunManagedJobOptions {
  readonly projectRoot: string;
  readonly job: ObserverJob;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly dependencies?: ManagedJobDependencies;
}

interface ResolvedDependencies {
  readonly spawn: ManagedSpawn;
  readonly randomUUID: () => string;
  readonly now: () => Date;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly startRunRecord: (options: StartRunRecordOptions) => unknown;
  readonly updateRunChildPid: (options: UpdateRunChildPidOptions) => unknown;
  readonly acquireTaskLock: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
}

function safeError(): Error {
  const error = new Error(SAFE_ERROR_MESSAGE);
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function resolvedDependencies(options: RunManagedJobOptions): ResolvedDependencies {
  const supplied = options.dependencies;
  return {
    spawn:
      supplied?.spawn ??
      ((executable, arguments_, spawnOptions) =>
        nodeSpawn(executable, [...arguments_], spawnOptions) as ManagedChildProcess),
    randomUUID: supplied?.uuid ?? supplied?.randomUUID ?? randomUUID,
    now: options.now ?? supplied?.now ?? (() => new Date()),
    setTimeout: supplied?.setTimeout ?? globalThis.setTimeout,
    clearTimeout: supplied?.clearTimeout ?? globalThis.clearTimeout,
    startRunRecord: supplied?.startRunRecord ?? startRunRecord,
    updateRunChildPid: supplied?.updateRunChildPid ?? updateRunChildPid,
    acquireTaskLock: supplied?.acquireTaskLock ?? acquireObserverTaskLock,
  };
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    if (Object.hasOwn(source, name) && source[name] !== undefined) {
      environment[name] = source[name];
    }
  }
  return environment;
}

function failureDraft(kind: FailureKind): RunReportDraft {
  const text = FAILURE_TEXT[kind];
  return RunReportDraftSchema.parse({
    version: 1,
    summary: [text.summary],
    metrics: [],
    failure: text.failure,
    artifacts: [],
  });
}

function auditedInvocation(options: RunManagedJobOptions): {
  readonly projectRoot: string;
  readonly job: ObserverJob;
  readonly cwd: string;
  readonly entrypoint: string;
  readonly arguments: readonly string[];
} {
  try {
    const job = ObserverJobSchema.parse(options.job);
    const projectRoot = resolveProjectPath(options.projectRoot, ".");
    const cwd = resolveProjectPath(projectRoot, job.workingDirectory);
    const entrypoint = resolveProjectPath(projectRoot, job.entrypoint);
    const arguments_ = job.arguments.map((argument) =>
      argument === "{projectRoot}" ? projectRoot : argument,
    );
    return { projectRoot, job, cwd, entrypoint, arguments: arguments_ };
  } catch {
    throw safeError();
  }
}

function terminalStatusForFailure(kind: FailureKind): TerminalStatus {
  if (kind === "timeout") {
    return "timed-out";
  }
  if (kind === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

export async function runManagedJob(
  options: RunManagedJobOptions,
): Promise<ManagedJobOutcome> {
  const invocation = auditedInvocation(options);
  const dependencies = resolvedDependencies(options);
  const lock = await dependencies.acquireTaskLock({
    projectRoot: invocation.projectRoot,
    taskId: invocation.job.id,
  });

  try {
    const runId = dependencies.randomUUID();
    const startedAtDate = dependencies.now();
    let startedAt: string;
    try {
      startedAt = startedAtDate.toISOString();
      dependencies.startRunRecord({
        projectRoot: invocation.projectRoot,
        runId,
        job: invocation.job,
        runnerPid: process.pid,
        startedAt: startedAtDate,
      });
    } catch {
      throw safeError();
    }

    const outcome = (
      status: TerminalStatus,
      draft: RunReportDraft | null,
    ): ManagedJobOutcome => {
      try {
        const authority = RunAuthoritySchema.parse({
          runId,
          taskId: invocation.job.id,
          taskName: invocation.job.name,
          projectLabel: invocation.job.projectLabel,
          status,
          startedAt,
          finishedAt: dependencies.now().toISOString(),
        });
        return { authority, draft };
      } catch {
        throw safeError();
      }
    };

    if (options.signal?.aborted === true) {
      return outcome("cancelled", failureDraft("cancelled"));
    }

    let child: ManagedChildProcess;
    try {
      child = dependencies.spawn(
        invocation.job.executable,
        [invocation.entrypoint, ...invocation.arguments],
        {
          cwd: invocation.cwd,
          env: childEnvironment(options.environment ?? process.env),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      return outcome("failed", failureDraft("spawn"));
    }

    return await new Promise<ManagedJobOutcome>((resolve) => {
      let settled = false;
      let spawned = false;
      let exited = false;
      let terminalIntent:
        | { readonly status: TerminalStatus; readonly kind: FailureKind }
        | undefined;
      let totalOutputBytes = 0;
      let stdoutChunks: Buffer[] = [];
      let timeoutTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

      const removeDataListeners = (): void => {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
      };

      const cleanup = (): void => {
        if (timeoutTimer !== undefined) {
          dependencies.clearTimeout(timeoutTimer);
        }
        if (forceKillTimer !== undefined) {
          dependencies.clearTimeout(forceKillTimer);
        }
        options.signal?.removeEventListener("abort", onAbort);
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
        removeDataListeners();
        stdoutChunks = [];
      };

      const finish = (status: TerminalStatus, draft: RunReportDraft | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(outcome(status, draft));
      };

      const requestTermination = (kind: FailureKind): void => {
        if (settled || exited || terminalIntent !== undefined) {
          return;
        }
        terminalIntent = { status: terminalStatusForFailure(kind), kind };
        if (timeoutTimer !== undefined) {
          dependencies.clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        child.kill("SIGTERM");
        forceKillTimer = dependencies.setTimeout(() => {
          if (!settled && !exited && terminalIntent !== undefined) {
            child.kill("SIGKILL");
            finish(terminalIntent.status, failureDraft(terminalIntent.kind));
          }
        }, FORCE_KILL_DELAY_MS);
      };

      const consume = (chunk: unknown, keep: boolean): void => {
        if (settled || terminalIntent !== undefined) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        totalOutputBytes += buffer.byteLength;
        if (totalOutputBytes > MAXIMUM_OUTPUT_BYTES) {
          stdoutChunks = [];
          requestTermination("output-limit");
          return;
        }
        if (keep) {
          stdoutChunks.push(buffer);
        }
      };

      function onStdout(chunk: unknown): void {
        consume(chunk, true);
      }

      function onStderr(chunk: unknown): void {
        consume(chunk, false);
      }

      function onSpawn(): void {
        if (settled || spawned) {
          return;
        }
        spawned = true;
        const childPid = child.pid;
        if (!Number.isSafeInteger(childPid) || (childPid ?? 0) <= 0) {
          requestTermination("child-error");
          return;
        }
        try {
          dependencies.updateRunChildPid({
            projectRoot: invocation.projectRoot,
            runId,
            childPid: childPid!,
          });
        } catch {
          requestTermination("child-error");
        }
      }

      function onError(): void {
        if (settled) {
          return;
        }
        if (!spawned) {
          finish("failed", failureDraft("spawn"));
          return;
        }
        requestTermination("child-error");
      }

      function onExit(): void {
        exited = true;
        if (timeoutTimer !== undefined) {
          dependencies.clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (forceKillTimer !== undefined) {
          dependencies.clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
      }

      function onClose(code: number | null): void {
        if (settled) {
          return;
        }
        exited = true;
        if (terminalIntent !== undefined) {
          finish(terminalIntent.status, failureDraft(terminalIntent.kind));
          return;
        }
        if (code !== 0) {
          finish("failed", failureDraft("nonzero"));
          return;
        }
        try {
          const adapted = parseScheduledDigestResult(
            Buffer.concat(stdoutChunks).toString("utf8"),
          );
          finish(adapted.status, adapted.draft);
        } catch {
          finish("failed", failureDraft("invalid-result"));
        }
      }

      function onAbort(): void {
        requestTermination("cancelled");
      }

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = dependencies.setTimeout(
        () => requestTermination("timeout"),
        invocation.job.timeoutMs,
      );
      if (options.signal?.aborted === true) {
        onAbort();
      }
    });
  } finally {
    await lock.release();
  }
}
