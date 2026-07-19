import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RSS_MAX_RESPONSE_BYTES,
  createRssCollector,
} from "../../src/collectors/rss.js";
import { createHttpClient } from "../../src/lib/http.js";
import { normalizeRssEntry } from "../../src/normalizers/rss.js";
import { CollectorResultSchema } from "../../src/types/collector.js";
import { Category, NormalizedItemSchema } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T06:00:00.000Z");

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(`../fixtures/rss/${name}`, import.meta.url), "utf8");
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

describe("RSS normalizer", () => {
  it("cleans HTML, resolves relative links, redacts secrets, and runtime-parses the item", () => {
    const item = normalizeRssEntry(
      {
        title: "<b>AI</b> &amp; safety",
        link: "/posts/one?token=normalizer-secret&view=full",
        author: "Reporter",
        isoDate: "2026-07-18T05:00:00.000Z",
        summary:
          "<p>Useful <strong>context</strong>.</p><script>drop-me()</script> api_key=summary-secret",
        guid: "fixture-guid",
      },
      {
        id: "fixture-feed",
        url: "https://example.test/feed.xml",
        category: Category.DEEP_READING,
      },
      NOW.toISOString(),
    );

    expect(item).toEqual({
      source: "fixture-feed",
      category: "deep-reading",
      title: "AI & safety",
      url: "https://example.test/posts/one?token=[REDACTED]&view=full",
      author: "Reporter",
      publishedAt: "2026-07-18T05:00:00.000Z",
      comments: null,
      score: null,
      stars: null,
      summary: "Useful context. api_key=[REDACTED]",
      rawMetrics: {
        feedId: "fixture-feed",
        entryId: "fixture-guid",
      },
      collectedAt: NOW.toISOString(),
    });
    expect(NormalizedItemSchema.safeParse(item).success).toBe(true);
    expect(JSON.stringify(item)).not.toContain("normalizer-secret");
    expect(JSON.stringify(item)).not.toContain("summary-secret");
    expect(JSON.stringify(item)).not.toContain("drop-me");
  });
});

describe("RSS collector", () => {
  it("supports RSS 2.0 and Atom with per-item validation and bounded evidence", async () => {
    const rss2 = await fixture("rss2.xml");
    const atom = await fixture("atom.xml");
    const collector = createRssCollector({
      feeds: [
        { id: "rss-two", name: "RSS Two", url: "https://feeds.test/rss2.xml" },
        {
          id: "atom",
          name: "Atom",
          url: "https://atom.example.test/feed.xml",
          category: Category.DEEP_READING,
        },
      ],
    });

    const result = await collector.collect({
      http: createHttpClient({
        fetch: async (input) =>
          textResponse(String(input).includes("rss2") ? rss2 : atom),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      sourceId: "rss",
      status: "ok",
      fetchedAt: NOW.toISOString(),
      lastSuccessfulAt: NOW.toISOString(),
      items: [
        {
          source: "rss-two",
          category: "news",
          title: "AI & agents token=[REDACTED]",
          author: "Reporter One",
          publishedAt: "2026-07-18T04:00:00.000Z",
          comments: null,
          score: null,
          stars: null,
          summary: "A useful summary. context_token=[REDACTED]",
        },
        {
          source: "atom",
          category: "deep-reading",
          title: "Atom release & notes",
          url: "https://atom.example.test/stories/atom-release?client_secret=[REDACTED]&view=full",
          author: "Atom Author",
          publishedAt: "2026-07-18T05:15:00.000Z",
          summary: "Atom summary. api_key=[REDACTED]",
        },
      ],
      rawEvidence: {
        feeds: [
          {
            feedId: "rss-two",
            status: "ok",
            receivedItems: 2,
            validItems: 1,
            invalidItems: 1,
            truncatedItems: 0,
          },
          {
            feedId: "atom",
            status: "ok",
            receivedItems: 1,
            validItems: 1,
            invalidItems: 0,
            truncatedItems: 0,
          },
        ],
        failureCounts: {
          feeds: 0,
          invalidItems: 1,
          truncatedItems: 0,
        },
      },
    });
    expect(result.warning).toContain("1 invalid item");
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "rss-title-secret",
      "rss-query-secret",
      "rss-summary-secret",
      "feed-password",
      "atom-query-secret",
      "atom-summary-secret",
      "steal-rss-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("isolates malformed and failed feeds while retaining a successful feed", async () => {
    const rss2 = await fixture("rss2.xml");
    const malformed = await fixture("malformed.xml");
    const collector = createRssCollector({
      feeds: [
        { id: "healthy", name: "Healthy", url: "https://feeds.test/healthy" },
        { id: "broken-xml", name: "Broken", url: "https://feeds.test/broken" },
        { id: "blocked", name: "Blocked", url: "https://feeds.test/blocked" },
      ],
    });

    const result = await collector.collect({
      http: createHttpClient({
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/healthy")) return textResponse(rss2);
          if (url.endsWith("/broken")) return textResponse(malformed);
          return textResponse("do-not-retain blocked-body-secret", 403);
        },
      }),
      now: () => NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.items).toHaveLength(1);
    expect(result.warning).toContain("2 feeds failed");
    expect(result.rawEvidence).toMatchObject({
      feeds: [
        { feedId: "healthy", status: "ok" },
        { feedId: "broken-xml", status: "invalid" },
        { feedId: "blocked", status: "blocked" },
      ],
      failureCounts: { feeds: 2 },
    });
    expect(JSON.stringify(result)).not.toContain("blocked-body-secret");
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("enforces the 2 MiB response cap and degrades instead of throwing", async () => {
    const collector = createRssCollector({
      feeds: [
        { id: "oversized", name: "Oversized", url: "https://feeds.test/oversized" },
      ],
    });
    const result = await collector.collect({
      http: createHttpClient({
        fetch: async () =>
          new Response("not read", {
            headers: { "content-length": String(RSS_MAX_RESPONSE_BYTES + 1) },
          }),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      sourceId: "rss",
      status: "invalid",
      items: [],
      rawEvidence: {
        feeds: [{ feedId: "oversized", status: "invalid" }],
        failureCounts: { feeds: 1 },
      },
    });
  });

  it("propagates caller cancellation rather than converting it to degradation", async () => {
    const controller = new AbortController();
    controller.abort();
    const collector = createRssCollector({
      feeds: [{ id: "feed", name: "Feed", url: "https://feeds.test/one" }],
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
    const xml = await fixture("rss2.xml");
    const controller = new AbortController();
    const collector = createRssCollector({
      feeds: [{ id: "feed", name: "Feed", url: "https://feeds.test/one" }],
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

  it("rejects unbounded feed and item configurations", () => {
    expect(() =>
      createRssCollector({
        feeds: Array.from({ length: 65 }, (_, index) => ({
          id: `feed-${index}`,
          name: `Feed ${index}`,
          url: `https://feeds.test/${index}`,
        })),
      }),
    ).toThrow(RangeError);
    expect(() =>
      createRssCollector({
        feeds: [{ id: "feed", name: "Feed", url: "https://feeds.test/one" }],
        itemLimitPerFeed: 101,
      }),
    ).toThrow(RangeError);
  });
});
