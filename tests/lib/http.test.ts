import { describe, expect, it } from "vitest";

import {
  HttpError,
  createHttpClient,
  type FetchLike,
  type HttpClient,
} from "../../src/lib/http.js";

function assertJsonRemainsUntrusted(client: HttpClient): void {
  // @ts-expect-error getJson intentionally accepts no trusted output type.
  void client.getJson<{ count: number }>("https://example.test/items");
}

void assertJsonRemainsUntrusted;

function response(
  body: ConstructorParameters<typeof Response>[0],
  init?: ResponseInit,
): Response {
  return new Response(body, init);
}

describe("HTTP client", () => {
  it("parses JSON responses", async () => {
    const client = createHttpClient({
      fetch: async () => response('{"count":2}', { status: 200 }),
    });

    await expect(client.getJson("https://example.test/items")).resolves.toEqual({
      count: 2,
    });
  });

  it("returns text responses", async () => {
    const client = createHttpClient({
      fetch: async () => response("plain text", { status: 200 }),
    });

    await expect(
      client.getText("https://example.test/feed"),
    ).resolves.toBe("plain text");
  });

  it("omits credentials, strips Cookie, and sends a descriptive User-Agent", async () => {
    let receivedInit: RequestInit | undefined;
    const fakeFetch: FetchLike = async (_input, init) => {
      receivedInit = init;
      return response("ok", { status: 200 });
    };
    const client = createHttpClient({ fetch: fakeFetch });

    await client.getText("https://example.test/feed", {
      headers: {
        Accept: "text/plain",
        Cookie: "session=ambient-cookie-value",
      },
    });

    const headers = new Headers(receivedInit?.headers);
    expect(receivedInit?.credentials).toBe("omit");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("accept")).toBe("text/plain");
    expect(headers.get("user-agent")).toMatch(/daily-tech-digest\/[\d.]+.+collector/i);
  });

  it("aborts a request after the bounded timeout", async () => {
    let attempts = 0;
    const fakeFetch: FetchLike = async (_input, init) => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const client = createHttpClient({
      fetch: fakeFetch,
      timeoutMs: 10,
    });

    await expect(client.getText("https://example.test/slow")).rejects.toMatchObject({
      name: "HttpError",
      kind: "timeout",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("does not invoke fetch when the supplied signal is already aborted", async () => {
    let attempts = 0;
    const controller = new AbortController();
    controller.abort();
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        return response("must not run", { status: 200 });
      },
    });

    await expect(
      client.getText("https://example.test/pre-aborted", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted", retryable: false });
    expect(attempts).toBe(0);
  });

  it("classifies a non-retryable non-2xx response", async () => {
    const client = createHttpClient({
      fetch: async () => response("not found", { status: 404 }),
    });

    await expect(client.getText("https://example.test/missing")).rejects.toMatchObject({
      name: "HttpError",
      kind: "client_error",
      status: 404,
      retryable: false,
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "blocked"],
    [429, "rate_limited"],
  ] as const)("never retries HTTP %i and classifies it as %s", async (status, kind) => {
    let attempts = 0;
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        return response("rejected", { status });
      },
      sleep: async () => {
        throw new Error("sleep must not be called");
      },
    });

    await expect(client.getText("https://example.test/private")).rejects.toMatchObject({
      kind,
      status,
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("exposes only parsed retry and rate-limit metadata", async () => {
    const client = createHttpClient({
      fetch: async () =>
        response("limited", {
          status: 429,
          headers: {
            "Retry-After": "2",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1784361600",
            Authorization: "Bearer must-never-escape",
          },
        }),
    });

    const thrown = await client
      .getText("https://example.test/private?token=url-secret")
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 2_000,
      rateLimit: {
        limit: 60,
        remaining: 0,
        resetAt: "2026-07-18T08:00:00.000Z",
      },
    });
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain("must-never-escape");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("authorization");
  });

  it("ignores invalid rate-limit metadata without retrying a 429", async () => {
    let attempts = 0;
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        return response("limited", {
          status: 429,
          headers: { "X-RateLimit-Reset": "1e300" },
        });
      },
      sleep: async () => {
        throw new Error("sleep must not be called");
      },
    });

    await expect(client.getText("https://example.test/limited")).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("retries a network failure exactly once using injected delay and jitter", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("connection reset");
        }
        return response("recovered", { status: 200 });
      },
      retryDelayMs: 20,
      jitter: () => 0.25,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(client.getText("https://example.test/retry")).resolves.toBe(
      "recovered",
    );
    expect(attempts).toBe(2);
    expect(delays).toEqual([25]);
  });

  it("aborts promptly during retry backoff and never starts a second fetch", async () => {
    let attempts = 0;
    let releaseSleep: (() => void) | undefined;
    let markSleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const controller = new AbortController();
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        throw new TypeError("network unavailable");
      },
      sleep: async () => {
        markSleepStarted?.();
        await new Promise<void>((resolve) => {
          releaseSleep = resolve;
        });
      },
    });

    const request = client
      .getText("https://example.test/backoff", { signal: controller.signal })
      .catch((error: unknown) => error);
    await sleepStarted;
    controller.abort();
    const promptOutcome = await Promise.race([
      request,
      new Promise<"not-prompt">((resolve) =>
        setTimeout(() => resolve("not-prompt"), 50),
      ),
    ]);
    releaseSleep?.();
    const finalOutcome = await request;

    expect(promptOutcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(finalOutcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(attempts).toBe(1);
  });

  it("retries a 5xx response only once", async () => {
    let attempts = 0;
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        return response("unavailable", { status: 503 });
      },
      retryDelayMs: 0,
      jitter: () => 0,
      sleep: async () => undefined,
    });

    await expect(client.getText("https://example.test/unavailable")).rejects.toMatchObject({
      kind: "server_error",
      status: 503,
      retryable: true,
    });
    expect(attempts).toBe(2);
  });

  it("rejects a response that exceeds the maximum body size while streaming", async () => {
    const client = createHttpClient({
      fetch: async () => response("123456789", { status: 200 }),
      maxResponseBytes: 8,
    });

    await expect(client.getText("https://example.test/large")).rejects.toMatchObject({
      kind: "response_too_large",
      retryable: false,
      maxResponseBytes: 8,
    });
  });

  it("preserves response_too_large when cancelling the response body fails", async () => {
    let attempts = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456789"));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const client = createHttpClient({
      fetch: async () => {
        attempts += 1;
        return response(body, { status: 200 });
      },
      maxResponseBytes: 8,
    });

    await expect(client.getText("https://example.test/large-cancel")).rejects.toMatchObject({
      kind: "response_too_large",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("classifies invalid JSON without persisting response contents", async () => {
    const invalidBody = "not-json token=body-secret";
    const client = createHttpClient({
      fetch: async () => response(invalidBody, { status: 200 }),
    });

    const thrown = await client
      .getJson("https://example.test/invalid")
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      name: "HttpError",
      kind: "invalid_response",
      retryable: false,
    });
    expect(JSON.stringify(thrown)).not.toContain("body-secret");
  });
});
