import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { writeProjectTextAtomic } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import { sanitizeReportText } from "../observer/report-policy.js";
import { RunReportSchema, type RunReport } from "../observer/run-report.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatLoginExpiredError,
  WechatPartialDeliveryError,
} from "./wechat.js";
import { WechatMediaPreparationError } from "./wechat-media.js";

const MAX_LEDGER_BYTES = 32 * 1_024;
const MAX_LOCK_BYTES = 4 * 1_024;
const MAX_ATTEMPTS = 3;
const MAX_TEXT_CHARACTERS = 1_800;
const MAX_PROJECT_LABEL_CHARACTERS = 96;
const MAX_TASK_NAME_CHARACTERS = 160;

const RunIdSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });

const LedgerBaseSchema = z.object({
  version: z.literal(1),
  runId: RunIdSchema,
  reportSha256: HashSchema,
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  textAttempt: z.number().int().min(0).max(MAX_ATTEMPTS),
  imageAttempt: z.number().int().min(0).max(MAX_ATTEMPTS),
});

const TextSendingLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("text-sending"),
  textAttempt: z.number().int().min(1).max(MAX_ATTEMPTS),
}).strict().refine((ledger) => ledger.imageAttempt === 0, "invalid ledger attempts");

const TextSentLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("text-sent"),
  textAttempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  textChunks: z.number().int().positive().safe(),
}).strict().refine((ledger) => ledger.imageAttempt === 0, "invalid ledger attempts");

const ImageSendingLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("image-sending"),
  textAttempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  imageAttempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  textChunks: z.number().int().positive().safe(),
}).strict();

const FailedLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("failed"),
  failedPart: z.enum(["text", "image"]),
  failureKind: z.enum([
    "rejected",
    "login-expired",
    "media-preparation",
  ]),
  textChunks: z.number().int().positive().safe().optional(),
}).strict().superRefine((ledger, context) => {
  if (ledger.failedPart === "text" && ledger.textChunks !== undefined) {
    context.addIssue({ code: "custom", path: ["textChunks"], message: "invalid" });
  }
  if (ledger.failedPart === "image" && ledger.textChunks === undefined) {
    context.addIssue({ code: "custom", path: ["textChunks"], message: "invalid" });
  }
  if (
    (ledger.failedPart === "text" && ledger.imageAttempt !== 0) ||
    (ledger.failedPart === "image" &&
      (ledger.textAttempt < 1 || ledger.imageAttempt < 1)) ||
    (ledger.failureKind === "media-preparation" && ledger.failedPart !== "image")
  ) {
    context.addIssue({ code: "custom", path: ["failedPart"], message: "invalid" });
  }
});

const IndeterminateLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("indeterminate"),
  uncertainPart: z.enum(["text", "image"]),
  textChunks: z.number().int().positive().safe().optional(),
}).strict().superRefine((ledger, context) => {
  if (ledger.uncertainPart === "text" && ledger.textChunks !== undefined) {
    context.addIssue({ code: "custom", path: ["textChunks"], message: "invalid" });
  }
  if (ledger.uncertainPart === "image" && ledger.textChunks === undefined) {
    context.addIssue({ code: "custom", path: ["textChunks"], message: "invalid" });
  }
  if (
    (ledger.uncertainPart === "text" && ledger.imageAttempt !== 0) ||
    (ledger.uncertainPart === "image" &&
      (ledger.textAttempt < 1 || ledger.imageAttempt < 1))
  ) {
    context.addIssue({ code: "custom", path: ["uncertainPart"], message: "invalid" });
  }
});

const SentLedgerSchema = LedgerBaseSchema.extend({
  status: z.literal("sent"),
  sentAt: TimestampSchema,
  textAttempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  textChunks: z.number().int().positive().safe(),
  image: z.enum(["sent", "not-generated"]),
}).strict().superRefine((ledger, context) => {
  if (
    (ledger.image === "not-generated" && ledger.imageAttempt !== 0) ||
    (ledger.image === "sent" && ledger.imageAttempt < 1)
  ) {
    context.addIssue({ code: "custom", path: ["image"], message: "invalid" });
  }
});

const DeliveryLedgerSchema = z.union([
  TextSendingLedgerSchema,
  TextSentLedgerSchema,
  ImageSendingLedgerSchema,
  FailedLedgerSchema,
  IndeterminateLedgerSchema,
  SentLedgerSchema,
]);

type DeliveryLedger = z.infer<typeof DeliveryLedgerSchema>;
type TextSentLedger = z.infer<typeof TextSentLedgerSchema>;

const LockRecordSchema = z.object({
  pid: z.number().int().positive().safe(),
  nonce: z.string().uuid(),
  createdAt: TimestampSchema,
}).strict();

type LockRecord = z.infer<typeof LockRecordSchema>;

const GuardRecordSchema = LockRecordSchema.extend({
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
}).strict();

type GuardRecord = z.infer<typeof GuardRecordSchema>;

const INDETERMINATE_MESSAGE =
  "运行报告存在无法确认的发送结果；为避免重复，已停止自动发送";

export class RunReportAlreadySentError extends Error {
  override readonly name = "RunReportAlreadySentError";
  constructor() {
    super("运行报告已成功发送，不会重复推送");
  }
}

export class RunReportDeliveryBusyError extends Error {
  override readonly name = "RunReportDeliveryBusyError";
  constructor() {
    super("另一项运行报告发送正在进行，本次已退出");
  }
}

export class RunReportDeliveryIndeterminateError extends Error {
  override readonly name = "RunReportDeliveryIndeterminateError";
  constructor() {
    super(INDETERMINATE_MESSAGE);
  }
}

export class RunReportRetryLimitError extends Error {
  override readonly name = "RunReportRetryLimitError";
  constructor() {
    super("运行报告发送已达到最多三次尝试，不再自动重试");
  }
}

export class RunReportDeliveryBlockedError extends Error {
  override readonly name = "RunReportDeliveryBlockedError";
  constructor() {
    super("运行报告发送需要人工处理，不会自动重试");
  }
}

export type RunDeliveryDisposition =
  | "missing"
  | "retryable"
  | "sent"
  | "indeterminate"
  | "blocked";

export interface DeliverRunReportResult {
  readonly status: "sent";
  readonly textChunks: number;
  readonly image: "sent" | "not-generated";
  readonly textAttempt: number;
  readonly imageAttempt: number;
}

export interface DeliverRunReportOptions {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly imagePath?: string;
  readonly sendText: (
    text: string,
  ) => Promise<{ readonly status: "sent"; readonly chunks: number }>;
  readonly sendImage: (
    imagePath: string,
  ) => Promise<{ readonly status: "sent" }>;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

interface ReadLedgerResult {
  readonly kind: "missing" | "valid" | "invalid";
  readonly ledger?: DeliveryLedger;
}

function deliveryRunsDirectory(projectRoot: string): string {
  return resolveProjectPath(projectRoot, ".state", "delivery", "runs");
}

function ledgerPath(projectRoot: string, runId: string): string {
  return resolveProjectPath(
    projectRoot,
    ".state",
    "delivery",
    "runs",
    `${runId}.json`,
  );
}

function lockPath(projectRoot: string, runId: string): string {
  return resolveProjectPath(
    projectRoot,
    ".state",
    "locks",
    `report-delivery-${runId}.lock`,
  );
}

function ensurePrivateDirectory(projectRoot: string, ...segments: string[]): string {
  try {
    const directory = resolveProjectPath(projectRoot, ...segments);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(projectRoot, directory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RunReportDeliveryIndeterminateError();
    }
    chmodSync(directory, 0o700);
    return directory;
  } catch (error) {
    if (error instanceof RunReportDeliveryIndeterminateError) {
      throw error;
    }
    throw new RunReportDeliveryIndeterminateError();
  }
}

function ensureStateDirectories(projectRoot: string): void {
  ensurePrivateDirectory(projectRoot, ".state");
  ensurePrivateDirectory(projectRoot, ".state", "delivery");
  ensurePrivateDirectory(projectRoot, ".state", "delivery", "runs");
  ensurePrivateDirectory(projectRoot, ".state", "locks");
}

function readLedger(
  projectRoot: string,
  runId: string,
  expectedHash?: string,
): ReadLedgerResult {
  let filePath: string;
  try {
    filePath = ledgerPath(projectRoot, runId);
  } catch {
    return { kind: "invalid" };
  }
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(assertNoSymlinkComponents(projectRoot, filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid" };
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size <= 0 ||
    before.size > MAX_LEDGER_BYTES
  ) {
    return { kind: "invalid" };
  }
  let descriptor: number | undefined;
  let raw: string;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !sameFile(opened, before) ||
      !opened.isFile() ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== before.size
    ) {
      return { kind: "invalid" };
    }
    const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (count === 0) {
        break;
      }
      total += count;
    }
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(assertNoSymlinkComponents(projectRoot, filePath));
    if (
      total > MAX_LEDGER_BYTES ||
      total !== opened.size ||
      !sameFile(after, opened) ||
      !sameFile(finalPath, opened) ||
      !after.isFile() ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      (after.mode & 0o777) !== 0o600 ||
      (finalPath.mode & 0o777) !== 0o600 ||
      after.size !== opened.size ||
      finalPath.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      return { kind: "invalid" };
    }
    raw = buffer.subarray(0, total).toString("utf8");
  } catch {
    return { kind: "invalid" };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  const parsed = DeliveryLedgerSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.runId !== runId ||
    (expectedHash !== undefined && parsed.data.reportSha256 !== expectedHash)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", ledger: parsed.data };
}

function writeLedger(projectRoot: string, ledger: DeliveryLedger): void {
  writeProjectTextAtomic(
    projectRoot,
    ledgerPath(projectRoot, ledger.runId),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

function writeAfterAttempt(projectRoot: string, ledger: DeliveryLedger): void {
  try {
    writeLedger(projectRoot, ledger);
  } catch {
    throw new RunReportDeliveryIndeterminateError();
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function runReportSha256(report: RunReport): string {
  const parsed = RunReportSchema.parse(report);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(parsed)), "utf8")
    .digest("hex");
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new RunReportDeliveryIndeterminateError();
  }
  return value.toISOString();
}

function truncate(value: string, maximum: number): string {
  const characters = [...value.replace(/[\r\n]+/gu, " ").trim()];
  if (characters.length <= maximum) {
    return characters.join("");
  }
  return `${characters.slice(0, maximum - 1).join("")}…`;
}

function safeAuthorityText(
  value: string,
  maximumCharacters: number,
  fallback: string,
): string {
  return (
    sanitizeReportText(value, { projectRoot: "", maximumCharacters }) ??
    fallback
  );
}

export function formatRunReportText(report: RunReport): string {
  const parsed = RunReportSchema.parse(report);
  const projectLabel = safeAuthorityText(
    parsed.projectLabel,
    MAX_PROJECT_LABEL_CHARACTERS,
    "未命名项目",
  );
  const taskName = safeAuthorityText(
    parsed.taskName,
    MAX_TASK_NAME_CHARACTERS,
    "未命名任务",
  );
  const status = {
    success: "成功",
    failed: "失败",
    "timed-out": "超时",
    cancelled: "已取消",
    interrupted: "中断",
    skipped: "已跳过",
  }[parsed.status];
  const prefix = [
    `运行报告｜${projectLabel}`,
    `任务：${taskName}`,
    `状态：${status}｜运行：${parsed.runId.slice(0, 8)}｜耗时：${parsed.durationMs} ms`,
  ];
  const used = [...prefix.join("\n")].length + 1;
  const summary = truncate(
    parsed.summary.join("；"),
    Math.max(2, MAX_TEXT_CHARACTERS - used - [..."摘要："].length),
  );
  return [...prefix, `摘要：${summary}`].join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function existingLock(
  projectRoot: string,
  filePath: string,
): {
  readonly record: LockRecord;
  readonly identity: { readonly dev: number; readonly ino: number };
} {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      assertNoSymlinkComponents(projectRoot, filePath),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size <= 0 ||
      opened.size > MAX_LOCK_BYTES
    ) {
      throw new RunReportDeliveryBusyError();
    }
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (count === 0) {
        break;
      }
      total += count;
    }
    const final = fstatSync(descriptor);
    if (
      total > MAX_LOCK_BYTES ||
      total !== opened.size ||
      !sameFile(final, opened) ||
      !final.isFile() ||
      (final.mode & 0o777) !== 0o600 ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new RunReportDeliveryBusyError();
    }
    const parsed = LockRecordSchema.safeParse(
      JSON.parse(buffer.subarray(0, total).toString("utf8")) as unknown,
    );
    if (!parsed.success) {
      throw new RunReportDeliveryBusyError();
    }
    return {
      record: parsed.data,
      identity: { dev: opened.dev, ino: opened.ino },
    };
  } catch (error) {
    if (error instanceof RunReportDeliveryBusyError) {
      throw error;
    }
    throw new RunReportDeliveryBusyError();
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
      throw new RunReportDeliveryBusyError();
    }
    unlinkSync(filePath);
  } catch (error) {
    if (error instanceof RunReportDeliveryBusyError) {
      throw error;
    }
    throw new RunReportDeliveryBusyError();
  }
}

function acquisitionGuardPath(filePath: string): string {
  return `${filePath}.acquire`;
}

function guardOwnerPath(guardPath: string, nonce: string): string {
  return `${guardPath}.owner-${nonce}`;
}

function guardClaimPath(guardPath: string, nonce: string): string {
  return `${guardPath}.claim-${nonce}-${randomUUID()}`;
}

function removeOwnedPath(
  projectRoot: string,
  filePath: string,
  expected: { readonly dev: number; readonly ino: number },
): void {
  try {
    const current = lstatSync(assertNoSymlinkComponents(projectRoot, filePath));
    if (current.isFile() && !current.isSymbolicLink() && sameFile(current, expected)) {
      unlinkSync(filePath);
    }
  } catch {
    // Missing or replaced paths are deliberately left untouched.
  }
}

function readGuard(
  projectRoot: string,
  guardPath: string,
): {
  readonly record: GuardRecord;
  readonly identity: { readonly dev: number; readonly ino: number };
} {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      assertNoSymlinkComponents(projectRoot, guardPath),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size <= 0 ||
      stat.size > MAX_LOCK_BYTES
    ) {
      throw new RunReportDeliveryBusyError();
    }
    const parsed = GuardRecordSchema.safeParse(
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
    const finalStat = fstatSync(descriptor);
    const finalPath = lstatSync(assertNoSymlinkComponents(projectRoot, guardPath));
    if (
      !parsed.success ||
      parsed.data.dev !== stat.dev ||
      parsed.data.ino !== stat.ino ||
      !sameFile(finalStat, stat) ||
      !sameFile(finalPath, stat) ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs
    ) {
      throw new RunReportDeliveryBusyError();
    }
    return {
      record: parsed.data,
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    if (error instanceof RunReportDeliveryBusyError) {
      throw error;
    }
    throw new RunReportDeliveryBusyError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function findGuardRecoverySource(
  projectRoot: string,
  guardPath: string,
  record: GuardRecord,
  expected: { readonly dev: number; readonly ino: number },
): string {
  const ownerName = basename(guardOwnerPath(guardPath, record.nonce));
  const claimPrefix = `${basename(guardPath)}.claim-${record.nonce}-`;
  const candidates = readdirSync(dirname(guardPath))
    .filter((entry) => entry === ownerName || entry.startsWith(claimPrefix))
    .map((entry) => join(dirname(guardPath), entry))
    .filter((candidate) => {
      try {
        const stat = lstatSync(assertNoSymlinkComponents(projectRoot, candidate));
        return stat.isFile() && !stat.isSymbolicLink() && sameFile(stat, expected);
      } catch {
        return false;
      }
    });
  if (candidates.length !== 1) {
    throw new RunReportDeliveryBusyError();
  }
  return candidates[0]!;
}

function recoverGuard(
  projectRoot: string,
  guardPath: string,
  current: {
    readonly record: GuardRecord;
    readonly identity: { readonly dev: number; readonly ino: number };
  },
): boolean {
  let source: string;
  try {
    source = findGuardRecoverySource(
      projectRoot,
      guardPath,
      current.record,
      current.identity,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const claim = guardClaimPath(guardPath, current.record.nonce);
  try {
    renameSync(source, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new RunReportDeliveryBusyError();
  }
  try {
    const claimed = lstatSync(assertNoSymlinkComponents(projectRoot, claim));
    const fixed = lstatSync(assertNoSymlinkComponents(projectRoot, guardPath));
    if (
      !claimed.isFile() ||
      claimed.isSymbolicLink() ||
      !sameFile(claimed, current.identity) ||
      !fixed.isFile() ||
      fixed.isSymbolicLink() ||
      !sameFile(fixed, current.identity)
    ) {
      throw new RunReportDeliveryBusyError();
    }
    unlinkSync(guardPath);
    return true;
  } catch (error) {
    if (error instanceof RunReportDeliveryBusyError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new RunReportDeliveryBusyError();
  } finally {
    removeOwnedPath(projectRoot, claim, current.identity);
  }
}

function acquireAcquisitionGuard(options: {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly pid: number;
  readonly processAlive: (pid: number) => boolean;
}): () => void {
  const guardPath = acquisitionGuardPath(options.filePath);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const nonce = randomUUID();
    const ownerPath = guardOwnerPath(guardPath, nonce);
    let descriptor: number | undefined;
    let identity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      descriptor = openSync(
        assertNoSymlinkComponents(options.projectRoot, ownerPath),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const stat = fstatSync(descriptor);
      identity = { dev: stat.dev, ino: stat.ino };
      const record: GuardRecord = {
        pid: options.pid,
        nonce,
        createdAt: options.createdAt,
        dev: stat.dev,
        ino: stat.ino,
      };
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      linkSync(ownerPath, guardPath);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        removeOwnedPath(options.projectRoot, guardPath, identity!);
        closeSync(descriptor!);
        descriptor = undefined;
        removeOwnedPath(options.projectRoot, ownerPath, identity!);
      };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
      if (identity !== undefined) {
        removeOwnedPath(options.projectRoot, ownerPath, identity);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const current = readGuard(options.projectRoot, guardPath);
      if (options.processAlive(current.record.pid)) {
        throw new RunReportDeliveryBusyError();
      }
      if (!recoverGuard(options.projectRoot, guardPath, current)) {
        continue;
      }
    }
  }
  throw new RunReportDeliveryBusyError();
}

function acquireLock(options: {
  readonly projectRoot: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly pid: number;
  readonly processAlive: (pid: number) => boolean;
}): () => void {
  const filePath = lockPath(options.projectRoot, options.runId);
  const releaseAcquisitionGuard = acquireAcquisitionGuard({
    projectRoot: options.projectRoot,
    filePath,
    createdAt: options.createdAt,
    pid: options.pid,
    processAlive: options.processAlive,
  });
  const record: LockRecord = {
    pid: options.pid,
    nonce: randomUUID(),
    createdAt: options.createdAt,
  };
  let descriptor: number | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        descriptor = openSync(
          assertNoSymlinkComponents(options.projectRoot, filePath),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const stat = fstatSync(descriptor);
        identity = { dev: stat.dev, ino: stat.ino };
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
        fsyncSync(descriptor);
        break;
      } catch (error) {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          descriptor = undefined;
        }
        if (identity !== undefined) {
          removeOwnedPath(options.projectRoot, filePath, identity);
          identity = undefined;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 2) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new RunReportDeliveryBusyError();
          }
          throw error;
        }
        const current = existingLock(options.projectRoot, filePath);
        if (options.processAlive(current.record.pid)) {
          throw new RunReportDeliveryBusyError();
        }
        removeStaleLock(options.projectRoot, filePath, current.identity);
      }
    }
  } finally {
    releaseAcquisitionGuard();
  }
  if (descriptor === undefined) {
    throw new RunReportDeliveryBusyError();
  }
  const acquiredIdentity = identity ?? fstatSync(descriptor);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    closeSync(descriptor);
    try {
      const current = lstatSync(
        assertNoSymlinkComponents(options.projectRoot, filePath),
      );
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        sameFile(current, acquiredIdentity)
      ) {
        unlinkSync(filePath);
      }
    } catch {
      // A replacement or stale lock is safer than deleting another owner's lock.
    }
  };
}

function disposition(ledger: DeliveryLedger): RunDeliveryDisposition {
  if (ledger.status === "sent") {
    return "sent";
  }
  if (
    ledger.status === "indeterminate" ||
    ledger.status === "text-sending" ||
    ledger.status === "image-sending"
  ) {
    return "indeterminate";
  }
  if (ledger.status === "text-sent") {
    return "retryable";
  }
  if (ledger.failureKind !== "rejected") {
    return "blocked";
  }
  const attempts =
    ledger.failedPart === "text" ? ledger.textAttempt : ledger.imageAttempt;
  return attempts < MAX_ATTEMPTS ? "retryable" : "blocked";
}

export function runDeliveryDisposition(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
}): RunDeliveryDisposition {
  let parsed: RunReport;
  let hash: string;
  try {
    parsed = RunReportSchema.parse(options.report);
    hash = runReportSha256(parsed);
  } catch {
    return "indeterminate";
  }
  const current = readLedger(options.projectRoot, parsed.runId, hash);
  if (current.kind === "missing") {
    return "missing";
  }
  if (current.kind === "invalid" || current.ledger === undefined) {
    return "indeterminate";
  }
  return disposition(current.ledger);
}

export function inspectRunDeliveryState(options: {
  readonly projectRoot: string;
  readonly reports?: readonly RunReport[];
}): { readonly pending: number; readonly indeterminate: number; readonly invalid: number } {
  let pending = 0;
  let indeterminate = 0;
  let invalid = 0;
  const finalReports = new Map<string, RunReport>();
  const finalRunIds = new Set<string>();
  const conflictingRunIds = new Set<string>();
  for (const candidate of options.reports ?? []) {
    const parsed = RunReportSchema.safeParse(candidate);
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    finalRunIds.add(parsed.data.runId);
    if (conflictingRunIds.has(parsed.data.runId)) {
      continue;
    }
    const previous = finalReports.get(parsed.data.runId);
    if (
      previous !== undefined &&
      runReportSha256(previous) !== runReportSha256(parsed.data)
    ) {
      invalid += 1;
      finalReports.delete(parsed.data.runId);
      conflictingRunIds.add(parsed.data.runId);
      continue;
    }
    finalReports.set(parsed.data.runId, parsed.data);
  }

  let entries: string[];
  try {
    const directory = deliveryRunsDirectory(options.projectRoot);
    const stat = lstatSync(assertNoSymlinkComponents(options.projectRoot, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      return { pending, indeterminate, invalid: invalid + 1 };
    }
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        pending: pending + finalReports.size,
        indeterminate,
        invalid,
      };
    }
    return { pending, indeterminate, invalid: invalid + 1 };
  }

  for (const final of finalReports.values()) {
    const current = readLedger(
      options.projectRoot,
      final.runId,
      runReportSha256(final),
    );
    if (current.kind === "invalid") {
      invalid += 1;
    } else if (current.kind === "missing") {
      pending += 1;
    } else if (current.ledger !== undefined) {
      const state = disposition(current.ledger);
      if (state === "retryable" || state === "blocked") {
        pending += 1;
      } else if (state === "indeterminate") {
        indeterminate += 1;
      }
    }
  }

  for (const entry of entries) {
    const match = /^([0-9a-f-]{36})\.json$/u.exec(entry);
    if (match?.[1] === undefined || !RunIdSchema.safeParse(match[1]).success) {
      invalid += 1;
      continue;
    }
    if (finalRunIds.has(match[1])) {
      continue;
    }
    const current = readLedger(options.projectRoot, match[1]);
    if (current.kind !== "valid" || current.ledger === undefined) {
      invalid += 1;
      continue;
    }
    const state = disposition(current.ledger);
    if (state === "retryable" || state === "blocked") {
      pending += 1;
    } else if (state === "indeterminate") {
      indeterminate += 1;
    }
  }
  return { pending, indeterminate, invalid };
}

function validatedSendResult(
  result: { readonly status: "sent"; readonly chunks: number },
): number {
  if (
    result.status !== "sent" ||
    !Number.isSafeInteger(result.chunks) ||
    result.chunks <= 0
  ) {
    throw new WechatDeliveryIndeterminateError();
  }
  return result.chunks;
}

function failedLedger(
  ledger: DeliveryLedger,
  failedPart: "text" | "image",
  failureKind: "rejected" | "login-expired" | "media-preparation",
  updatedAt: string,
  textChunks?: number,
): DeliveryLedger {
  return {
    version: 1,
    status: "failed",
    runId: ledger.runId,
    reportSha256: ledger.reportSha256,
    startedAt: ledger.startedAt,
    updatedAt,
    textAttempt: ledger.textAttempt,
    imageAttempt: ledger.imageAttempt,
    failedPart,
    failureKind,
    ...(textChunks === undefined ? {} : { textChunks }),
  };
}

function indeterminateLedger(
  ledger: DeliveryLedger,
  uncertainPart: "text" | "image",
  updatedAt: string,
  textChunks?: number,
): DeliveryLedger {
  return {
    version: 1,
    status: "indeterminate",
    runId: ledger.runId,
    reportSha256: ledger.reportSha256,
    startedAt: ledger.startedAt,
    updatedAt,
    textAttempt: ledger.textAttempt,
    imageAttempt: ledger.imageAttempt,
    uncertainPart,
    ...(textChunks === undefined ? {} : { textChunks }),
  };
}

function isFixedWechatError(error: unknown): boolean {
  return (
    error instanceof WechatDeliveryRejectedError ||
    error instanceof WechatLoginExpiredError ||
    error instanceof WechatDeliveryIndeterminateError ||
    error instanceof WechatPartialDeliveryError ||
    error instanceof WechatMediaPreparationError
  );
}

export async function deliverRunReport(
  options: DeliverRunReportOptions,
): Promise<DeliverRunReportResult> {
  const report = RunReportSchema.parse(options.report);
  const hash = runReportSha256(report);
  const now = options.now ?? (() => new Date());
  const startedAt = timestamp(now);
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("run delivery pid is invalid");
  }
  ensureStateDirectories(options.projectRoot);
  const release = acquireLock({
    projectRoot: options.projectRoot,
    runId: report.runId,
    createdAt: startedAt,
    pid,
    processAlive: options.isProcessAlive ?? isProcessAlive,
  });
  try {
    const read = readLedger(options.projectRoot, report.runId, hash);
    if (read.kind === "invalid") {
      throw new RunReportDeliveryIndeterminateError();
    }
    let current = read.ledger;
    if (current?.status === "sent") {
      throw new RunReportAlreadySentError();
    }
    if (current?.status === "text-sending" || current?.status === "image-sending") {
      const uncertainPart = current.status === "text-sending" ? "text" : "image";
      const uncertain = indeterminateLedger(
        current,
        uncertainPart,
        timestamp(now),
        current.status === "image-sending" ? current.textChunks : undefined,
      );
      writeAfterAttempt(options.projectRoot, uncertain);
      throw new RunReportDeliveryIndeterminateError();
    }
    if (current?.status === "indeterminate") {
      throw new RunReportDeliveryIndeterminateError();
    }
    if (current?.status === "failed") {
      if (current.failureKind !== "rejected") {
        throw new RunReportDeliveryBlockedError();
      }
      const attempts =
        current.failedPart === "text" ? current.textAttempt : current.imageAttempt;
      if (attempts >= MAX_ATTEMPTS) {
        throw new RunReportRetryLimitError();
      }
    }

    let textSent: TextSentLedger;
    if (
      current?.status === "text-sent" ||
      (current?.status === "failed" && current.failedPart === "image")
    ) {
      if (current.textChunks === undefined) {
        throw new RunReportDeliveryIndeterminateError();
      }
      textSent = {
        version: 1,
        status: "text-sent",
        runId: current.runId,
        reportSha256: current.reportSha256,
        startedAt: current.startedAt,
        updatedAt: current.updatedAt,
        textAttempt: current.textAttempt,
        imageAttempt: current.imageAttempt,
        textChunks: current.textChunks,
      };
    } else {
      const previousTextAttempt =
        current?.status === "failed" && current.failedPart === "text"
          ? current.textAttempt
          : 0;
      const sending: DeliveryLedger = {
        version: 1,
        status: "text-sending",
        runId: report.runId,
        reportSha256: hash,
        startedAt: current?.startedAt ?? startedAt,
        updatedAt: timestamp(now),
        textAttempt: previousTextAttempt + 1,
        imageAttempt: 0,
      };
      writeLedger(options.projectRoot, sending);
      let chunks: number;
      try {
        chunks = validatedSendResult(await options.sendText(formatRunReportText(report)));
      } catch (error) {
        const updatedAt = timestamp(now);
        if (error instanceof WechatDeliveryRejectedError) {
          writeAfterAttempt(
            options.projectRoot,
            failedLedger(sending, "text", "rejected", updatedAt),
          );
        } else if (error instanceof WechatLoginExpiredError) {
          writeAfterAttempt(
            options.projectRoot,
            failedLedger(sending, "text", "login-expired", updatedAt),
          );
        } else {
          writeAfterAttempt(
            options.projectRoot,
            indeterminateLedger(sending, "text", updatedAt),
          );
        }
        if (isFixedWechatError(error)) {
          throw error;
        }
        throw new RunReportDeliveryIndeterminateError();
      }
      textSent = {
        ...sending,
        status: "text-sent",
        updatedAt: timestamp(now),
        textChunks: chunks,
      };
      writeAfterAttempt(options.projectRoot, textSent);
      current = textSent;
    }

    if (options.imagePath === undefined) {
      if (textSent.imageAttempt > 0) {
        writeAfterAttempt(
          options.projectRoot,
          failedLedger(
            textSent,
            "image",
            "media-preparation",
            timestamp(now),
            textSent.textChunks,
          ),
        );
        throw new WechatMediaPreparationError();
      }
      const sentAt = timestamp(now);
      const sent: DeliveryLedger = {
        ...textSent,
        status: "sent",
        updatedAt: sentAt,
        sentAt,
        image: "not-generated",
      };
      writeAfterAttempt(options.projectRoot, sent);
      return {
        status: "sent",
        textChunks: sent.textChunks,
        image: sent.image,
        textAttempt: sent.textAttempt,
        imageAttempt: sent.imageAttempt,
      };
    }

    const previousImageAttempt =
      current?.status === "failed" && current.failedPart === "image"
        ? current.imageAttempt
        : textSent.imageAttempt;
    const imageSending: DeliveryLedger = {
      ...textSent,
      status: "image-sending",
      updatedAt: timestamp(now),
      imageAttempt: previousImageAttempt + 1,
    };
    writeLedger(options.projectRoot, imageSending);
    try {
      const result = await options.sendImage(options.imagePath);
      if (result.status !== "sent") {
        throw new WechatDeliveryIndeterminateError();
      }
    } catch (error) {
      const updatedAt = timestamp(now);
      if (error instanceof WechatDeliveryRejectedError) {
        writeAfterAttempt(
          options.projectRoot,
          failedLedger(
            imageSending,
            "image",
            "rejected",
            updatedAt,
            textSent.textChunks,
          ),
        );
      } else if (error instanceof WechatLoginExpiredError) {
        writeAfterAttempt(
          options.projectRoot,
          failedLedger(
            imageSending,
            "image",
            "login-expired",
            updatedAt,
            textSent.textChunks,
          ),
        );
      } else if (error instanceof WechatMediaPreparationError) {
        writeAfterAttempt(
          options.projectRoot,
          failedLedger(
            imageSending,
            "image",
            "media-preparation",
            updatedAt,
            textSent.textChunks,
          ),
        );
      } else {
        writeAfterAttempt(
          options.projectRoot,
          indeterminateLedger(
            imageSending,
            "image",
            updatedAt,
            textSent.textChunks,
          ),
        );
      }
      if (isFixedWechatError(error)) {
        throw error;
      }
      throw new RunReportDeliveryIndeterminateError();
    }
    const sentAt = timestamp(now);
    const sent: DeliveryLedger = {
      ...imageSending,
      status: "sent",
      updatedAt: sentAt,
      sentAt,
      image: "sent",
    };
    writeAfterAttempt(options.projectRoot, sent);
    return {
      status: "sent",
      textChunks: sent.textChunks,
      image: sent.image,
      textAttempt: sent.textAttempt,
      imageAttempt: sent.imageAttempt,
    };
  } finally {
    release();
  }
}

export function publicRunReportDeliveryError(error: unknown): string | null {
  if (
    error instanceof RunReportAlreadySentError ||
    error instanceof RunReportDeliveryBusyError ||
    error instanceof RunReportDeliveryIndeterminateError ||
    error instanceof RunReportRetryLimitError ||
    error instanceof RunReportDeliveryBlockedError
  ) {
    return error.message;
  }
  return null;
}
