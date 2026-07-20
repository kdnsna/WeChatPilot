import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
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

const TaskIdSchema = z.union([
  ObserverJobSchema.shape.id,
  z.literal("codex-wechat-observer-test"),
  z.literal("report-sequence"),
]);
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
  readonly dependencies?: TaskLockDependencies;
}

export interface TaskLockDependencies {
  readonly writeFile?: (descriptor: number, content: string) => void;
  readonly fsync?: (descriptor: number) => void;
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

function removeCreatedEmptyDirectory(
  directory: string,
  identity: LockIdentity,
): void {
  try {
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !sameIdentity(metadata, identity)
    ) {
      return;
    }
    rmdirSync(directory);
  } catch {
    // Never remove a replacement or a non-empty/pre-existing directory.
  }
}

function createPrivateLocksDirectory(projectRoot: string): string {
  const created: Array<{
    readonly directory: string;
    readonly identity: LockIdentity;
  }> = [];
  let lockDirectory = "";
  try {
    for (const segments of [[".state"], [".state", "locks"]] as const) {
      const directory = resolveProjectPath(projectRoot, ...segments);
      assertNoSymlinkComponents(projectRoot, directory);
      let createdNow = false;
      try {
        mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
        createdNow = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ObserverTaskBusyError();
        }
      }

      const initialMetadata = lstatSync(directory);
      if (initialMetadata.isSymbolicLink() || !initialMetadata.isDirectory()) {
        throw new ObserverTaskBusyError();
      }
      const identity = {
        dev: initialMetadata.dev,
        ino: initialMetadata.ino,
      };
      if (createdNow) {
        created.push({ directory, identity });
        chmodSync(directory, PRIVATE_DIRECTORY_MODE);
      }

      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const openedMetadata = fstatSync(descriptor);
        if (
          !openedMetadata.isDirectory() ||
          !sameIdentity(openedMetadata, identity)
        ) {
          throw new ObserverTaskBusyError();
        }

        fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
        const hardenedDescriptorMetadata = fstatSync(descriptor);
        if (
          !hardenedDescriptorMetadata.isDirectory() ||
          (hardenedDescriptorMetadata.mode & 0o777) !==
            PRIVATE_DIRECTORY_MODE ||
          !sameIdentity(hardenedDescriptorMetadata, identity)
        ) {
          throw new ObserverTaskBusyError();
        }

        const hardenedPathMetadata = lstatSync(
          assertNoSymlinkComponents(projectRoot, directory),
        );
        if (
          hardenedPathMetadata.isSymbolicLink() ||
          !hardenedPathMetadata.isDirectory() ||
          (hardenedPathMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
          !sameIdentity(hardenedPathMetadata, identity)
        ) {
          throw new ObserverTaskBusyError();
        }
      } finally {
        if (descriptor !== undefined) {
          closeSync(descriptor);
        }
      }
      lockDirectory = directory;
    }
    return lockDirectory;
  } catch (error) {
    for (const entry of created.reverse()) {
      removeCreatedEmptyDirectory(entry.directory, entry.identity);
    }
    if (error instanceof ObserverTaskBusyError) {
      throw error;
    }
    throw new ObserverTaskBusyError();
  }
}

function readExistingLock(
  projectRoot: string,
  path: string,
):
  | {
      readonly kind: "valid";
      readonly record: LockRecord;
      readonly identity: LockIdentity;
    }
  | { readonly kind: "recoverable-invalid"; readonly identity: LockIdentity } {
  let descriptor: number | undefined;
  try {
    const pathMetadata = lstatSync(assertNoSymlinkComponents(projectRoot, path));
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      (pathMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      pathMetadata.size > MAXIMUM_LOCK_BYTES
    ) {
      throw new ObserverTaskBusyError();
    }
    const identity = { dev: pathMetadata.dev, ino: pathMetadata.ino };
    if (pathMetadata.size === 0) {
      return { kind: "recoverable-invalid", identity };
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
    const content = readFileSync(descriptor, "utf8");
    const finalMetadata = fstatSync(descriptor);
    if (
      finalMetadata.size !== descriptorMetadata.size ||
      !sameIdentity(finalMetadata, descriptorMetadata)
    ) {
      throw new ObserverTaskBusyError();
    }
    let parsed: ReturnType<typeof LockRecordSchema.safeParse>;
    try {
      parsed = LockRecordSchema.safeParse(JSON.parse(content) as unknown);
    } catch {
      return { kind: "recoverable-invalid", identity };
    }
    if (!parsed.success) {
      return { kind: "recoverable-invalid", identity };
    }
    return {
      kind: "valid",
      record: parsed.data,
      identity,
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

  createPrivateLocksDirectory(options.projectRoot);
  const path = lockFilePath(options.projectRoot, taskId);
  const processAlive = options.isProcessAlive ?? processIsAlive;
  const writeOwner =
    options.dependencies?.writeFile ??
    ((descriptor: number, content: string) =>
      writeFileSync(descriptor, content, "utf8"));
  const syncOwner = options.dependencies?.fsync ?? fsyncSync;
  const record: LockRecord = {
    pid,
    nonce: randomUUID(),
    createdAt: createdAt.toISOString(),
    taskId,
  };
  const ownerPath = resolveProjectPath(
    options.projectRoot,
    ".state",
    "locks",
    `.observer-${taskId}.${pid}.${record.nonce}.owner`,
  );
  let descriptor: number | undefined;
  let ownerIdentity: LockIdentity | undefined;
  let published = false;
  try {
    descriptor = openSync(
      ownerPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    const initialMetadata = fstatSync(descriptor);
    ownerIdentity = { dev: initialMetadata.dev, ino: initialMetadata.ino };
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(metadata, ownerIdentity)
    ) {
      throw safeError();
    }
    writeOwner(descriptor, `${JSON.stringify(record)}\n`);
    syncOwner(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const ownerMetadata = lstatSync(ownerPath);
        if (
          !ownerMetadata.isFile() ||
          ownerMetadata.isSymbolicLink() ||
          !sameIdentity(ownerMetadata, ownerIdentity)
        ) {
          throw new ObserverTaskBusyError();
        }
        linkSync(ownerPath, path);
        published = true;
        const canonicalMetadata = lstatSync(path);
        if (
          !canonicalMetadata.isFile() ||
          canonicalMetadata.isSymbolicLink() ||
          !sameIdentity(canonicalMetadata, ownerIdentity)
        ) {
          throw new ObserverTaskBusyError();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (error instanceof ObserverTaskBusyError) {
            throw error;
          }
          throw safeError();
        }
        const existing = readExistingLock(options.projectRoot, path);
        if (existing.kind === "valid") {
          let alive = true;
          try {
            alive = processAlive(existing.record.pid);
          } catch {
            alive = true;
          }
          if (alive) {
            throw new ObserverTaskBusyError();
          }
        }
        if (!removeIfSameRegularFile(options.projectRoot, path, existing.identity)) {
          throw new ObserverTaskBusyError();
        }
      }
    }
    if (!published) {
      throw new ObserverTaskBusyError();
    }
  } catch (error) {
    if (published && ownerIdentity !== undefined) {
      removeIfSameRegularFile(options.projectRoot, path, ownerIdentity);
    }
    if (error instanceof ObserverTaskBusyError) {
      throw error;
    }
    throw safeError();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup continues through the identity-checked owner unlink below.
      }
    }
    if (ownerIdentity !== undefined) {
      removeIfSameRegularFile(options.projectRoot, ownerPath, ownerIdentity);
    }
  }

  const ownedIdentity = ownerIdentity;
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      removeIfSameRegularFile(options.projectRoot, path, ownedIdentity);
    },
  };
}

export const acquireTaskLock = acquireObserverTaskLock;
