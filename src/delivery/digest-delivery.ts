import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { z } from "zod";

import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatLoginExpiredError,
  WechatPartialDeliveryError,
} from "./wechat.js";

const MAX_LEDGER_BYTES = 32 * 1_024;
const MAX_DELIVERY_ATTEMPTS = 3;

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const DigestHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.string().datetime();

const LedgerBaseSchema = z.object({
  version: z.literal(1),
  date: DateKeySchema,
  digestSha256: DigestHashSchema,
  attempt: z.number().int().min(1).max(MAX_DELIVERY_ATTEMPTS),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const SendingLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("sending"),
}).strict();

const SentLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("sent"),
  sentAt: TimestampSchema,
  chunks: z.number().int().positive(),
}).strict();

const FailedLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("failed"),
  failureKind: z.enum(["login-expired", "rejected"]),
}).strict();

const IndeterminateLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("indeterminate"),
  confirmedChunks: z.number().int().min(0),
  loginExpired: z.boolean(),
}).strict();

const DeliveryLedgerSchema = z.discriminatedUnion("status", [
  SendingLedgerSchema,
  SentLedgerSchema,
  FailedLedgerSchema,
  IndeterminateLedgerSchema,
]);

type DeliveryLedger = z.infer<typeof DeliveryLedgerSchema>;
type SendingLedger = z.infer<typeof SendingLedgerSchema>;

export class DailyDigestAlreadySentError extends Error {
  override readonly name = "DailyDigestAlreadySentError";

  constructor() {
    super("今天的日报已经成功发送，不会重复推送");
  }
}

export class DailyDigestDeliveryBusyError extends Error {
  override readonly name = "DailyDigestDeliveryBusyError";

  constructor() {
    super("另一项日报发送正在运行，本次已退出");
  }
}

export class DailyDigestDeliveryIndeterminateError extends Error {
  override readonly name = "DailyDigestDeliveryIndeterminateError";

  constructor() {
    super("今天的日报存在无法确认的发送结果；为避免重复，已停止自动发送");
  }
}

export class DailyDigestRetryLimitError extends Error {
  override readonly name = "DailyDigestRetryLimitError";

  constructor() {
    super("今天的日报发送已达到最多三次尝试，不再自动重试");
  }
}

function deliveryDirectory(projectRoot: string): string {
  return resolveProjectPath(projectRoot, ".state", "delivery");
}

function ledgerPath(projectRoot: string, date: string): string {
  return resolveProjectPath(projectRoot, ".state", "delivery", `${date}.json`);
}

function lockPath(projectRoot: string, date: string): string {
  return resolveProjectPath(
    projectRoot,
    ".state",
    "locks",
    `delivery-${date}.lock`,
  );
}

function readLedger(projectRoot: string, date: string): DeliveryLedger | null {
  const filePath = ledgerPath(projectRoot, date);
  const raw = readProjectText(projectRoot, filePath, MAX_LEDGER_BYTES);
  if (raw === null) {
    return null;
  }
  const stat = lstatSync(assertNoSymlinkComponents(projectRoot, filePath));
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new DailyDigestDeliveryIndeterminateError();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new DailyDigestDeliveryIndeterminateError();
  }
  const parsed = DeliveryLedgerSchema.safeParse(value);
  if (!parsed.success || parsed.data.date !== date) {
    throw new DailyDigestDeliveryIndeterminateError();
  }
  return parsed.data;
}

function writeLedger(projectRoot: string, ledger: DeliveryLedger): void {
  writeProjectTextAtomic(
    projectRoot,
    ledgerPath(projectRoot, ledger.date),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

function acquireLock(projectRoot: string, date: string): () => void {
  const filePath = lockPath(projectRoot, date);
  const parent = resolveProjectPath(projectRoot, ".state", "locks");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  assertNoSymlinkComponents(projectRoot, filePath);
  let descriptor: number;
  try {
    descriptor = openSync(
      filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DailyDigestDeliveryBusyError();
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(filePath);
    } catch {
      // Only the lock created by this invocation is eligible for cleanup.
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    closeSync(descriptor);
    try {
      unlinkSync(filePath);
    } catch {
      // A stale lock is safer than permitting a duplicate delivery.
    }
  };
}

function digestHash(digest: string): string {
  return createHash("sha256").update(digest, "utf8").digest("hex");
}

function sendingLedger(
  previous: DeliveryLedger | null,
  date: string,
  hash: string,
  now: Date,
): SendingLedger {
  if (previous?.status === "sent") {
    throw new DailyDigestAlreadySentError();
  }
  if (previous?.status === "sending" || previous?.status === "indeterminate") {
    throw new DailyDigestDeliveryIndeterminateError();
  }
  const attempt = previous?.status === "failed" ? previous.attempt + 1 : 1;
  if (attempt > MAX_DELIVERY_ATTEMPTS) {
    throw new DailyDigestRetryLimitError();
  }
  const timestamp = now.toISOString();
  return {
    version: 1,
    status: "sending",
    date,
    digestSha256: hash,
    attempt,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export interface DeliverDailyDigestOptions {
  readonly projectRoot: string;
  readonly date: string;
  readonly digest: string;
  readonly send: (
    digest: string,
  ) => Promise<{ readonly status: "sent"; readonly chunks: number }>;
  readonly onConfirmedSend?: (sentAt: Date) => void | Promise<void>;
  readonly now?: () => Date;
}

export async function deliverDailyDigest(
  options: DeliverDailyDigestOptions,
): Promise<{
  readonly status: "sent";
  readonly chunks: number;
  readonly attempt: number;
}> {
  const date = DateKeySchema.parse(options.date);
  if (options.digest.length === 0 || options.digest.length > 100_000) {
    throw new RangeError("日报正文长度不在允许范围内");
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  if (!Number.isFinite(startedAt.getTime())) {
    throw new RangeError("日报发送时间无效");
  }
  mkdirSync(deliveryDirectory(options.projectRoot), {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(deliveryDirectory(options.projectRoot), 0o700);
  const release = acquireLock(options.projectRoot, date);
  try {
    const current = readLedger(options.projectRoot, date);
    const sending = sendingLedger(
      current,
      date,
      digestHash(options.digest),
      startedAt,
    );
    writeLedger(options.projectRoot, sending);
    let result: { readonly status: "sent"; readonly chunks: number };
    try {
      result = await options.send(options.digest);
    } catch (error) {
      const failedAt = now().toISOString();
      if (
        error instanceof WechatDeliveryIndeterminateError ||
        error instanceof WechatPartialDeliveryError
      ) {
        writeLedger(options.projectRoot, {
          ...sending,
          status: "indeterminate",
          updatedAt: failedAt,
          confirmedChunks:
            error instanceof WechatPartialDeliveryError
              ? error.sentChunks
              : 0,
          loginExpired:
            error instanceof WechatPartialDeliveryError
              ? error.loginExpired
              : false,
        });
      } else if (
        error instanceof WechatLoginExpiredError ||
        error instanceof WechatDeliveryRejectedError
      ) {
        writeLedger(options.projectRoot, {
          ...sending,
          status: "failed",
          updatedAt: failedAt,
          failureKind:
            error instanceof WechatLoginExpiredError
              ? "login-expired"
              : "rejected",
        });
      } else {
        writeLedger(options.projectRoot, {
          ...sending,
          status: "indeterminate",
          updatedAt: failedAt,
          confirmedChunks: 0,
          loginExpired: false,
        });
      }
      throw error;
    }
    try {
      const completedAt = now();
      if (
        !Number.isFinite(completedAt.getTime()) ||
        result.status !== "sent" ||
        !Number.isSafeInteger(result.chunks) ||
        result.chunks <= 0
      ) {
        throw new Error("invalid delivery finalization");
      }
      await options.onConfirmedSend?.(completedAt);
      const timestamp = completedAt.toISOString();
      const sent: DeliveryLedger = {
        ...sending,
        status: "sent",
        sentAt: timestamp,
        updatedAt: timestamp,
        chunks: result.chunks,
      };
      writeLedger(options.projectRoot, sent);
      return { status: "sent", chunks: result.chunks, attempt: sending.attempt };
    } catch {
      // The remote send already succeeded. Leave the durable `sending` claim in
      // place so a later run refuses to duplicate a possibly delivered digest.
      throw new DailyDigestDeliveryIndeterminateError();
    }
  } finally {
    release();
  }
}

export function publicDailyDeliveryError(error: unknown): string | null {
  if (
    error instanceof DailyDigestAlreadySentError ||
    error instanceof DailyDigestDeliveryBusyError ||
    error instanceof DailyDigestDeliveryIndeterminateError ||
    error instanceof DailyDigestRetryLimitError
  ) {
    return error.message;
  }
  return null;
}
