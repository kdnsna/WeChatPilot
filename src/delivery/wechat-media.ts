import {
  createCipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const CHANNEL_VERSION = "1.0.2";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const IMAGE_MEDIA_TYPE = 1;
const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PREPARATION_ERROR_MESSAGE =
  "微信报告图片准备失败，未尝试发送图片消息";

interface MediaFetchOptions extends RequestInit {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly label?: string;
}

export interface WechatMediaAdapter {
  fetchWithRetry(url: string, options?: MediaFetchOptions): Promise<Response>;
  generateWechatUin(): string;
}

export interface WechatMediaSession {
  readonly apiBaseUrl: string;
  readonly botToken: string;
  readonly ownerUserId: string;
  readonly contextToken: string;
}

export interface WechatMediaErrorFactories {
  readonly indeterminate: () => Error;
  readonly rejected: () => Error;
  readonly loginExpired: () => Error;
}

export interface SendWechatReportImageOptions {
  readonly projectRoot: string;
  readonly imagePath: string;
  readonly session: WechatMediaSession;
  readonly adapter: WechatMediaAdapter;
  readonly errors: WechatMediaErrorFactories;
  readonly signal?: AbortSignal;
  readonly randomBytes?: (size: number) => Buffer;
  readonly clientId?: () => string;
}

export class WechatMediaPreparationError extends Error {
  override readonly name = "WechatMediaPreparationError";

  constructor() {
    super(PREPARATION_ERROR_MESSAGE);
  }
}

function containedPath(projectRoot: string, imagePath: string): string {
  const root = realpathSync(projectRoot);
  const candidate = resolve(projectRoot, imagePath);
  const lexicalRelative = relative(resolve(projectRoot), candidate);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("outside project");
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("unsafe image file");
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error("image too large");
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (
    actualRelative === ".." ||
    actualRelative.startsWith(`..${sep}`) ||
    isAbsolute(actualRelative) ||
    actual !== resolve(root, lexicalRelative)
  ) {
    throw new Error("unsafe image path");
  }
  return candidate;
}

function readReportPng(projectRoot: string, imagePath: string): Buffer {
  const safePath = containedPath(projectRoot, imagePath);
  const before = lstatSync(safePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      safePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_IMAGE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("unsafe image file");
    }
    const image = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== image.length || after.size !== opened.size) {
      throw new Error("image changed while reading");
    }
    if (
      image.length < 33 ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 ||
      image.toString("ascii", 12, 16) !== "IHDR" ||
      image.readUInt32BE(16) !== 1_080 ||
      image.readUInt32BE(20) !== 1_440
    ) {
      throw new Error("invalid report png");
    }
    return image;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function apiHeaders(
  session: WechatMediaSession,
  adapter: WechatMediaAdapter,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${session.botToken}`,
    "X-WECHAT-UIN": adapter.generateWechatUin(),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("response too large");
  }
  return JSON.parse(raw) as unknown;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid response");
  }
  return value as Record<string, unknown>;
}

function exactRandom16(
  random: (size: number) => Buffer,
): Buffer {
  const value = random(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new Error("invalid random bytes");
  }
  return Buffer.from(value);
}

function validOpaqueParameter(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    value.trim() === value &&
    !/[\r\n]/u.test(value)
  );
}

function optionalInteger(
  record: Record<string, unknown>,
  key: "ret" | "errcode",
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("invalid response status");
  }
  return value;
}

async function prepareUpload(options: SendWechatReportImageOptions): Promise<{
  readonly aesKey: Buffer;
  readonly encryptedSize: number;
  readonly downloadParameter: string;
}> {
  const image = readReportPng(options.projectRoot, options.imagePath);
  const random = options.randomBytes ?? nodeRandomBytes;
  const fileKey = exactRandom16(random).toString("hex");
  const aesKey = exactRandom16(random);
  const encryptedSize = Math.ceil((image.length + 1) / 16) * 16;
  const uploadResponse = await options.adapter.fetchWithRetry(
    `${options.session.apiBaseUrl}/ilink/bot/getuploadurl`,
    {
      method: "POST",
      headers: apiHeaders(options.session, options.adapter),
      body: JSON.stringify({
        filekey: fileKey,
        media_type: IMAGE_MEDIA_TYPE,
        to_user_id: options.session.ownerUserId,
        rawsize: image.length,
        rawfilemd5: createHash("md5").update(image).digest("hex"),
        filesize: encryptedSize,
        aeskey: aesKey.toString("hex"),
        no_need_thumb: true,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      label: "report-image-upload-url",
      retries: 0,
      timeoutMs: 30_000,
    },
  );
  if (!uploadResponse.ok) {
    await uploadResponse.body?.cancel();
    throw new Error("upload authorization failed");
  }
  const uploadValue = objectRecord(await responseJson(uploadResponse));
  const uploadRet = optionalInteger(uploadValue, "ret");
  const uploadErrcode = optionalInteger(uploadValue, "errcode");
  if (
    (uploadRet !== undefined && uploadRet !== 0) ||
    (uploadErrcode !== undefined && uploadErrcode !== 0)
  ) {
    throw new Error("upload authorization rejected");
  }
  const uploadParameter = uploadValue.upload_param;
  if (!validOpaqueParameter(uploadParameter)) {
    throw new Error("missing upload parameter");
  }

  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  const encrypted = Buffer.concat([cipher.update(image), cipher.final()]);
  if (encrypted.length !== encryptedSize) {
    throw new Error("invalid encrypted size");
  }
  const cdnUrl = new URL(`${CDN_BASE_URL}/upload`);
  cdnUrl.searchParams.set("encrypted_query_param", uploadParameter);
  cdnUrl.searchParams.set("filekey", fileKey);
  const cdnResponse = await options.adapter.fetchWithRetry(cdnUrl.href, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    label: "report-image-cdn-upload",
    retries: 0,
    timeoutMs: 60_000,
  });
  if (!cdnResponse.ok) {
    await cdnResponse.body?.cancel();
    throw new Error("cdn upload failed");
  }
  const downloadParameter = cdnResponse.headers.get("x-encrypted-param");
  await cdnResponse.body?.cancel();
  if (!validOpaqueParameter(downloadParameter)) {
    throw new Error("missing download parameter");
  }
  return { aesKey, encryptedSize, downloadParameter };
}

export async function sendWechatReportImage(
  options: SendWechatReportImageOptions,
): Promise<{ readonly status: "sent" }> {
  let upload: Awaited<ReturnType<typeof prepareUpload>>;
  try {
    upload = await prepareUpload(options);
  } catch {
    throw new WechatMediaPreparationError();
  }

  let response: Response;
  try {
    response = await options.adapter.fetchWithRetry(
      `${options.session.apiBaseUrl}/ilink/bot/sendmessage`,
      {
        method: "POST",
        headers: apiHeaders(options.session, options.adapter),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: options.session.ownerUserId,
            client_id: (options.clientId ?? randomUUID)(),
            message_type: 2,
            message_state: 2,
            context_token: options.session.contextToken,
            item_list: [
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: upload.downloadParameter,
                    aes_key: Buffer.from(
                      upload.aesKey.toString("hex"),
                      "ascii",
                    ).toString("base64"),
                    encrypt_type: 1,
                  },
                  mid_size: upload.encryptedSize,
                },
              },
            ],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        label: "report-image-send",
        retries: 0,
        timeoutMs: 30_000,
      },
    );
  } catch {
    throw options.errors.indeterminate();
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw options.errors.loginExpired();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw options.errors.indeterminate();
  }
  let value: Record<string, unknown>;
  let ret: number | undefined;
  let errcode: number | undefined;
  try {
    value = objectRecord(await responseJson(response));
    ret = optionalInteger(value, "ret");
    errcode = optionalInteger(value, "errcode");
  } catch {
    throw options.errors.indeterminate();
  }
  if (errcode === -14 || errcode === -13) {
    throw options.errors.loginExpired();
  }
  if (
    (ret !== undefined && ret !== 0) ||
    (errcode !== undefined && errcode !== 0)
  ) {
    throw options.errors.rejected();
  }
  return { status: "sent" };
}
