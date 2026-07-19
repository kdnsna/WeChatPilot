import { describe, expect, it } from "vitest";

import {
  Category,
  NormalizedItemSchema,
  type NormalizedItem,
} from "../../src/types/item.js";

const validItem: NormalizedItem = {
  source: "hacker-news",
  category: Category.COMMUNITY,
  title: "A useful systems article",
  url: "https://example.com/articles/systems",
  author: "Ada",
  publishedAt: "2026-07-18T01:30:00.000Z",
  comments: 12,
  score: 87,
  stars: null,
  summary: null,
  rawMetrics: {
    points: 87,
    featured: true,
    language: "TypeScript",
    unavailableMetric: null,
  },
  collectedAt: "2026-07-18T02:00:00.000Z",
};

describe("NormalizedItemSchema", () => {
  it("accepts a complete normalized item with nullable unavailable values", () => {
    expect(NormalizedItemSchema.parse(validItem)).toEqual(validItem);
  });

  it.each(["community", "news", "github", "deep-reading"])(
    "accepts the %s category",
    (category) => {
      expect(
        NormalizedItemSchema.parse({ ...validItem, category }).category,
      ).toBe(category);
    },
  );

  it("rejects a missing required field even when that field is nullable", () => {
    const { author: _omitted, ...withoutAuthor } = validItem;

    expect(NormalizedItemSchema.safeParse(withoutAuthor).success).toBe(false);
  });

  it("rejects unknown categories and non-ISO timestamps", () => {
    expect(
      NormalizedItemSchema.safeParse({
        ...validItem,
        category: "video",
        collectedAt: "July 18, 2026",
      }).success,
    ).toBe(false);
  });

  it.each([
    { nested: { value: 1 } },
    { list: [1, 2, 3] },
    { invalidNumber: Number.POSITIVE_INFINITY },
  ])("rejects non-scalar raw metrics: %j", (rawMetrics) => {
    expect(
      NormalizedItemSchema.safeParse({ ...validItem, rawMetrics }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    expect(
      NormalizedItemSchema.safeParse({
        ...validItem,
        authorization: "must-not-be-part-of-the-contract",
      }).success,
    ).toBe(false);
  });

  it("accepts zero for comments, score, and stars", () => {
    expect(
      NormalizedItemSchema.parse({
        ...validItem,
        comments: 0,
        score: 0,
        stars: 0,
      }),
    ).toMatchObject({ comments: 0, score: 0, stars: 0 });
  });

  it.each([
    ["comments", -1],
    ["comments", 1.5],
    ["score", -1],
    ["score", 1.5],
    ["stars", -1],
    ["stars", 1.5],
  ] as const)("rejects invalid %s value %s", (field, value) => {
    expect(
      NormalizedItemSchema.safeParse({ ...validItem, [field]: value }).success,
    ).toBe(false);
  });

  it.each([
    ["source", "s".repeat(129)],
    ["title", "t".repeat(513)],
    ["url", `https://example.test/${"u".repeat(4_097)}`],
    ["author", "a".repeat(257)],
    ["summary", "m".repeat(4_097)],
  ] as const)("rejects an oversized %s field", (field, value) => {
    expect(
      NormalizedItemSchema.safeParse({ ...validItem, [field]: value }).success,
    ).toBe(false);
  });

  it.each(["comments", "score", "stars"] as const)(
    "rejects an unsafe integer in %s",
    (field) => {
      expect(
        NormalizedItemSchema.safeParse({
          ...validItem,
          [field]: Number.MAX_SAFE_INTEGER + 1,
        }).success,
      ).toBe(false);
    },
  );

  it("bounds raw metric keys, values, and entry count", () => {
    expect(
      NormalizedItemSchema.safeParse({
        ...validItem,
        rawMetrics: { ["k".repeat(129)]: 1 },
      }).success,
    ).toBe(false);
    expect(
      NormalizedItemSchema.safeParse({
        ...validItem,
        rawMetrics: { note: "v".repeat(2_049) },
      }).success,
    ).toBe(false);
    expect(
      NormalizedItemSchema.safeParse({
        ...validItem,
        rawMetrics: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`metric-${index}`, index]),
        ),
      }).success,
    ).toBe(false);
  });
});
