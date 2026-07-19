export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type HttpHeadersInit = ConstructorParameters<typeof Headers>[0];

export type HttpErrorKind =
  | "aborted"
  | "blocked"
  | "client_error"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "rate_limited"
  | "response_too_large"
  | "server_error"
  | "timeout"
  | "unauthorized";

export interface RateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

interface HttpErrorOptions {
  readonly kind: HttpErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly rateLimit?: RateLimitMetadata;
  readonly maxResponseBytes?: number;
}

function messageForError(kind: HttpErrorKind, status?: number): string {
  const statusSuffix = status === undefined ? "" : ` (HTTP ${status})`;

  switch (kind) {
    case "aborted":
      return "HTTP request was aborted";
    case "blocked":
      return `HTTP request was blocked${statusSuffix}`;
    case "client_error":
      return `HTTP request failed${statusSuffix}`;
    case "invalid_request":
      return "HTTP request options are invalid";
    case "invalid_response":
      return "HTTP response is invalid";
    case "network":
      return "HTTP request failed because of a network error";
    case "rate_limited":
      return `HTTP request was rate limited${statusSuffix}`;
    case "response_too_large":
      return "HTTP response exceeded the configured size limit";
    case "server_error":
      return `HTTP server failed${statusSuffix}`;
    case "timeout":
      return "HTTP request timed out";
    case "unauthorized":
      return `HTTP request was unauthorized${statusSuffix}`;
  }
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly kind: HttpErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly rateLimit?: RateLimitMetadata;
  readonly maxResponseBytes?: number;

  constructor(options: HttpErrorOptions) {
    super(messageForError(options.kind, options.status));
    this.kind = options.kind;
    this.retryable = options.retryable;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.rateLimit !== undefined) {
      this.rateLimit = options.rateLimit;
    }
    if (options.maxResponseBytes !== undefined) {
      this.maxResponseBytes = options.maxResponseBytes;
    }
  }

  toJSON(): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
      name: this.name,
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
    };
    if (this.status !== undefined) {
      serialized.status = this.status;
    }
    if (this.retryAfterMs !== undefined) {
      serialized.retryAfterMs = this.retryAfterMs;
    }
    if (this.rateLimit !== undefined) {
      serialized.rateLimit = this.rateLimit;
    }
    if (this.maxResponseBytes !== undefined) {
      serialized.maxResponseBytes = this.maxResponseBytes;
    }
    return serialized;
  }
}

export interface HttpRequestOptions {
  readonly headers?: HttpHeadersInit;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface HttpClient {
  getJson(url: string | URL, options?: HttpRequestOptions): Promise<unknown>;
  getText(url: string | URL, options?: HttpRequestOptions): Promise<string>;
}

export interface HttpClientOptions {
  readonly fetch: FetchLike;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly jitter?: () => number;
}

const DEFAULT_USER_AGENT =
  "daily-tech-digest/0.1 (scheduled technology collector; local-first)";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 250;

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HttpError({ kind: "invalid_request", retryable: false });
  }
  return value;
}

function requireNonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new HttpError({ kind: "invalid_request", retryable: false });
  }
  return value;
}

function safeHeaders(
  input: HttpHeadersInit | undefined,
  userAgent: string,
): Headers {
  try {
    const headers = new Headers(input);
    headers.delete("cookie");
    headers.set("user-agent", userAgent);
    return headers;
  } catch {
    throw new HttpError({ kind: "invalid_request", retryable: false });
  }
}

function parseFiniteHeader(headers: Headers, name: string): number | undefined {
  const rawValue = headers.get(name);
  if (rawValue === null || rawValue.trim() === "") {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const rawValue = headers.get("retry-after");
  if (rawValue === null || rawValue.trim() === "") {
    return undefined;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const retryTime = Date.parse(rawValue);
  if (!Number.isFinite(retryTime)) {
    return undefined;
  }
  return Math.max(0, retryTime - Date.now());
}

function rateLimitMetadata(headers: Headers): RateLimitMetadata | undefined {
  const limit = parseFiniteHeader(headers, "x-ratelimit-limit");
  const remaining = parseFiniteHeader(headers, "x-ratelimit-remaining");
  const resetSeconds = parseFiniteHeader(headers, "x-ratelimit-reset");
  const resetDate =
    resetSeconds === undefined ? undefined : new Date(resetSeconds * 1_000);
  const resetAt =
    resetDate === undefined || !Number.isFinite(resetDate.getTime())
      ? undefined
      : resetDate.toISOString();

  if (limit === undefined && remaining === undefined && resetAt === undefined) {
    return undefined;
  }

  const metadata: {
    limit?: number;
    remaining?: number;
    resetAt?: string;
  } = {};
  if (limit !== undefined) {
    metadata.limit = limit;
  }
  if (remaining !== undefined) {
    metadata.remaining = remaining;
  }
  if (resetAt !== undefined) {
    metadata.resetAt = resetAt;
  }
  return metadata;
}

function statusError(response: Response): HttpError {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers);
  const rateLimit = rateLimitMetadata(response.headers);
  let kind: HttpErrorKind;
  let retryable = false;

  if (status === 401) {
    kind = "unauthorized";
  } else if (status === 403) {
    kind = "blocked";
  } else if (status === 429) {
    kind = "rate_limited";
  } else if (status >= 500 && status <= 599) {
    kind = "server_error";
    retryable = true;
  } else {
    kind = "client_error";
  }

  return new HttpError({
    kind,
    retryable,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  });
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is deliberately ignored for non-success responses.
  }
}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const contentLength = parseFiniteHeader(response.headers, "content-length");
  if (contentLength !== undefined && contentLength > maxResponseBytes) {
    await discardBody(response);
    throw new HttpError({
      kind: "response_too_large",
      retryable: false,
      maxResponseBytes,
    });
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort; retain the size-limit classification.
        }
        throw new HttpError({
          kind: "response_too_large",
          retryable: false,
          maxResponseBytes,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function retryDelay(baseDelayMs: number, jitter: () => number): number {
  let jitterValue = 0;
  try {
    const candidate = jitter();
    if (Number.isFinite(candidate)) {
      jitterValue = Math.min(1, Math.max(0, candidate));
    }
  } catch {
    jitterValue = 0;
  }
  return Math.round(baseDelayMs * (1 + jitterValue));
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const timeoutMs = requirePositiveNumber(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = requirePositiveNumber(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const retryDelayMs = requireNonNegativeNumber(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  );
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  function abortedError(): HttpError {
    return new HttpError({ kind: "aborted", retryable: false });
  }

  function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
  }

  async function sleepWithAbort(
    delayMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (isAborted(signal)) {
      throw abortedError();
    }
    if (signal === undefined) {
      await sleep(delayMs);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => finish(() => reject(abortedError()));
      signal.addEventListener("abort", onAbort, { once: true });
      void sleep(delayMs).then(
        () => finish(resolve),
        () =>
          finish(() =>
            reject(new HttpError({ kind: "network", retryable: true })),
          ),
      );
    });
  }

  async function requestTextOnce(
    url: string | URL,
    requestOptions: HttpRequestOptions,
  ): Promise<string> {
    const requestTimeoutMs = requirePositiveNumber(
      requestOptions.timeoutMs ?? timeoutMs,
      "timeoutMs",
    );
    const requestMaxResponseBytes = requirePositiveNumber(
      requestOptions.maxResponseBytes ?? maxResponseBytes,
      "maxResponseBytes",
    );
    const headers = safeHeaders(requestOptions.headers, userAgent);
    const controller = new AbortController();
    let timedOut = false;
    const externalSignal = requestOptions.signal;
    if (isAborted(externalSignal)) {
      throw abortedError();
    }
    const abortFromExternalSignal = (): void => {
      controller.abort(externalSignal?.reason);
    };

    externalSignal?.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await options.fetch(url, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        await discardBody(response);
        throw statusError(response);
      }
      return await readBoundedText(response, requestMaxResponseBytes);
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (isAborted(externalSignal)) {
        throw abortedError();
      }
      if (timedOut) {
        throw new HttpError({ kind: "timeout", retryable: false });
      }
      throw new HttpError({ kind: "network", retryable: true });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  async function getText(
    url: string | URL,
    requestOptions: HttpRequestOptions = {},
  ): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isAborted(requestOptions.signal)) {
        throw abortedError();
      }
      try {
        return await requestTextOnce(url, requestOptions);
      } catch (error: unknown) {
        const httpError =
          error instanceof HttpError
            ? error
            : new HttpError({ kind: "network", retryable: true });
        if (attempt === 1 || !httpError.retryable) {
          throw httpError;
        }
        try {
          await sleepWithAbort(
            retryDelay(retryDelayMs, jitter),
            requestOptions.signal,
          );
        } catch (sleepError: unknown) {
          if (sleepError instanceof HttpError) {
            throw sleepError;
          }
          throw new HttpError({ kind: "network", retryable: true });
        }
      }
    }
    throw new HttpError({ kind: "network", retryable: true });
  }

  return {
    async getJson(
      url: string | URL,
      requestOptions?: HttpRequestOptions,
    ): Promise<unknown> {
      const text = await getText(url, requestOptions);
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        throw new HttpError({ kind: "invalid_response", retryable: false });
      }
    },
    getText,
  };
}
