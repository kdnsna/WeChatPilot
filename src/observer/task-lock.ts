import { randomUUID } from "node:crypto";
import {
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
  type Stats,
} from "node:fs";

import { z } from "zod";

import { assertNoSymlinkComponents, resolveProjectPath } from "../lib/paths.js";
import { ObserverJobSchema } from "./config.js";

const MAXIMUM_LOCK_BYTES = 4 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_ERROR_MESSAGE = "Invalid observer task lock";

const TaskIdSchema = ObserverJobSchema.shape.id;
const PositivePidSchema = z.number().int().positive().safe();
const LockRecordSchema = z
  .object({
    pid: PositivePidSchema,
    nonce: z.string().min(1).max(128),
    createdAt: z.iso.datetime({ offset: true }),
    taskId: TaskIdSchema,
  })
  .strict();

type LockIdentity = Pick<Stats, "dev" | "ino">;
type LockRecord = z.infer<typeof LockRecordSchema>;

export class ObserverTaskBusyError extends Error {
  override readonly name = "ObserverTaskBusyError";

  constructor() {
    super("该观察任务正在运行");
  }
}

export interface ObserverTaskLock {
  readonly release: () => Promise<void>;
}

export interface AcquireObserverTaskLockOptions {
  readonly projectRoot: string;
  readonly taskId: z.infer<typeof TaskIdSchema>;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

function safeError(): Error {
  const error = new Error(SAFE_ERROR_MESSAGE);
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockFilePath(projectRoot: string, taskId: string): string {
  const auditedTaskId = TaskIdSchema.parse(taskId);
  return resolveProjectPath(
    projectRoot,
    ".state",
    "locks",
    `observer-${auditedTaskId}.lock`,
  );
}

function ensurePrivateLockDirectory(projectRoot: string): string {
  const stateDirectory = resolveProjectPath(projectRoot, ".state");
  const lockDirectory = resolveProjectPath(projectRoot, ".state", "locks");
  for (const directory of [stateDirectory, lockDirectory]) {
    assertNoSymlinkComponents(projectRoot, directory);
    try {
      mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ObserverTaskBusyError();
      }
    }
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new ObserverTaskBusyError();
    }
  }
  return lockDirectory;
}

function readExistingLock(
  projectRoot: string,
  path: string,
): { readonly record: LockRecord; readonly identity: LockIdentity } {
  let descriptor: number | undefined;
  try {
    const pathMetadata = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      (pathMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      pathMetadata.size <= 0 ||
      pathMetadata.size > MAXIMUM_LOCK_BYTES
    ) {
      throw new ObserverTaskBusyError();
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorMetadata = fstatSync(descriptor);
    if (
      !descriptorMetadata.isFile() ||
      (descriptorMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      descriptorMetadata.size !== pathMetadata.size ||
      !sameIdentity(descriptorMetadata, pathMetadata)
    ) {
      throw new ObserverTaskBusyError();
    }
    const parsed = LockRecordSchema.safeParse(
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
    const finalMetadata = fstatSync(descriptor);
    if (
      !parsed.success ||
      finalMetadata.size !== descriptorMetadata.size ||
      !sameIdentity(finalMetadata, descriptorMetadata)
    ) {
      throw new ObserverTaskBusyError();
    }
    return {
      record: parsed.data,
      identity: { dev: descriptorMetadata.dev, ino: descriptorMetadata.ino },
    };
  } catch (error) {
    if (error instanceof ObserverTaskBusyError) {
      throw error;
    }
    throw new ObserverTaskBusyError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeIfSameRegularFile(
  projectRoot: string,
  path: string,
  expected: LockIdentity,
): boolean {
  try {
    const metadata = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !sameIdentity(metadata, expected)
    ) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function acquireObserverTaskLock(
  options: AcquireObserverTaskLockOptions,
): Promise<ObserverTaskLock> {
  let taskId: z.infer<typeof TaskIdSchema>;
  let pid: number;
  let createdAt: Date;
  try {
    taskId = TaskIdSchema.parse(options.taskId);
    pid = PositivePidSchema.parse(options.pid ?? process.pid);
    createdAt = (options.now ?? (() => new Date()))();
    if (!Number.isFinite(createdAt.getTime())) {
      throw safeError();
    }
  } catch {
    throw safeError();
  }

  ensurePrivateLockDirectory(options.projectRoot);
  const path = lockFilePath(options.projectRoot, taskId);
  const processAlive = options.isProcessAlive ?? processIsAlive;
  const record: LockRecord = {
    pid,
    nonce: randomUUID(),
    createdAt: createdAt.toISOString(),
    taskId,
  };

  let descriptor: number | undefined;
  let identity: LockIdentity | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      const metadata = fstatSync(descriptor);
      identity = { dev: metadata.dev, ino: metadata.ino };
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        if (identity !== undefined) {
          removeIfSameRegularFile(options.projectRoot, path, identity);
          identity = undefined;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ObserverTaskBusyError();
        }
        throw safeError();
      }
      const existing = readExistingLock(options.projectRoot, path);
      let alive = true;
      try {
        alive = processAlive(existing.record.pid);
      } catch {
        alive = true;
      }
      if (alive || !removeIfSameRegularFile(options.projectRoot, path, existing.identity)) {
        throw new ObserverTaskBusyError();
      }
    }
  }

  if (descriptor === undefined || identity === undefined) {
    throw new ObserverTaskBusyError();
  }

  const ownedDescriptor = descriptor;
  const ownedIdentity = identity;
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      closeSync(ownedDescriptor);
      removeIfSameRegularFile(options.projectRoot, path, ownedIdentity);
    },
  };
}

export const acquireTaskLock = acquireObserverTaskLock;
