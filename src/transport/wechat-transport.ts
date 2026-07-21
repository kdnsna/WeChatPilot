import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface WechatTransportFetchOptions extends RequestInit {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly retryOnHttpError?: boolean;
  readonly label?: string;
}

export interface WechatTransportCredentials {
  readonly botToken: string;
  readonly baseUrl: string;
  readonly ilinkBotId: string;
  readonly ilinkUserId: string;
}

function errorCode(error: unknown): string | undefined {
  let current = error as { readonly code?: unknown; readonly cause?: unknown } | undefined;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    if (typeof current.code === "string") {
      return current.code;
    }
    current = current.cause as typeof current;
  }
  return undefined;
}

function retryable(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return true;
  }
  const name = (error as { readonly name?: unknown } | null)?.name;
  if (name === "TimeoutError") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("socket hang up") || message.includes("terminated");
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function delayFor(attempt: number, base: number, maximum: number): number {
  return Math.floor(Math.min(maximum, base * 2 ** attempt) * (0.5 + Math.random() * 0.5));
}

export async function fetchWithRetry(
  url: string,
  options: WechatTransportFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 3,
    retryDelayMs = 500,
    maxRetryDelayMs = 8_000,
    retryOnHttpError = false,
    label: _label,
    signal: externalSignal,
    ...init
  } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new DOMException("Aborted", "AbortError");
    }
    const signal = externalSignal == null
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await fetch(url, { ...init, signal });
      if (
        retryOnHttpError &&
        (response.status === 429 || response.status >= 500) &&
        attempt < retries
      ) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(maxRetryDelayMs, retryAfter * 1_000)
          : delayFor(attempt, retryDelayMs, maxRetryDelayMs);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new DOMException("Aborted", "AbortError");
      }
      if (!retryable(error) || attempt === retries) {
        const wrapped = new Error("WeChat transport request failed", { cause: error });
        const code = errorCode(error);
        if (code !== undefined) {
          (wrapped as Error & { code?: string }).code = code;
        }
        throw wrapped;
      }
      await sleep(delayFor(attempt, retryDelayMs, maxRetryDelayMs));
    }
  }
  throw new Error("WeChat transport request failed", { cause: lastError });
}

function validObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json() as unknown;
  if (!validObject(value)) {
    throw new Error("WeChat login response is invalid");
  }
  return value;
}

export async function login(
  onQrCode: (qrContent: string) => void,
): Promise<WechatTransportCredentials> {
  for (let refresh = 0; refresh < 3; refresh += 1) {
    const qrResponse = await fetchWithRetry(
      `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      { retries: 4, retryOnHttpError: true, timeoutMs: 20_000 },
    );
    if (!qrResponse.ok) {
      throw new Error("WeChat QR request failed");
    }
    const qr = await responseJson(qrResponse);
    const qrId = typeof qr.qrcode === "string" ? qr.qrcode : undefined;
    const qrContent = typeof qr.qrcode_img_content === "string"
      ? qr.qrcode_img_content
      : qrId;
    if (qrId === undefined || qrContent === undefined) {
      throw new Error("WeChat QR response is invalid");
    }
    onQrCode(qrContent);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await sleep(2_000);
      const statusResponse = await fetchWithRetry(
        `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrId)}`,
        {
          headers: { "iLink-App-ClientVersion": "1" },
          retries: 1,
          timeoutMs: 45_000,
        },
      );
      if (!statusResponse.ok) {
        continue;
      }
      const status = await responseJson(statusResponse);
      if (status.status === "expired") {
        break;
      }
      if (status.status !== "confirmed") {
        continue;
      }
      const botToken = status.bot_token;
      const ilinkBotId = status.ilink_bot_id;
      const ilinkUserId = status.ilink_user_id;
      const baseUrl = status.baseurl ?? DEFAULT_BASE_URL;
      if (
        typeof botToken !== "string" ||
        typeof ilinkBotId !== "string" ||
        typeof ilinkUserId !== "string" ||
        typeof baseUrl !== "string"
      ) {
        throw new Error("WeChat login response is invalid");
      }
      return { botToken, baseUrl, ilinkBotId, ilinkUserId };
    }
  }
  throw new Error("WeChat login timed out");
}

export function generateWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

export const WECHAT_TRANSPORT_RUNTIME_CLOSURE = Object.freeze([
  "node:crypto",
  "globalThis.fetch",
] as const);
