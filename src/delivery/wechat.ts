import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { z } from "zod";

import {
  sendWechatReportImage,
  WechatMediaPreparationError,
} from "./wechat-media.js";
import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  createProjectPaths,
  resolveProjectPath,
} from "../lib/paths.js";

const CHANNEL_VERSION = "1.0.2";
const MAX_STATE_BYTES = 64 * 1_024;
const MAX_UPDATE_BYTES = 1 * 1_024 * 1_024;
const MAX_SEND_RESPONSE_BYTES = 64 * 1_024;
const MAX_MESSAGE_UNITS = 100_000;
const DEFAULT_CHUNK_UNITS = 2_000;
const DEFAULT_INITIALIZATION_DEADLINE_MS = 10 * 60 * 1_000;
const INITIALIZATION_TEXT = "初始化";
const MAX_SEEN_INITIALIZATION_MESSAGE_IDS = 100;
const VENDOR_UPSTREAM_COMMIT = "75d7db9338e133080fef9914b92ceb5e3ebd0dfc";
const VENDOR_ARTIFACT_PATHS = [
  "ilink/auth.js",
  "ilink/client.js",
  "utils/http.js",
  "utils/logger.js",
  "utils/crypto.js",
] as const;

const SecretString = z.string().min(1).max(16_384);
const IdentifierString = z.string().min(1).max(1_024);
const PositiveIntegerMessageId = z
  .number()
  .positive()
  .refine((value) => Number.isInteger(value));

function validWechatBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.port === "" &&
      url.hostname === "ilinkai.weixin.qq.com"
    );
  } catch {
    return false;
  }
}

const WechatCredentialsSchema = z
  .object({
    botToken: SecretString,
    baseUrl: z.string().max(2_048).refine(validWechatBaseUrl),
    ilinkBotId: IdentifierString,
    ilinkUserId: IdentifierString,
  })
  .strict();

export type WechatCredentials = z.infer<typeof WechatCredentialsSchema>;

const BindingSchema = z
  .object({
    version: z.literal(1),
    allowedUsers: z.tuple([IdentifierString]),
  })
  .strict();

const PendingContextSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("pending"),
    userId: IdentifierString,
    enrollmentStartedAtMs: z.number().int().positive().safe().optional(),
    seenInitializationMessageIds: z
      .array(PositiveIntegerMessageId)
      .max(MAX_SEEN_INITIALIZATION_MESSAGE_IDS)
      .default([]),
  })
  .strict();

const ReadyContextSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("ready"),
    userId: IdentifierString,
    contextToken: SecretString,
    capturedAt: z.string().datetime(),
    initializationMessageId: PositiveIntegerMessageId,
    initializationCreateTimeMs: z.number().int().positive().safe(),
    seenInitializationMessageIds: z
      .array(PositiveIntegerMessageId)
      .max(MAX_SEEN_INITIALIZATION_MESSAGE_IDS)
      .default([]),
  })
  .strict();

const ContextSchema = z.discriminatedUnion("status", [
  PendingContextSchema,
  ReadyContextSchema,
]);

const VendorArtifactManifestSchema = z
  .object({
    version: z.literal(1),
    upstreamCommit: z.literal(VENDOR_UPSTREAM_COMMIT),
    artifacts: z
      .array(
        z
          .object({
            path: z.enum(VENDOR_ARTIFACT_PATHS),
            bytes: z.number().int().positive().max(1_000_000),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .length(VENDOR_ARTIFACT_PATHS.length),
  })
  .strict();

type ReadyContext = z.infer<typeof ReadyContextSchema>;
type ContextState = z.infer<typeof ContextSchema>;

export interface VendorFetchOptions extends RequestInit {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly retryOnHttpError?: boolean;
  readonly label?: string;
}

export interface VendorWechatAdapter {
  login(
    onQrCode: (qrContent: string) => void,
  ): Promise<WechatCredentials | unknown>;
  fetchWithRetry(
    url: string,
    options?: VendorFetchOptions,
  ): Promise<Response>;
  generateWechatUin(): string;
}

export class WechatLoginExpiredError extends Error {
  override readonly name = "WechatLoginExpiredError";

  constructor() {
    super("微信登录已失效，请重新运行微信初始化并扫码");
  }
}

export class WechatPartialDeliveryError extends Error {
  override readonly name = "WechatPartialDeliveryError";
  readonly sentChunks: number;
  readonly loginExpired: boolean;

  constructor(sentChunks: number, loginExpired = false) {
    super("微信分段发送中途失败，结果不确定；为避免重复，不会自动重发整份日报");
    this.sentChunks = sentChunks;
    this.loginExpired = loginExpired;
  }
}

export class WechatDeliveryIndeterminateError extends Error {
  override readonly name = "WechatDeliveryIndeterminateError";
  readonly sentChunks = 0;

  constructor() {
    super("微信发送响应未能确认；为避免重复，不会自动重发整份消息");
  }
}

export class WechatDeliveryRejectedError extends Error {
  override readonly name = "WechatDeliveryRejectedError";

  constructor() {
    super("微信服务端明确拒绝了本次发送，可在确认原因后有限重试");
  }
}

interface WechatStatePaths {
  readonly directory: string;
  readonly credentials: string;
  readonly binding: string;
  readonly context: string;
  readonly pollCursor: string;
}

function statePaths(projectRoot: string): WechatStatePaths {
  const root = createProjectPaths(projectRoot);
  const directory = resolveProjectPath(root.root, ".state", "wechat");
  return {
    directory,
    credentials: resolveProjectPath(root.root, ".state", "wechat", "credentials.json"),
    binding: resolveProjectPath(root.root, ".state", "wechat", "binding.json"),
    context: resolveProjectPath(root.root, ".state", "wechat", "context.json"),
    pollCursor: resolveProjectPath(root.root, ".state", "wechat", "poll-cursor.txt"),
  };
}

function assertPrivateRegularFile(
  projectRoot: string,
  filePath: string,
): void {
  const safePath = assertNoSymlinkComponents(projectRoot, filePath);
  const stat = lstatSync(safePath);
  if (!stat.isFile()) {
    throw new Error("WeChat state path is not a private regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("WeChat state file has insecure private-file permissions");
  }
}

function readPrivateText(
  projectRoot: string,
  filePath: string,
  maximumBytes = MAX_STATE_BYTES,
): string | null {
  const text = readProjectText(projectRoot, filePath, maximumBytes);
  if (text === null) {
    return null;
  }
  assertPrivateRegularFile(projectRoot, filePath);
  return text;
}

function readPrivateJson(
  projectRoot: string,
  filePath: string,
): unknown | null {
  const raw = readPrivateText(projectRoot, filePath);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("WeChat state file is invalid");
  }
}

function writePrivateJson(
  projectRoot: string,
  filePath: string,
  value: unknown,
): void {
  writeProjectTextAtomic(
    projectRoot,
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function loadCredentials(projectRoot: string): WechatCredentials | null {
  const parsed = WechatCredentialsSchema.safeParse(
    readPrivateJson(projectRoot, statePaths(projectRoot).credentials),
  );
  return parsed.success ? parsed.data : null;
}

function loadBinding(projectRoot: string): z.infer<typeof BindingSchema> | null {
  const parsed = BindingSchema.safeParse(
    readPrivateJson(projectRoot, statePaths(projectRoot).binding),
  );
  return parsed.success ? parsed.data : null;
}

function loadReadyContext(projectRoot: string): ReadyContext | null {
  const parsed = ReadyContextSchema.safeParse(
    readPrivateJson(projectRoot, statePaths(projectRoot).context),
  );
  return parsed.success ? parsed.data : null;
}

function loadContextState(projectRoot: string): ContextState | null {
  const parsed = ContextSchema.safeParse(
    readPrivateJson(projectRoot, statePaths(projectRoot).context),
  );
  return parsed.success ? parsed.data : null;
}

function boundedUniqueMessageIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].slice(-MAX_SEEN_INITIALIZATION_MESSAGE_IDS);
}

function validatedBoundState(projectRoot: string): {
  credentials: WechatCredentials;
  context: ReadyContext;
} {
  const credentials = loadCredentials(projectRoot);
  const binding = loadBinding(projectRoot);
  const context = loadReadyContext(projectRoot);
  if (credentials === null || binding === null || context === null) {
    throw new Error("微信尚未完成初始化，请先扫码并发送“初始化”");
  }
  const owner = credentials.ilinkUserId;
  if (
    binding.allowedUsers.length !== 1 ||
    binding.allowedUsers[0] !== owner ||
    context.userId !== owner
  ) {
    throw new Error("微信本人绑定校验失败，请重新初始化");
  }
  return { credentials, context };
}

export function wechatHealth(projectRoot: string): {
  readonly credentialsReady: boolean;
  readonly ownerBound: boolean;
  readonly contextReady: boolean;
} {
  const credentials = loadCredentials(projectRoot);
  const binding = loadBinding(projectRoot);
  const context = loadReadyContext(projectRoot);
  const ownerBound =
    credentials !== null &&
    binding !== null &&
    binding.allowedUsers.length === 1 &&
    binding.allowedUsers[0] === credentials.ilinkUserId;
  return {
    credentialsReady: credentials !== null,
    ownerBound,
    contextReady:
      ownerBound &&
      context !== null &&
      context.userId === credentials.ilinkUserId,
  };
}

function parseCredentials(value: unknown): WechatCredentials {
  const parsed = WechatCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("微信扫码返回了无效凭据");
  }
  return parsed.data;
}

function combineSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined
    ? timeout
    : AbortSignal.any([external, timeout]);
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
    throw new Error("微信接口响应超过安全大小限制");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("微信接口返回了无效响应");
  }
}

const UpdateMessageSchema = z
  .object({
    message_id: PositiveIntegerMessageId,
    create_time_ms: z.number().int().positive().safe(),
    from_user_id: IdentifierString,
    message_type: z.number().int(),
    context_token: SecretString,
    item_list: z.array(z.unknown()).max(64),
  })
  .passthrough();

const UpdateResponseSchema = z
  .object({
    ret: z.number().int().optional(),
    errcode: z.number().int().optional(),
    get_updates_buf: z.string().max(64 * 1_024).optional(),
    msgs: z.array(z.unknown()).max(1_000).optional(),
  })
  .passthrough();

function exactInitializationMessage(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) {
    return false;
  }
  const item = value[0];
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const record = item as Record<string, unknown>;
  if (record.type !== 1 || "ref_msg" in record) {
    return false;
  }
  for (const mediaKey of ["image_item", "voice_item", "file_item", "video_item"]) {
    if (mediaKey in record) {
      return false;
    }
  }
  const textItem = record.text_item;
  return (
    typeof textItem === "object" &&
    textItem !== null &&
    typeof (textItem as Record<string, unknown>).text === "string" &&
    ((textItem as Record<string, unknown>).text as string).trim() ===
      INITIALIZATION_TEXT
  );
}

export interface WechatInitializationPollSummary {
  readonly totalMessages: number;
  readonly invalidMessages: number;
  readonly invalidFields: readonly string[];
  readonly wrongMessageType: number;
  readonly wrongOwner: number;
  readonly beforeEnrollment: number;
  readonly replayedInitialization: number;
  readonly notPlainInitialization: number;
  readonly accepted: number;
}

async function waitForInitialization(options: {
  readonly projectRoot: string;
  readonly credentials: WechatCredentials;
  readonly vendor: VendorWechatAdapter;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly now: () => Date;
  readonly enrollmentStartedAtMs: number;
  readonly seenInitializationMessageIds: readonly number[];
  readonly onPollSummary?: (summary: WechatInitializationPollSummary) => void;
}): Promise<void> {
  const paths = statePaths(options.projectRoot);
  const deadline = Date.now() + options.deadlineMs;
  let cursor = "";

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Aborted", "AbortError");
    }
    const remaining = Math.max(1, deadline - Date.now());
    const response = await options.vendor.fetchWithRetry(
      `${options.credentials.baseUrl.replace(/\/$/u, "")}/ilink/bot/getupdates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${options.credentials.botToken}`,
          "X-WECHAT-UIN": options.vendor.generateWechatUin(),
        },
        body: JSON.stringify({
          get_updates_buf: cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        signal: combineSignal(options.signal, Math.min(60_000, remaining)),
        label: "digest-init",
        retries: 1,
        retryOnHttpError: true,
        timeoutMs: Math.min(60_000, remaining),
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new WechatLoginExpiredError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`微信初始化轮询失败（HTTP ${response.status}）`);
    }
    const parsed = UpdateResponseSchema.safeParse(
      await boundedJson(response, MAX_UPDATE_BYTES),
    );
    if (!parsed.success) {
      throw new Error("微信初始化轮询返回了无效数据");
    }
    if (
      parsed.data.errcode === -14 ||
      parsed.data.errcode === -13
    ) {
      throw new WechatLoginExpiredError();
    }
    if (parsed.data.ret !== undefined && parsed.data.ret !== 0) {
      throw new Error("微信初始化轮询失败");
    }
    if (parsed.data.get_updates_buf !== undefined) {
      cursor = parsed.data.get_updates_buf;
      writeProjectTextAtomic(options.projectRoot, paths.pollCursor, cursor);
    }

    const rawMessages = parsed.data.msgs ?? [];
    const summary = {
      totalMessages: rawMessages.length,
      invalidMessages: 0,
      invalidFields: [] as string[],
      wrongMessageType: 0,
      wrongOwner: 0,
      beforeEnrollment: 0,
      replayedInitialization: 0,
      notPlainInitialization: 0,
      accepted: 0,
    } satisfies WechatInitializationPollSummary;
    let acceptedMessage: z.infer<typeof UpdateMessageSchema> | undefined;
    for (const rawMessage of rawMessages) {
      const message = UpdateMessageSchema.safeParse(rawMessage);
      if (!message.success) {
        summary.invalidMessages += 1;
        for (const issue of message.error.issues) {
          const field = issue.path[0];
          const safeField = typeof field === "string" ? field : "message";
          if (!summary.invalidFields.includes(safeField)) {
            summary.invalidFields.push(safeField);
          }
        }
        summary.invalidFields.sort();
        continue;
      }
      if (message.data.message_type !== 1) {
        summary.wrongMessageType += 1;
        continue;
      }
      if (message.data.from_user_id !== options.credentials.ilinkUserId) {
        summary.wrongOwner += 1;
        continue;
      }
      if (message.data.create_time_ms < options.enrollmentStartedAtMs) {
        summary.beforeEnrollment += 1;
        continue;
      }
      if (
        options.seenInitializationMessageIds.includes(message.data.message_id)
      ) {
        summary.replayedInitialization += 1;
        continue;
      }
      if (!exactInitializationMessage(message.data.item_list)) {
        summary.notPlainInitialization += 1;
        continue;
      }
      summary.accepted += 1;
      acceptedMessage = message.data;
      break;
    }
    options.onPollSummary?.(summary);
    if (acceptedMessage !== undefined) {
      writePrivateJson(options.projectRoot, paths.context, {
        version: 1,
        status: "ready",
        userId: options.credentials.ilinkUserId,
        contextToken: acceptedMessage.context_token,
        capturedAt: options.now().toISOString(),
        initializationMessageId: acceptedMessage.message_id,
        initializationCreateTimeMs: acceptedMessage.create_time_ms,
        seenInitializationMessageIds: boundedUniqueMessageIds([
          ...options.seenInitializationMessageIds,
          acceptedMessage.message_id,
        ]),
      } satisfies ReadyContext);
      return;
    }
  }
  throw new Error("等待微信“初始化”消息超时，请重新运行初始化");
}

export interface InitializeWechatOptions {
  readonly projectRoot: string;
  readonly vendor?: VendorWechatAdapter;
  readonly renderQr: (content: string) => void;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export async function initializeWechat(
  options: InitializeWechatOptions,
): Promise<{ readonly status: "initialized"; readonly ownerBound: true }> {
  const deadlineMs =
    options.deadlineMs ?? DEFAULT_INITIALIZATION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("微信初始化等待时间必须为正整数");
  }
  const vendor =
    options.vendor ?? (await loadVendorWechatAdapter(options.projectRoot));
  const now = options.now ?? (() => new Date());
  const enrollmentStartedAtMs = now().getTime();
  if (!Number.isFinite(enrollmentStartedAtMs)) {
    throw new RangeError("微信初始化开始时间无效");
  }
  const previousCredentials = loadCredentials(options.projectRoot);
  const previousContext = loadContextState(options.projectRoot);
  const credentials = parseCredentials(await vendor.login(options.renderQr));
  const seenInitializationMessageIds =
    previousCredentials?.ilinkUserId === credentials.ilinkUserId &&
    previousContext?.userId === credentials.ilinkUserId
      ? boundedUniqueMessageIds([
          ...previousContext.seenInitializationMessageIds,
          ...(previousContext.status === "ready"
            ? [previousContext.initializationMessageId]
            : []),
        ])
      : [];
  const paths = statePaths(options.projectRoot);
  writePrivateJson(options.projectRoot, paths.credentials, credentials);
  writePrivateJson(options.projectRoot, paths.binding, {
    version: 1,
    allowedUsers: [credentials.ilinkUserId],
  });
  writePrivateJson(options.projectRoot, paths.context, {
    version: 1,
    status: "pending",
    userId: credentials.ilinkUserId,
    enrollmentStartedAtMs,
    seenInitializationMessageIds,
  });
  writeProjectTextAtomic(options.projectRoot, paths.pollCursor, "");
  await waitForInitialization({
    projectRoot: options.projectRoot,
    credentials,
    vendor,
    deadlineMs,
    now,
    enrollmentStartedAtMs,
    seenInitializationMessageIds,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  validatedBoundState(options.projectRoot);
  return { status: "initialized", ownerBound: true };
}

export interface ResumeWechatInitializationOptions {
  readonly projectRoot: string;
  readonly vendor?: VendorWechatAdapter;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly onPollSummary?: (
    summary: WechatInitializationPollSummary,
  ) => void;
}

export async function resumeWechatInitialization(
  options: ResumeWechatInitializationOptions,
): Promise<{ readonly status: "initialized"; readonly ownerBound: true }> {
  const deadlineMs =
    options.deadlineMs ?? DEFAULT_INITIALIZATION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("微信初始化等待时间必须为正整数");
  }
  const paths = statePaths(options.projectRoot);
  const credentials = loadCredentials(options.projectRoot);
  const binding = loadBinding(options.projectRoot);
  const context = loadContextState(options.projectRoot);
  if (
    credentials === null ||
    binding === null ||
    context === null ||
    context.status !== "pending" ||
    binding.allowedUsers.length !== 1 ||
    binding.allowedUsers[0] !== credentials.ilinkUserId ||
    context.userId !== credentials.ilinkUserId
  ) {
    throw new Error("没有可安全恢复的微信初始化，请重新扫码");
  }
  const enrollmentStartedAtMs =
    context.enrollmentStartedAtMs ?? Math.trunc(lstatSync(paths.context).mtimeMs);
  if (
    !Number.isSafeInteger(enrollmentStartedAtMs) ||
    enrollmentStartedAtMs <= 0
  ) {
    throw new Error("微信初始化状态无效，请重新扫码");
  }
  const vendor =
    options.vendor ?? (await loadVendorWechatAdapter(options.projectRoot));
  const now = options.now ?? (() => new Date());
  await waitForInitialization({
    projectRoot: options.projectRoot,
    credentials,
    vendor,
    deadlineMs,
    now,
    enrollmentStartedAtMs,
    seenInitializationMessageIds: context.seenInitializationMessageIds,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onPollSummary === undefined
      ? {}
      : { onPollSummary: options.onPollSummary }),
  });
  validatedBoundState(options.projectRoot);
  return { status: "initialized", ownerBound: true };
}

/**
 * Mirrors cli-in-wechat's paragraph -> line -> space -> hard-cut segmentation.
 * The upstream function is not exported, so this small compatibility copy is kept tested.
 */
export function splitWechatText(
  text: string,
  maximumUnits = DEFAULT_CHUNK_UNITS,
): readonly string[] {
  if (!Number.isSafeInteger(maximumUnits) || maximumUnits <= 0) {
    throw new RangeError("微信分段长度必须为正整数");
  }
  if (text.length <= maximumUnits) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maximumUnits) {
      chunks.push(remaining);
      break;
    }
    let index = remaining.lastIndexOf("\n\n", maximumUnits);
    if (index < maximumUnits * 0.3) {
      index = remaining.lastIndexOf("\n", maximumUnits);
    }
    if (index < maximumUnits * 0.3) {
      index = remaining.lastIndexOf(" ", maximumUnits);
    }
    if (index < maximumUnits * 0.3) {
      index = maximumUnits;
    }
    chunks.push(remaining.substring(0, index));
    remaining = remaining.substring(index).trimStart();
  }
  return chunks;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const SendResponseSchema = z
  .object({
    ret: z.number().int().optional(),
    errcode: z.number().int().optional(),
  })
  .passthrough();

async function sendChunk(options: {
  readonly credentials: WechatCredentials;
  readonly context: ReadyContext;
  readonly text: string;
  readonly vendor: VendorWechatAdapter;
  readonly signal?: AbortSignal;
}): Promise<void> {
  let response: Response;
  try {
    response = await options.vendor.fetchWithRetry(
      `${options.credentials.baseUrl.replace(/\/$/u, "")}/ilink/bot/sendmessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${options.credentials.botToken}`,
          "X-WECHAT-UIN": options.vendor.generateWechatUin(),
        },
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: options.credentials.ilinkUserId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: options.context.contextToken,
            item_list: [{ type: 1, text_item: { text: options.text } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        label: "digest-send",
        retries: 0,
        timeoutMs: 30_000,
      },
    );
  } catch {
    throw new WechatDeliveryIndeterminateError();
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new WechatLoginExpiredError();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new WechatDeliveryIndeterminateError();
  }
  let responseValue: unknown;
  try {
    responseValue = await boundedJson(response, MAX_SEND_RESPONSE_BYTES);
  } catch {
    throw new WechatDeliveryIndeterminateError();
  }
  const parsed = SendResponseSchema.safeParse(responseValue);
  if (!parsed.success) {
    throw new WechatDeliveryIndeterminateError();
  }
  if (parsed.data.errcode === -14 || parsed.data.errcode === -13) {
    throw new WechatLoginExpiredError();
  }
  if (parsed.data.ret !== undefined && parsed.data.ret !== 0) {
    throw new WechatDeliveryRejectedError();
  }
  if (parsed.data.errcode !== undefined && parsed.data.errcode !== 0) {
    throw new WechatDeliveryRejectedError();
  }
}

export interface SendWechatTextOptions {
  readonly projectRoot: string;
  readonly text: string;
  readonly vendor?: VendorWechatAdapter;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface PrepareWechatTextSenderOptions {
  readonly projectRoot: string;
  readonly vendor?: VendorWechatAdapter;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type PreparedWechatTextSender = (
  text: string,
) => Promise<{ readonly status: "sent"; readonly chunks: number }>;

export async function prepareWechatTextSender(
  options: PrepareWechatTextSenderOptions,
): Promise<PreparedWechatTextSender> {
  const state = validatedBoundState(options.projectRoot);
  const vendor =
    options.vendor ?? (await loadVendorWechatAdapter(options.projectRoot));
  return async (rawText: string) => {
    const text = rawText.trim();
    if (text.length === 0 || text.length > MAX_MESSAGE_UNITS) {
      throw new RangeError("微信消息长度不在允许范围内");
    }
    const chunks = splitWechatText(text);
    let sentChunks = 0;
    for (const [index, chunk] of chunks.entries()) {
      try {
        await sendChunk({
          credentials: state.credentials,
          context: state.context,
          text: chunk,
          vendor,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        sentChunks += 1;
        if (index < chunks.length - 1) {
          await (options.sleep ?? delay)(300);
        }
      } catch (error) {
        if (sentChunks === 0) {
          throw error;
        }
        throw new WechatPartialDeliveryError(
          sentChunks,
          error instanceof WechatLoginExpiredError,
        );
      }
    }
    return { status: "sent", chunks: chunks.length };
  };
}

export async function sendWechatText(
  options: SendWechatTextOptions,
): Promise<{ readonly status: "sent"; readonly chunks: number }> {
  const sender = await prepareWechatTextSender(options);
  return await sender(options.text);
}

export interface PrepareWechatImageSenderOptions {
  readonly projectRoot: string;
  readonly vendor?: VendorWechatAdapter;
  readonly signal?: AbortSignal;
  readonly randomBytes?: (size: number) => Buffer;
  readonly clientId?: () => string;
}

export interface SendWechatImageOptions
  extends PrepareWechatImageSenderOptions {
  readonly imagePath: string;
}

export type PreparedWechatImageSender = (
  imagePath: string,
) => Promise<{ readonly status: "sent" }>;

export async function prepareWechatImageSender(
  options: PrepareWechatImageSenderOptions,
): Promise<PreparedWechatImageSender> {
  const state = validatedBoundState(options.projectRoot);
  const vendor =
    options.vendor ?? (await loadVendorWechatAdapter(options.projectRoot));
  return async (imagePath: string) =>
    await sendWechatReportImage({
      projectRoot: options.projectRoot,
      imagePath,
      session: {
        apiBaseUrl: state.credentials.baseUrl.replace(/\/$/u, ""),
        botToken: state.credentials.botToken,
        ownerUserId: state.credentials.ilinkUserId,
        contextToken: state.context.contextToken,
      },
      adapter: vendor,
      errors: {
        indeterminate: () => new WechatDeliveryIndeterminateError(),
        rejected: () => new WechatDeliveryRejectedError(),
        loginExpired: () => new WechatLoginExpiredError(),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.randomBytes === undefined
        ? {}
        : { randomBytes: options.randomBytes }),
      ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    });
}

export async function sendWechatImage(
  options: SendWechatImageOptions,
): Promise<{ readonly status: "sent" }> {
  const sender = await prepareWechatImageSender(options);
  return await sender(options.imagePath);
}

interface VendorAuthModule {
  readonly login?: (
    onQrCode: (qrContent: string) => void,
  ) => Promise<unknown>;
}

interface VendorHttpModule {
  readonly fetchWithRetry?: VendorWechatAdapter["fetchWithRetry"];
}

interface VendorCryptoModule {
  readonly generateWechatUin?: () => string;
}

async function importVendorModule<T>(
  projectRoot: string,
  ...relativeSegments: readonly string[]
): Promise<T> {
  const filePath = resolveProjectPath(
    projectRoot,
    "vendor",
    "cli-in-wechat",
    "dist",
    ...relativeSegments,
  );
  assertNoSymlinkComponents(projectRoot, filePath);
  return (await import(pathToFileURL(filePath).href)) as T;
}

export function verifyVendorWechatArtifacts(projectRoot: string): void {
  const manifestPath = resolveProjectPath(
    projectRoot,
    "config",
    "vendor-wechat-artifacts.json",
  );
  const rawManifest = readProjectText(
    projectRoot,
    manifestPath,
    32 * 1_024,
  );
  let manifestValue: unknown;
  try {
    manifestValue = rawManifest === null ? null : JSON.parse(rawManifest);
  } catch {
    throw new Error("cli-in-wechat runtime artifact integrity verification failed");
  }
  const parsed = VendorArtifactManifestSchema.safeParse(manifestValue);
  if (!parsed.success) {
    throw new Error("cli-in-wechat runtime artifact integrity verification failed");
  }
  const byPath = new Map(
    parsed.data.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  if (
    byPath.size !== VENDOR_ARTIFACT_PATHS.length ||
    VENDOR_ARTIFACT_PATHS.some((path) => !byPath.has(path))
  ) {
    throw new Error("cli-in-wechat runtime artifact integrity verification failed");
  }
  for (const path of VENDOR_ARTIFACT_PATHS) {
    const artifact = byPath.get(path)!;
    const filePath = resolveProjectPath(
      projectRoot,
      "vendor",
      "cli-in-wechat",
      "dist",
      ...path.split("/"),
    );
    let source: string | null;
    try {
      assertNoSymlinkComponents(projectRoot, filePath);
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.size !== artifact.bytes) {
        throw new Error("invalid artifact");
      }
      source = readProjectText(projectRoot, filePath, artifact.bytes + 1);
    } catch {
      throw new Error("cli-in-wechat runtime artifact integrity verification failed");
    }
    if (
      source === null ||
      Buffer.byteLength(source, "utf8") !== artifact.bytes ||
      createHash("sha256").update(source, "utf8").digest("hex") !==
        artifact.sha256
    ) {
      throw new Error("cli-in-wechat runtime artifact integrity verification failed");
    }
  }
}

export async function loadVendorWechatAdapter(
  projectRoot: string,
): Promise<VendorWechatAdapter> {
  verifyVendorWechatArtifacts(projectRoot);
  const [auth, http, crypto] = await Promise.all([
    importVendorModule<VendorAuthModule>(projectRoot, "ilink", "auth.js"),
    importVendorModule<VendorHttpModule>(projectRoot, "utils", "http.js"),
    importVendorModule<VendorCryptoModule>(projectRoot, "utils", "crypto.js"),
  ]);
  if (
    typeof auth.login !== "function" ||
    typeof http.fetchWithRetry !== "function" ||
    typeof crypto.generateWechatUin !== "function"
  ) {
    throw new Error("cli-in-wechat 构建不完整，请先执行 vendor 构建");
  }
  return {
    login: auth.login,
    fetchWithRetry: http.fetchWithRetry,
    generateWechatUin: crypto.generateWechatUin,
  };
}

interface QrTerminalModule {
  readonly error?: number;
  readonly generate?: (
    content: string,
    options: { readonly small: boolean },
  ) => void;
}

interface QrCodeInstance {
  addData(content: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}

type QrCodeConstructor = new (
  typeNumber: number,
  errorCorrectLevel: number,
) => QrCodeInstance;

export function writeWechatQrSvg(
  projectRoot: string,
  modules: readonly (readonly boolean[])[],
): string {
  const moduleCount = modules.length;
  if (
    moduleCount < 21 ||
    moduleCount > 177 ||
    modules.some(
      (row) =>
        row.length !== moduleCount ||
        row.some((module) => typeof module !== "boolean"),
    )
  ) {
    throw new Error("微信二维码矩阵无效");
  }
  const quietZone = 4;
  const imageSize = moduleCount + quietZone * 2;
  const pathSegments: string[] = [];
  for (const [rowIndex, row] of modules.entries()) {
    for (const [columnIndex, dark] of row.entries()) {
      if (dark) {
        pathSegments.push(
          `M${columnIndex + quietZone} ${rowIndex + quietZone}h1v1h-1z`,
        );
      }
    }
  }
  const svg = [
    `<svg viewBox="0 0 ${imageSize} ${imageSize}" xmlns="http://www.w3.org/2000/svg" width="512" height="512" shape-rendering="crispEdges">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<path d="${pathSegments.join("")}" fill="#000"/>`,
    "</svg>",
    "",
  ].join("\n");
  const imagePath = resolveProjectPath(
    projectRoot,
    ".state",
    "wechat",
    "login-qr.svg",
  );
  writeProjectTextAtomic(projectRoot, imagePath, svg);
  return imagePath;
}

export function renderWechatQr(projectRoot: string, content: string): string {
  if (content.length === 0 || content.length > 16_384) {
    throw new Error("微信二维码内容无效");
  }
  const packagePath = resolveProjectPath(
    projectRoot,
    "vendor",
    "cli-in-wechat",
    "package.json",
  );
  assertNoSymlinkComponents(projectRoot, packagePath);
  const vendorRequire = createRequire(packagePath);
  let qrcode: QrTerminalModule;
  let QrCode: QrCodeConstructor;
  try {
    qrcode = vendorRequire("qrcode-terminal") as QrTerminalModule;
    QrCode = vendorRequire(
      "qrcode-terminal/vendor/QRCode",
    ) as QrCodeConstructor;
  } catch {
    throw new Error("二维码渲染组件不可用，请先完成 vendor 依赖安装");
  }
  if (typeof qrcode.generate !== "function") {
    throw new Error("二维码渲染组件不可用，请重新构建 vendor");
  }
  const encoded = new QrCode(-1, qrcode.error ?? 1);
  encoded.addData(content);
  encoded.make();
  const moduleCount = encoded.getModuleCount();
  const modules = Array.from({ length: moduleCount }, (_, row) =>
    Array.from({ length: moduleCount }, (_, column) =>
      encoded.isDark(row, column),
    ),
  );
  const imagePath = writeWechatQrSvg(projectRoot, modules);
  qrcode.generate(content, { small: true });
  return imagePath;
}

export function publicWechatError(error: unknown): string {
  if (error instanceof WechatPartialDeliveryError && error.loginExpired) {
    return `${error.message}；微信登录已失效，请重新运行微信初始化并扫码`;
  }
  if (
    error instanceof WechatLoginExpiredError ||
    error instanceof WechatPartialDeliveryError ||
    error instanceof WechatDeliveryIndeterminateError ||
    error instanceof WechatDeliveryRejectedError ||
    error instanceof WechatMediaPreparationError ||
    error instanceof RangeError
  ) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "登录超时，请重试") {
    return "微信扫码登录超时，请重新运行初始化";
  }
  if (message.includes("二维码渲染组件不可用")) {
    return message;
  }
  return "微信操作失败；为保护凭据，未输出上游响应详情";
}

export function wechatStateDirectory(projectRoot: string): string {
  return join(statePaths(projectRoot).directory);
}
