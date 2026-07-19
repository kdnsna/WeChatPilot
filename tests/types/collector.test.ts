import { describe, expect, it } from "vitest";

import {
  CollectorResultSchema,
  JSONValueSchema,
  SOURCE_STATUSES,
  SourceHealthSchema,
  SourceStatusSchema,
  type Collector,
  type CollectorContext,
  type CollectorResult,
} from "../../src/types/collector.js";
import {
  Category,
  NormalizedItemSchema,
  type NormalizedItem,
} from "../../src/types/item.js";

const normalizedItem: NormalizedItem = {
  source: "fixture",
  category: Category.NEWS,
  title: "Fixture item",
  url: "https://example.test/item",
  author: null,
  publishedAt: null,
  comments: null,
  score: null,
  stars: null,
  summary: null,
  rawMetrics: {},
  collectedAt: "2026-07-18T02:00:00.000Z",
};

const validResult = {
  sourceId: "fixture",
  status: "ok",
  items: [normalizedItem],
  fetchedAt: "2026-07-18T02:00:00.000Z",
  lastSuccessfulAt: "2026-07-18T01:45:00.000Z",
  retryAt: "2026-07-18T02:15:00.000Z",
  warning: "public endpoint is nearing its limit",
  rawEvidence: {
    response: {
      page: 1,
      tags: ["ai", null, { verified: true }],
    },
  },
} as const;

describe("collector contracts", () => {
  it("publishes the complete source-status vocabulary", () => {
    expect(SOURCE_STATUSES).toEqual([
      "ok",
      "not_modified",
      "stale",
      "rate_limited",
      "unauthorized",
      "blocked",
      "timeout",
      "invalid",
      "error",
    ]);
    expect(SOURCE_STATUSES.every((status) => SourceStatusSchema.safeParse(status).success)).toBe(
      true,
    );
    expect(SourceStatusSchema.safeParse("pending").success).toBe(false);
  });

  it("strictly validates source health timestamps and metadata", () => {
    expect(
      SourceHealthSchema.parse({
        sourceId: validResult.sourceId,
        status: validResult.status,
        fetchedAt: validResult.fetchedAt,
        lastSuccessfulAt: validResult.lastSuccessfulAt,
        retryAt: validResult.retryAt,
        warning: validResult.warning,
      }),
    ).toMatchObject({ sourceId: "fixture", status: "ok" });
    expect(
      SourceHealthSchema.safeParse({
        sourceId: "fixture",
        status: "ok",
        fetchedAt: "July 18",
      }).success,
    ).toBe(false);
    expect(
      SourceHealthSchema.safeParse({
        sourceId: "fixture",
        status: "ok",
        fetchedAt: validResult.fetchedAt,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("accepts nested finite JSON evidence and complete collector results", () => {
    expect(JSONValueSchema.parse(validResult.rawEvidence)).toEqual(
      validResult.rawEvidence,
    );
    expect(CollectorResultSchema.parse(validResult)).toEqual(validResult);
  });

  it.each([
    ["function", () => undefined],
    ["bigint", 1n],
    ["undefined", undefined],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("rejects non-JSON or non-finite %s evidence", (_label, invalidValue) => {
    expect(JSONValueSchema.safeParse(invalidValue).success).toBe(false);
    expect(
      CollectorResultSchema.safeParse({
        ...validResult,
        rawEvidence: { nested: { invalidValue } },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid statuses, item timestamps, and unknown result fields", () => {
    expect(
      CollectorResultSchema.safeParse({ ...validResult, status: "pending" }).success,
    ).toBe(false);
    expect(
      CollectorResultSchema.safeParse({
        ...validResult,
        items: [{ ...normalizedItem, collectedAt: "not-iso" }],
      }).success,
    ).toBe(false);
    expect(
      CollectorResultSchema.safeParse({ ...validResult, secret: "extra" }).success,
    ).toBe(false);
    expect(NormalizedItemSchema.safeParse(normalizedItem).success).toBe(true);
  });

  it("supports an injected HTTP client, clock, and cancellation signal", async () => {
    const collector: Collector = {
      sourceId: "fixture",
      async collect(context: CollectorContext): Promise<CollectorResult> {
        const title = await context.http.getText("https://example.test/title", {
          signal: context.signal,
        });
        return {
          sourceId: this.sourceId,
          status: "ok",
          items: [{ ...normalizedItem, title }],
          fetchedAt: context.now().toISOString(),
          rawEvidence: { candidateCount: 1 },
        };
      },
    };
    const abortController = new AbortController();
    const context: CollectorContext = {
      http: {
        getJson: async () => ({}),
        getText: async () => "Injected title",
      },
      now: () => new Date("2026-07-18T02:00:00.000Z"),
      signal: abortController.signal,
    };

    await expect(collector.collect(context)).resolves.toMatchObject({
      sourceId: "fixture",
      status: "ok",
      fetchedAt: "2026-07-18T02:00:00.000Z",
      items: [{ title: "Injected title" }],
      rawEvidence: { candidateCount: 1 },
    });
  });

  it("rejects evidence deeper than the supported nesting limit", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) {
      nested = { child: nested };
    }

    expect(JSONValueSchema.safeParse(nested).success).toBe(false);
    expect(
      CollectorResultSchema.safeParse({
        ...validResult,
        rawEvidence: { nested },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized evidence strings, arrays, object keys, and payloads", () => {
    expect(JSONValueSchema.safeParse("x".repeat(16_385)).success).toBe(false);
    expect(
      JSONValueSchema.safeParse(Array.from({ length: 1_001 }, () => null))
        .success,
    ).toBe(false);
    expect(
      JSONValueSchema.safeParse({ ["k".repeat(129)]: true }).success,
    ).toBe(false);
    expect(
      CollectorResultSchema.safeParse({
        ...validResult,
        rawEvidence: { payload: "x".repeat(2 * 1_024 * 1_024) },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized source health diagnostics and item collections", () => {
    expect(
      SourceHealthSchema.safeParse({
        sourceId: "s".repeat(129),
        status: "ok",
        fetchedAt: validResult.fetchedAt,
      }).success,
    ).toBe(false);
    expect(
      SourceHealthSchema.safeParse({
        sourceId: "fixture",
        status: "error",
        fetchedAt: validResult.fetchedAt,
        warning: "w".repeat(1_025),
      }).success,
    ).toBe(false);
    expect(
      CollectorResultSchema.safeParse({
        ...validResult,
        items: Array.from({ length: 1_001 }, () => normalizedItem),
      }).success,
    ).toBe(false);
  });
});
