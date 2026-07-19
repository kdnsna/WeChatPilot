import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets } from "../security/redact.js";
import { assertNoSymlinkComponents, assertProjectPath } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface JsonlLoggerOptions {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly now?: () => Date;
}

export interface JsonlLogger {
  log(level: LogLevel, message: string, context?: unknown): Promise<void>;
  debug(message: string, context?: unknown): Promise<void>;
  info(message: string, context?: unknown): Promise<void>;
  warn(message: string, context?: unknown): Promise<void>;
  error(message: string, context?: unknown): Promise<void>;
}

export class LoggerError extends Error {
  override readonly name = "LoggerError";

  constructor() {
    super("Unable to append the structured log record safely");
  }
}

async function appendRecord(
  projectRoot: string,
  filePath: string,
  serialized: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const safeFilePath = assertNoSymlinkComponents(
      projectRoot,
      assertProjectPath(projectRoot, filePath),
    );
    const parentDirectory = dirname(safeFilePath);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(projectRoot, safeFilePath);
    await chmod(parentDirectory, 0o700);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(
      safeFilePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.appendFile(`${serialized}\n`, "utf8");
  } catch {
    throw new LoggerError();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // A close failure cannot safely include local path or record details.
      }
    }
  }
}

export function createJsonlLogger(options: JsonlLoggerOptions): JsonlLogger {
  const now = options.now ?? (() => new Date());
  let pendingWrite: Promise<void> = Promise.resolve();

  function log(
    level: LogLevel,
    message: string,
    context?: unknown,
  ): Promise<void> {
    const write = pendingWrite.then(async () => {
      let serialized: string;
      try {
        const timestamp = now().toISOString();
        const record: {
          timestamp: string;
          level: LogLevel;
          message: string;
          context?: unknown;
        } = { timestamp, level, message };
        if (context !== undefined) {
          record.context = context;
        }
        serialized = JSON.stringify(redactSecrets(record));
      } catch {
        throw new LoggerError();
      }
      await appendRecord(options.projectRoot, options.filePath, serialized);
    });
    pendingWrite = write.catch(() => undefined);
    return write;
  }

  return {
    log,
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}
