import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createHackerNewsCollector } from "../../src/collectors/hacker-news.js";
import {
  HttpError,
  createHttpClient,
  type FetchLike,
} from "../../src/lib/http.js";
import { HackerNewsStorySchema } from "../../src/normalizers/hacker-news.js";
import { CollectorResultSchema } from "../../src/types/collector.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const TOP_URL = "https://hn.test/v0/topstories.json";
const NEW_URL = "https://hn.test/v0/newstories.json";
const ITEM_URL_TEMPLATE = "https://hn.test/v0/item/{id}.json";
const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/hn/", import.meta.url),
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}`, "utf8")) as unknown;
}

const topIds = fixture("topstories.json");
const newIds = fixture("newstories.json");
const itemFixtures = fixture("items.json") as Record<string, unknown>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function itemIdFromUrl(url: string): number | undefined {
  const match = /\/item\/(\d+)\.json$/.exec(url);
  return match === null ? undefined : Number(match[1]);
}

function createFixtureFetch(
  overrides: Readonly<Record<string, () => Response | Promise<Response>>> = {},
): { readonly fetch: FetchLike; readonly calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    const override = overrides[url];
    if (override !== undefined) {
      return await override();
    }
    if (url === TOP_URL) {
      return jsonResponse(topIds);
    }
    if (url === NEW_URL) {
      return jsonResponse(newIds);
    }

    const id = itemIdFromUrl(url);
    if (id !== undefined && Object.hasOwn(itemFixtures, String(id))) {
      return jsonResponse(itemFixtures[String(id)]);
    }
    return jsonResponse({ unavailable: true }, 404);
  };
  return { fetch, calls };
}

function createCollector(
  options: {
    readonly listLimit?: number;
    readonly concurrency?: number;
  } = {},
) {
  return createHackerNewsCollector({
    endpoints: { top: TOP_URL, new: NEW_URL },
    itemUrlTemplate: ITEM_URL_TEMPLATE,
    ...options,
  });
}

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return new Error("expected promise to reject");
  } catch (error) {
    return error;
  }
}

function createItemStatusFetch(statuses: readonly number[]): FetchLike {
  const ids = statuses.map((_, index) => index + 10_000);
  return async (input) => {
    const url = String(input);
    if (url === TOP_URL) {
      return jsonResponse(ids);
    }
    if (url === NEW_URL) {
      return jsonResponse([]);
    }
    const id = itemIdFromUrl(url);
    const index = id === undefined ? -1 : ids.indexOf(id);
    return index < 0
      ? jsonResponse({ unavailable: true }, 404)
      : jsonResponse({ unavailable: true }, statuses[index]);
  };
}

describe("Hacker News collector", () => {
  it("derives the public item endpoint when no explicit template is supplied", async () => {
    const calls: string[] = [];
    const collector = createHackerNewsCollector({
      endpoints: { top: TOP_URL, new: NEW_URL },
      listLimit: 1,
    });
    const result = await collector.collect({
      http: createHttpClient({
        fetch: async (input) => {
          const url = String(input);
          calls.push(url);
          if (url === TOP_URL) {
            return jsonResponse([101]);
          }
          if (url === NEW_URL) {
            return jsonResponse([]);
          }
          if (url === "https://hn.test/v0/item/101.json") {
            return jsonResponse(itemFixtures["101"]);
          }
          return jsonResponse({}, 404);
        },
      }),
      now: () => NOW,
    });

    expect(calls).toContain("https://hn.test/v0/item/101.json");
    expect(result.items).toHaveLength(1);
  });

  it("rejects unsafe upstream IDs, counters, and excessive concurrency", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const baseStory = {
      id: 101,
      type: "story",
      time: 1_784_372_400,
      title: "Bounded story",
    };

    expect(HackerNewsStorySchema.safeParse({ ...baseStory, id: unsafe }).success).toBe(
      false,
    );
    expect(
      HackerNewsStorySchema.safeParse({ ...baseStory, score: unsafe }).success,
    ).toBe(false);
    expect(
      HackerNewsStorySchema.safeParse({ ...baseStory, descendants: unsafe })
        .success,
    ).toBe(false);
    expect(() => createCollector({ concurrency: 33 })).toThrow(/concurrency/i);
  });

  it("merges bounded top/new lists, deduplicates IDs, and retains both ranks", async () => {
    const { fetch, calls } = createFixtureFetch();
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.rawMetrics.hnId)).toEqual([
      101,
      102,
      107,
    ]);
    expect(result.items[0]?.rawMetrics).toMatchObject({
      hnId: 101,
      topRank: 1,
      newRank: null,
    });
    expect(result.items[1]?.rawMetrics).toMatchObject({
      hnId: 102,
      topRank: 2,
      newRank: 1,
    });
    expect(
      calls.filter((url) => url === "https://hn.test/v0/item/102.json"),
    ).toHaveLength(1);
    expect(result.rawEvidence).toMatchObject({
      listIds: { top: topIds, new: newIds },
      failureCounts: { lists: 0, itemRequests: 0, invalidItems: 1 },
    });
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("normalizes story metrics and uses the discussion URL for Ask HN", async () => {
    const { fetch } = createFixtureFetch();
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.items[0]).toEqual({
      source: "hacker-news",
      category: "community",
      title: "Node 22 ships a safer permission model",
      url: "https://example.test/node-22-permissions",
      author: "alice",
      publishedAt: "2026-07-18T11:00:00.000Z",
      comments: 7,
      score: 42,
      stars: null,
      summary: null,
      rawMetrics: {
        hnId: 101,
        discussionUrl: "https://news.ycombinator.com/item?id=101",
        topRank: 1,
        newRank: null,
        activityUnix: 1784372400,
        score: 42,
        descendants: 7,
      },
      collectedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(result.items[1]).toMatchObject({
      url: "https://news.ycombinator.com/item?id=102",
      author: "bob",
      comments: 3,
      score: 12,
      summary: "Looking for practical isolation patterns & verification loops.",
      collectedAt: "2026-07-18T12:00:00.000Z",
      rawMetrics: {
        discussionUrl: "https://news.ycombinator.com/item?id=102",
      },
    });
  });

  it("redacts untrusted story strings and URL secrets from items and evidence", async () => {
    const secrets = {
      title: `hn-title-${"a".repeat(24)}`,
      author: `hn-author-${"b".repeat(24)}`,
      text: `hn-text-${"c".repeat(24)}`,
      username: `hn-user-${"d".repeat(24)}`,
      password: `hn-password-${"e".repeat(24)}`,
      session: `hn-session-${"f".repeat(24)}`,
      clientSecret: `hn-client-${"g".repeat(24)}`,
      accessToken: `hn-access-${"h".repeat(24)}`,
    } as const;
    const story = itemFixtures["101"] as Record<string, unknown>;
    const { fetch } = createFixtureFetch({
      "https://hn.test/v0/item/101.json": () =>
        jsonResponse({
          ...story,
          title: `HN launch token=${secrets.title}`,
          by: `token=${secrets.author}`,
          text: `<p>session=${secrets.text}</p>`,
          url:
            `https://${secrets.username}:${secrets.password}@example.test/private` +
            `?session=${secrets.session}&client_secret=${secrets.clientSecret}` +
            `&access%5Ftoken=${secrets.accessToken}&view=full`,
        }),
    });

    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });
    const item = result.items.find((candidate) => candidate.rawMetrics.hnId === 101);
    const evidence = result.rawEvidence as unknown as {
      readonly items: readonly Record<string, unknown>[];
    };
    const rawStory = evidence.items.find((candidate) => candidate.id === 101);

    expect(item).toMatchObject({
      title: "HN launch token=[REDACTED]",
      author: "token=[REDACTED]",
      summary: "session=[REDACTED]",
      comments: 7,
      score: 42,
    });
    expect(rawStory).toMatchObject({
      by: "token=[REDACTED]",
      title: "HN launch token=[REDACTED]",
      text: "<p>session=[REDACTED]</p>",
      descendants: 7,
      score: 42,
    });
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(item)).not.toContain(secret);
      expect(JSON.stringify(rawStory)).not.toContain(secret);
    }

    for (const candidateUrl of [item?.url, rawStory?.url]) {
      expect(typeof candidateUrl).toBe("string");
      const parsedUrl = new URL(String(candidateUrl));
      expect(decodeURIComponent(parsedUrl.username)).toBe("[REDACTED]");
      expect(parsedUrl.password).toBe("");
      expect(parsedUrl.searchParams.get("session")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("client_secret")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("access_token")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("view")).toBe("full");
    }
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("removes encoded HTML before producing a safe short summary", async () => {
    const askStory = itemFixtures["102"] as Record<string, unknown>;
    const { fetch } = createFixtureFetch({
      "https://hn.test/v0/item/102.json": () =>
        jsonResponse({
          ...askStory,
          text: "&lt;script&gt;ignored&lt;/script&gt;<p>Useful &amp; safe.</p>",
        }),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.items.find((item) => item.rawMetrics.hnId === 102)?.summary).toBe(
      "Useful & safe.",
    );
  });

  it("keeps only stories published during the prior 24 hours", async () => {
    const { fetch } = createFixtureFetch();
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.items.map((item) => item.rawMetrics.hnId)).not.toContain(104);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: { filteredItems: 4 },
    });
  });

  it("skips dead, deleted, non-story, and malformed item payloads", async () => {
    const { fetch } = createFixtureFetch();
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.items.map((item) => item.rawMetrics.hnId)).toEqual([
      101,
      102,
      107,
    ]);
    expect(result.warning).toMatch(/invalid item payload/i);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: { invalidItems: 1 },
    });
  });

  it("skips one failed item request without failing the source", async () => {
    const failedItemUrl = "https://hn.test/v0/item/107.json";
    const { fetch } = createFixtureFetch({
      [failedItemUrl]: () => jsonResponse({ unavailable: true }, 404),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.rawMetrics.hnId)).toEqual([101, 102]);
    expect(result.warning).toMatch(/item request failed/i);
    expect(result.warning).not.toContain(failedItemUrl);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: { itemRequests: 1 },
    });
  });

  it.each([
    [429, "rate_limited"],
    [403, "blocked"],
  ] as const)(
    "reports all item HTTP %i failures as %s without a success timestamp",
    async (httpStatus, expectedStatus) => {
      const result = await createCollector().collect({
        http: createHttpClient({
          fetch: createItemStatusFetch([httpStatus, httpStatus, httpStatus]),
        }),
        now: () => NOW,
      });

      expect(result).toMatchObject({
        status: expectedStatus,
        items: [],
        rawEvidence: {
          failureCounts: {
            itemRequests: 3,
            itemFailuresByStatus: { [expectedStatus]: 3 },
          },
        },
      });
      expect(result).not.toHaveProperty("lastSuccessfulAt");
    },
  );

  it("reports mixed item request classifications as error", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: createItemStatusFetch([429, 403, 404]),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "error",
      items: [],
      rawEvidence: {
        failureCounts: {
          itemRequests: 3,
          itemFailuresByStatus: {
            rate_limited: 1,
            blocked: 1,
            error: 1,
          },
        },
      },
    });
    expect(result).not.toHaveProperty("lastSuccessfulAt");
  });

  it("remains ok when a valid filtered payload accompanies an item failure", async () => {
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === TOP_URL) {
        return jsonResponse([103, 104, 107]);
      }
      if (url === NEW_URL) {
        return jsonResponse([]);
      }
      const id = itemIdFromUrl(url);
      if (id === 107) {
        return jsonResponse({ unavailable: true }, 429);
      }
      return jsonResponse(id === undefined ? {} : itemFixtures[String(id)]);
    };
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "ok",
      items: [],
      lastSuccessfulAt: "2026-07-18T12:00:00.000Z",
      rawEvidence: {
        failureCounts: {
          itemRequests: 1,
          filteredItems: 2,
          itemFailuresByStatus: { rate_limited: 1 },
        },
      },
    });
    expect(result.warning).toMatch(/item request failed/i);
  });

  it("rejects a story whose payload ID does not match the requested list ID", async () => {
    const story = itemFixtures["107"] as Record<string, unknown>;
    const { fetch } = createFixtureFetch({
      "https://hn.test/v0/item/107.json": () =>
        jsonResponse({ ...story, id: 9_999 }),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.items.map((item) => item.rawMetrics.hnId)).toEqual([101, 102]);
    expect(result.items.map((item) => item.rawMetrics.hnId)).not.toContain(9_999);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: { invalidItems: 2 },
    });
  });

  it("bounds text retained in raw item evidence", async () => {
    const story = itemFixtures["101"] as Record<string, unknown>;
    const { fetch } = createFixtureFetch({
      "https://hn.test/v0/item/101.json": () =>
        jsonResponse({ ...story, text: "x".repeat(2_000) }),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });
    const evidence = result.rawEvidence as unknown as {
      readonly items: readonly { readonly id: number; readonly text: string | null }[];
    };

    expect(evidence.items.find((item) => item.id === 101)?.text).toHaveLength(512);
    expect(result.items.find((item) => item.rawMetrics.hnId === 101)?.summary).toHaveLength(
      280,
    );
  });

  it("degrades when one list fails and continues with the other list", async () => {
    const { fetch } = createFixtureFetch({
      [TOP_URL]: () => jsonResponse({ unavailable: true }, 403),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.rawMetrics.hnId)).toEqual([102]);
    expect(result.items[0]?.rawMetrics).toMatchObject({
      topRank: null,
      newRank: 1,
    });
    expect(result.warning).toMatch(/one list request failed/i);
    expect(result.warning).not.toContain(TOP_URL);
    expect(result.rawEvidence).toMatchObject({
      listIds: { top: [], new: newIds },
      failureCounts: { lists: 1 },
    });
  });

  it("returns a typed degraded result when both lists fail", async () => {
    const { fetch, calls } = createFixtureFetch({
      [TOP_URL]: () => jsonResponse({ unavailable: true }, 429),
      [NEW_URL]: () => jsonResponse({ unavailable: true }, 429),
    });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      sourceId: "hacker-news",
      status: "rate_limited",
      fetchedAt: "2026-07-18T12:00:00.000Z",
      items: [],
      warning: "Hacker News list requests failed",
      rawEvidence: {
        listIds: { top: [], new: [] },
        items: [],
        failureCounts: { lists: 2, itemRequests: 0, invalidItems: 0 },
      },
    });
    expect(calls).toEqual([TOP_URL, NEW_URL]);
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("propagates a pre-aborted signal before either list request", async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort("operator stop");
    const outcome = await rejectionOf(
      createCollector().collect({
        http: createHttpClient({
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse([]);
          },
        }),
        now: () => NOW,
        signal: controller.signal,
      }),
    );

    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("operator stop");
    expect(fetchCalls).toBe(0);
  });

  it("propagates an abort while both list requests are in flight", async () => {
    let started = 0;
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const controller = new AbortController();
    const fetch: FetchLike = async (_input, init) => {
      started += 1;
      if (started === 2) {
        markBothStarted?.();
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const collection = createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
      signal: controller.signal,
    });
    await bothStarted;
    controller.abort("operator stop");

    const outcome = await rejectionOf(collection);
    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(started).toBe(2);
  });

  it("stops scheduling item workers and propagates a mid-flight abort", async () => {
    const ids = [...Array(8)].map((_, index) => index + 20_000);
    const scheduledIds: number[] = [];
    let itemRequestsStarted = 0;
    let markWorkersStarted: (() => void) | undefined;
    const workersStarted = new Promise<void>((resolve) => {
      markWorkersStarted = resolve;
    });
    const controller = new AbortController();
    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === TOP_URL) {
        return jsonResponse(ids);
      }
      if (url === NEW_URL) {
        return jsonResponse([]);
      }
      itemRequestsStarted += 1;
      if (itemRequestsStarted === 2) {
        markWorkersStarted?.();
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const collector = createHackerNewsCollector({
      endpoints: { top: TOP_URL, new: NEW_URL },
      itemUrl: (id) => {
        scheduledIds.push(id);
        return `https://hn.test/items/${id}`;
      },
      concurrency: 2,
    });
    const collection = collector.collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
      signal: controller.signal,
    });
    await workersStarted;
    controller.abort("operator stop");

    const outcome = await rejectionOf(collection);
    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(itemRequestsStarted).toBe(2);
    expect(scheduledIds).toHaveLength(2);
  });

  it("never exceeds the configured concurrent item-request bound", async () => {
    let active = 0;
    let maximumActive = 0;
    const { fetch } = createFixtureFetch(
      Object.fromEntries(
        [...Array(8)].map((_, index) => {
          const id = index + 101;
          return [
            `https://hn.test/v0/item/${id}.json`,
            async () => {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              await new Promise((resolve) => setTimeout(resolve, 5));
              active -= 1;
              return jsonResponse(itemFixtures[String(id)]);
            },
          ];
        }),
      ),
    );

    await createCollector({ concurrency: 2 }).collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(maximumActive).toBe(2);
  });

  it("defaults to eight concurrent item requests", async () => {
    const ids = [...Array(12)].map((_, index) => index + 1_000);
    let active = 0;
    let maximumActive = 0;
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === TOP_URL) {
        return jsonResponse(ids);
      }
      if (url === NEW_URL) {
        return jsonResponse([]);
      }
      const id = itemIdFromUrl(url);
      if (id === undefined) {
        return jsonResponse({}, 404);
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({
        id,
        type: "story",
        by: "fixture",
        time: 1784372400,
        title: `Story ${id}`,
      });
    };

    await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(maximumActive).toBe(8);
  });

  it("defaults to the first 50 IDs from each source list before deduplication", async () => {
    const top = [...Array(60)].map((_, index) => index + 2_000);
    const fresh = [...Array(60)].map((_, index) => index + 3_000);
    const itemCalls: number[] = [];
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === TOP_URL) {
        return jsonResponse(top);
      }
      if (url === NEW_URL) {
        return jsonResponse(fresh);
      }
      const id = itemIdFromUrl(url);
      if (id === undefined) {
        return jsonResponse({}, 404);
      }
      itemCalls.push(id);
      return jsonResponse({
        id,
        type: "story",
        time: 1784372400,
        title: `Story ${id}`,
      });
    };

    await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(itemCalls).toHaveLength(100);
    expect(itemCalls).toContain(2_049);
    expect(itemCalls).not.toContain(2_050);
    expect(itemCalls).toContain(3_049);
    expect(itemCalls).not.toContain(3_050);
  });
});
