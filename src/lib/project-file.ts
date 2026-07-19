import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, basename, join } from "node:path";

import { assertNoSymlinkComponents, assertProjectPath } from "./paths.js";

function safePath(projectRoot: string, filePath: string): string {
  return assertNoSymlinkComponents(
    projectRoot,
    assertProjectPath(projectRoot, filePath),
  );
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function readProjectText(
  projectRoot: string,
  filePath: string,
  maximumBytes: number,
): string | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }
  const target = safePath(projectRoot, filePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (fstatSync(descriptor).size > maximumBytes) {
      throw new RangeError("Project file exceeded the configured size limit");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function writeProjectBytesAtomic(
  projectRoot: string,
  filePath: string,
  content: Uint8Array,
): void {
  const target = safePath(projectRoot, filePath);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(projectRoot, target);
  chmodSync(parent, 0o700);

  const temporary = join(
    parent,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  assertNoSymlinkComponents(projectRoot, temporary);
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryExists = true;
    let written = 0;
    while (written < content.byteLength) {
      const bytesWritten = writeSync(
        descriptor,
        content,
        written,
        content.byteLength - written,
      );
      if (bytesWritten === 0) {
        throw new Error("Unable to complete private project file write");
      }
      written += bytesWritten;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    temporaryExists = false;
    const directoryDescriptor = openSync(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch {
        // Only this operation's uniquely named project-local temp file is removed.
      }
    }
  }
}

export function writeProjectTextAtomic(
  projectRoot: string,
  filePath: string,
  content: string,
): void {
  writeProjectBytesAtomic(projectRoot, filePath, Buffer.from(content, "utf8"));
}
