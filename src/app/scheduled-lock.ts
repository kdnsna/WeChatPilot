import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { z } from "zod";

import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";

const MAX_LOCK_BYTES = 4 * 1_024;

const LockRecordSchema = z
  .object({
    pid: z.number().int().positive().safe(),
    nonce: z.string().min(1).max(128),
    createdAt: z.string().datetime(),
  })
  .strict();

type LockRecord = z.infer<typeof LockRecordSchema>;

export class ScheduledRunBusyError extends Error {
  override readonly name = "ScheduledRunBusyError";

  constructor() {
    super("另一项定时日报任务正在运行，本次已退出");
  }
}

export interface ScheduledRunLock {
  readonly release: () => Promise<void>;
}

export interface AcquireScheduledRunLockOptions {
  readonly projectRoot: string;
  readonly lockName?: string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

function scheduledLockPath(projectRoot: string, lockName: string): string {
  if (!/^(?:scheduled|delivery-\d{4}-\d{2}-\d{2})\.lock$/u.test(lockName)) {
    throw new RangeError("scheduled lock name is invalid");
  }
  return resolveProjectPath(projectRoot, ".state", "locks", lockName);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readExistingLock(
  projectRoot: string,
  filePath: string,
): {
  readonly record: LockRecord;
  readonly identity: { readonly dev: number; readonly ino: number };
} {
  assertNoSymlinkComponents(projectRoot, filePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > MAX_LOCK_BYTES
    ) {
      throw new ScheduledRunBusyError();
    }
    const parsed = LockRecordSchema.safeParse(
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
    if (!parsed.success) {
      throw new ScheduledRunBusyError();
    }
    return {
      record: parsed.data,
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    if (error instanceof ScheduledRunBusyError) {
      throw error;
    }
    throw new ScheduledRunBusyError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeStaleLock(
  projectRoot: string,
  filePath: string,
  expected: { readonly dev: number; readonly ino: number },
): void {
  try {
    const stat = lstatSync(assertNoSymlinkComponents(projectRoot, filePath));
    if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(stat, expected)) {
      throw new ScheduledRunBusyError();
    }
    unlinkSync(filePath);
  } catch (error) {
    if (error instanceof ScheduledRunBusyError) {
      throw error;
    }
    throw new ScheduledRunBusyError();
  }
}

function recordStaleRecovery(projectRoot: string): void {
  const path = resolveProjectPath(projectRoot, ".state", "stability-metrics.json");
  let current = { staleLockRecoveries: 0, manualInterventions: 0 };
  try {
    const raw = readProjectText(projectRoot, path, 4_096);
    if (raw !== null) current = { ...current, ...(JSON.parse(raw) as object) };
  } catch { /* Start a fresh non-sensitive counter document. */ }
  writeProjectTextAtomic(projectRoot, path, `${JSON.stringify({
    staleLockRecoveries: Number.isSafeInteger(current.staleLockRecoveries) ? current.staleLockRecoveries + 1 : 1,
    manualInterventions: Number.isSafeInteger(current.manualInterventions) ? current.manualInterventions : 0,
  })}\n`);
}

export async function acquireScheduledRunLock(
  options: AcquireScheduledRunLockOptions,
): Promise<ScheduledRunLock> {
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("scheduled lock pid is invalid");
  }
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new RangeError("scheduled lock time is invalid");
  }
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const parent = resolveProjectPath(options.projectRoot, ".state", "locks");
  const filePath = scheduledLockPath(
    options.projectRoot,
    options.lockName ?? "scheduled.lock",
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(options.projectRoot, filePath);
  chmodSync(parent, 0o700);

  const record: LockRecord = {
    pid,
    nonce: randomUUID(),
    createdAt: createdAt.toISOString(),
  };
  let descriptor: number | undefined;
  for (let acquisitionAttempt = 1; acquisitionAttempt <= 2; acquisitionAttempt += 1) {
    try {
      descriptor = openSync(
        filePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        acquisitionAttempt >= 2
      ) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ScheduledRunBusyError();
        }
        throw error;
      }
      const existing = readExistingLock(options.projectRoot, filePath);
      if (processAlive(existing.record.pid)) {
        throw new ScheduledRunBusyError();
      }
      removeStaleLock(options.projectRoot, filePath, existing.identity);
      recordStaleRecovery(options.projectRoot);
    }
  }
  if (descriptor === undefined) {
    throw new ScheduledRunBusyError();
  }

  const identity = fstatSync(descriptor);
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      closeSync(descriptor);
      try {
        const current = lstatSync(
          assertNoSymlinkComponents(options.projectRoot, filePath),
        );
        if (current.isFile() && sameFile(current, identity)) {
          unlinkSync(filePath);
        }
      } catch {
        // Never remove an unexpected replacement. A stale lock fails closed.
      }
    },
  };
}
