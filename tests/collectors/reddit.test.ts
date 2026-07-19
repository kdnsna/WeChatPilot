import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createRedditCollector } from "../../src/collectors/reddit.js";
import { HttpError, createHttpClient } from "../../src/lib/http.js";
import { normalizeRedditEntry } from "../../src/normalizers/reddit.js";
import { CollectorResultSchema } from "../../src/types/collector.js";
import { NormalizedItemSchema } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T06:00:00.000Z");
const ENDPOINT =
  "https://www.reddit.com/r/technology+MachineLearning/.rss";

async function redditFixture(): Promise<string> {
  return await readFile(
    new URL("../fixtures/reddit/combined.xml", import.meta.url),
    "utf8",
  );
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}

describe("Reddit normalizer", () => {
  it("retains only verifiable metadata and runtime-parses the item", () => {
    const item = normalizeRedditEntry(
      {
        title: "<b>Local</b> models",
        link: "https://www.reddit.com/r/LocalLLaMA/comments/post1/local_models/",
        author: "/u/builder",
        isoDate: "2026-07-18T05:00:00.000Z",
        content: "<p>Measured <strong>results</strong>.</p>",
        id: "t3_post1",
      },
      { endpoint: ENDPOINT },
      NOW.toISOString(),
    );

    expect(item).toEqual({
      source: "reddit",
      category: "community",
      title: "Local models",
      url: "https://www.reddit.com/r/LocalLLaMA/comments/post1/local_models/",
      author: "/u/builder",
      publishedAt: "2026-07-18T05:00:00.000Z",
      comments: null,
      score: null,
      stars: null,
      summary: "Measured results.",
      rawMetrics: {
        subreddit: "LocalLLaMA",
        redditId: "t3_post1",
      },
      collectedAt: NOW.toISOString(),
    });
    expect(NormalizedItemSchema.safeParse(item).success).toBe(true);
    expect(item.rawMetrics).not.toHaveProperty("comments");
    expect(item.rawMetrics).not.toHaveProperty("score");
  });
});

describe("Reddit RSS collector", () => {
  it("makes one endpoint call, redacts content, skips invalid entries, and preserves no invented counts", async () => {
    const xml = await redditFixture();
    let calls = 0;
    const collector = createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology", "MachineLearning"],
    });
    const result = await collector.collect({
      http: {
        getJson: async () => {
          throw new Error("unexpected JSON request");
        },
        getText: async (_url, options) => {
          calls += 1;
          expect(options).toMatchObject({ maxResponseBytes: 2 * 1024 * 1024 });
          return xml;
        },
      },
      now: () => NOW,
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      sourceId: "reddit",
      status: "ok",
      fetchedAt: NOW.toISOString(),
      lastSuccessfulAt: NOW.toISOString(),
      warning: "Reddit skipped 1 invalid entry",
      items: [
        {
          source: "reddit",
          category: "community",
          title: "Research update",
          author: "/u/reddit_author",
          publishedAt: "2026-07-18T03:15:00.000Z",
          comments: null,
          score: null,
          stars: null,
          summary: "A verified research summary. token=[REDACTED]",
          rawMetrics: {
            subreddit: "MachineLearning",
            redditId: "t3_fixture123",
          },
        },
      ],
      rawEvidence: {
        endpointRequests: 1,
        configuredSubreddits: ["technology", "MachineLearning"],
        receivedEntries: 2,
        validEntries: 1,
        invalidEntries: 1,
        truncatedEntries: 0,
      },
    });
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "reddit-password",
      "reddit-query-secret",
      "reddit-summary-secret",
      "reddit-script-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    [403, "blocked"],
    [429, "rate_limited"],
  ] as const)("degrades HTTP %s to %s without throwing", async (status, expectedStatus) => {
    const collector = createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology"],
    });
    const result = await collector.collect({
      http: createHttpClient({
        fetch: async () => textResponse("do-not-retain reddit-error-secret", status),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      sourceId: "reddit",
      status: expectedStatus,
      items: [],
      rawEvidence: {
        endpointRequests: 1,
        receivedEntries: 0,
        validEntries: 0,
        invalidEntries: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain("reddit-error-secret");
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("degrades network and malformed XML failures without leaking error text", async () => {
    const networkCollector = createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology"],
    });
    const networkResult = await networkCollector.collect({
      http: {
        getJson: async () => ({}),
        getText: async () => {
          throw Object.assign(
            new HttpError({ kind: "network", retryable: true }),
            { detail: "token=network-error-secret" },
          );
        },
      },
      now: () => NOW,
    });
    const malformedResult = await createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology"],
    }).collect({
      http: {
        getJson: async () => ({}),
        getText: async () => "<feed><entry>malformed reddit-body-secret",
      },
      now: () => NOW,
    });

    expect(networkResult).toMatchObject({ status: "error", items: [] });
    expect(malformedResult).toMatchObject({ status: "invalid", items: [] });
    expect(JSON.stringify(networkResult)).not.toContain("network-error-secret");
    expect(JSON.stringify(malformedResult)).not.toContain("reddit-body-secret");
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const collector = createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology"],
    });

    await expect(
      collector.collect({
        http: createHttpClient({ fetch: async () => textResponse("unused") }),
        now: () => NOW,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("propagates cancellation raised after the response arrives", async () => {
    const xml = await redditFixture();
    const controller = new AbortController();
    const collector = createRedditCollector({
      endpoint: ENDPOINT,
      subreddits: ["technology"],
    });

    await expect(
      collector.collect({
        http: {
          getJson: async () => ({}),
          getText: async () => {
            controller.abort();
            return xml;
          },
        },
        now: () => NOW,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rejects unbounded subreddit and item configurations", () => {
    expect(() =>
      createRedditCollector({
        endpoint: ENDPOINT,
        subreddits: Array.from({ length: 101 }, (_, index) => `sub-${index}`),
      }),
    ).toThrow(RangeError);
    expect(() =>
      createRedditCollector({
        endpoint: ENDPOINT,
        subreddits: ["technology"],
        itemLimit: 101,
      }),
    ).toThrow(RangeError);
  });
});
