import { describe, expect, it } from "vitest";

import {
  canonicalizeUrl,
  clusterItems,
  titleSimilarity,
} from "../../src/ranking/cluster.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const collectedAt = "2026-07-18T00:00:00.000Z";

function item(source: string, title: string, url: string): NormalizedItem {
  return {
    source,
    category: Category.NEWS,
    title,
    url,
    author: null,
    publishedAt: collectedAt,
    comments: null,
    score: null,
    stars: null,
    summary: null,
    rawMetrics: {},
    collectedAt,
  };
}

describe("ranking clusters", () => {
  it("canonicalizes tracking variants without changing meaningful query data", () => {
    expect(
      canonicalizeUrl(
        "https://EXAMPLE.com/article/?utm_source=mail&b=2&a=1#comments",
        true,
      ),
    ).toBe("https://example.com/article?a=1&b=2");
    expect(
      canonicalizeUrl("https://example.com/article?id=7&utm_campaign=x", false),
    ).toContain("utm_campaign=x");
  });

  it("detects equivalent English and Chinese titles with bounded similarity", () => {
    expect(
      titleSimilarity(
        "OpenAI releases a new Codex agent for developers",
        "OpenAI releases new Codex agent for developers",
      ).maximum,
    ).toBeGreaterThan(0.72);
    expect(
      titleSimilarity("新一代开源大模型正式发布", "新一代开源大模型正式发布：技术解析")
        .characterBigram,
    ).toBeGreaterThan(0.78);
    expect(titleSimilarity("Database engine internals", "New phone camera review").maximum).toBeLessThan(
      0.5,
    );
  });

  it("clusters exact canonical URLs and cross-domain near-identical headlines", () => {
    const clusters = clusterItems(
      [
        item("rss:one", "OpenAI releases a new Codex agent", "https://a.test/post?utm_source=x"),
        item("hacker-news", "OpenAI releases a new Codex agent", "https://a.test/post"),
        item("rss:two", "OpenAI releases new Codex agent", "https://b.test/news"),
        item("rss:three", "Linux scheduler deep dive", "https://c.test/linux"),
      ],
      {
        titleTokenSimilarityThreshold: 0.72,
        titleCharacterBigramThreshold: 0.78,
        stripTrackingParameters: true,
      },
    );

    expect(clusters.map((cluster) => cluster.items.length).sort()).toEqual([1, 3]);
  });
});
