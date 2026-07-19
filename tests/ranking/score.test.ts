import { describe, expect, it } from "vitest";

import type { RankingConfig } from "../../src/config/schema.js";
import { rankAndDeduplicate } from "../../src/ranking/score.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const collectedAt = NOW.toISOString();
const config: RankingConfig = {
  version: 1,
  formula: {
    weights: {
      engagement: 0.24,
      popularity: 0.2,
      velocity: 0.18,
      recency: 0.18,
      crossSource: 0.12,
      sourceQuality: 0.08,
    },
  },
  recency: { halfLifeHours: 12 },
  history: { lookbackDays: 7, repeatFactor: 0.35 },
  crossSource: { confirmationCap: 4 },
  sourceWeights: {
    hackerNews: 1,
    v2ex: 0.9,
    github: 1,
    rss: 0.9,
    reddit: 0.7,
  },
  clustering: {
    titleTokenSimilarityThreshold: 0.72,
    titleCharacterBigramThreshold: 0.78,
    stripTrackingParameters: true,
  },
};

function item(
  source: string,
  title: string,
  overrides: Partial<NormalizedItem> = {},
): NormalizedItem {
  return {
    source,
    category: Category.COMMUNITY,
    title,
    url: `https://example.test/${encodeURIComponent(source)}/${encodeURIComponent(title)}`,
    author: null,
    publishedAt: "2026-07-18T10:00:00.000Z",
    comments: null,
    score: null,
    stars: null,
    summary: null,
    rawMetrics: {},
    collectedAt,
    ...overrides,
  };
}

describe("rankAndDeduplicate", () => {
  it("normalizes engagement within each platform instead of adding raw counts", () => {
    const ranked = rankAndDeduplicate(
      [
        item("hacker-news", "HN leader", { comments: 100 }),
        item("hacker-news", "HN follower", { comments: 10 }),
        item("v2ex", "V2EX leader", { comments: 5 }),
        item("v2ex", "V2EX follower", { comments: 1 }),
      ],
      [],
      config,
      NOW,
    );
    const byTitle = new Map(ranked.map((entry) => [entry.item.title, entry]));

    expect(byTitle.get("HN leader")?.components.engagement).toBe(0.75);
    expect(byTitle.get("V2EX leader")?.components.engagement).toBe(0.75);
    expect(byTitle.get("HN follower")?.components.engagement).toBe(0.25);
    expect(byTitle.get("V2EX follower")?.components.engagement).toBe(0.25);
  });

  it("uses real GitHub delta when present and labels lifetime pace as a fallback", () => {
    const ranked = rankAndDeduplicate(
      [
        item("github", "Measured growth", {
          category: Category.GITHUB,
          stars: 50,
          rawMetrics: { starDelta: 8, starsPerDay: 2 },
        }),
        item("github", "No snapshot yet", {
          category: Category.GITHUB,
          stars: 500,
          rawMetrics: { starDelta: null, starsPerDay: 20 },
        }),
      ],
      [],
      config,
      NOW,
    );
    const measured = ranked.find((entry) => entry.item.title === "Measured growth");
    const fallback = ranked.find((entry) => entry.item.title === "No snapshot yet");

    expect(measured?.velocityMetric).toBe("starDelta");
    expect(fallback?.velocityMetric).toBe("starsPerDayLifetime");
    expect(measured?.components.velocity).toBe(0.25);
    expect(fallback?.components.velocity).toBe(0.75);
  });

  it("prefers window-normalized GitHub growth and never falls back on a known loss", () => {
    const ranked = rankAndDeduplicate(
      [
        item("github", "Daily gain", {
          category: Category.GITHUB,
          stars: 100,
          rawMetrics: {
            starDelta: 20,
            starDeltaWindowHours: 48,
            starGrowthPerDay: 10,
            starsPerDay: 50,
          },
        }),
        item("github", "Known loss", {
          category: Category.GITHUB,
          stars: 500,
          rawMetrics: {
            starDelta: -3,
            starDeltaWindowHours: 24,
            starGrowthPerDay: -3,
            starsPerDay: 100,
          },
        }),
      ],
      [],
      config,
      NOW,
    );
    const gain = ranked.find((entry) => entry.item.title === "Daily gain");
    const loss = ranked.find((entry) => entry.item.title === "Known loss");

    expect(gain?.velocityMetric).toBe("starGrowthPerDay");
    expect(loss?.velocityMetric).toBe("starGrowthPerDay");
    expect(gain?.components.velocity).toBe(0.75);
    expect(loss?.components.velocity).toBe(0.25);
  });

  it("ranks community discussion velocity per hour within its own platform", () => {
    const ranked = rankAndDeduplicate(
      [
        item("hacker-news", "Fast discussion", {
          publishedAt: "2026-07-18T10:00:00.000Z",
          comments: 40,
          score: 80,
        }),
        item("hacker-news", "Slow discussion", {
          publishedAt: "2026-07-17T12:00:00.000Z",
          comments: 80,
          score: 90,
        }),
        item("rss:one", "Metric unavailable", {
          category: Category.NEWS,
          comments: null,
          score: null,
        }),
      ],
      [],
      config,
      NOW,
    );
    const byTitle = new Map(ranked.map((entry) => [entry.item.title, entry]));

    expect(byTitle.get("Fast discussion")?.velocityMetric).toBe(
      "engagementPerHour",
    );
    expect(byTitle.get("Fast discussion")?.components.velocity).toBe(0.75);
    expect(byTitle.get("Slow discussion")?.components.velocity).toBe(0.25);
    expect(byTitle.get("Metric unavailable")?.components.velocity).toBe(0.5);
  });

  it("deduplicates one event, rewards distinct-source confirmation, and keeps links", () => {
    const ranked = rankAndDeduplicate(
      [
        item("rss:openai", "OpenAI launches Codex Agent", {
          category: Category.NEWS,
          url: "https://openai.test/codex?utm_source=rss",
        }),
        item("hacker-news", "OpenAI launches Codex Agent", {
          url: "https://openai.test/codex",
          comments: 120,
          score: 300,
          rawMetrics: {
            hnId: 42,
            discussionUrl: "https://news.ycombinator.com/item?id=42",
          },
        }),
        item("rss:other", "OpenAI launches new Codex Agent", {
          category: Category.NEWS,
          url: "https://news.test/codex",
        }),
      ],
      [],
      config,
      NOW,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.confirmedBy).toEqual([
      "hacker-news",
      "rss:openai",
      "rss:other",
    ]);
    expect(ranked[0]?.relatedUrls).toEqual(
      expect.arrayContaining([
        "https://openai.test/codex?utm_source=rss",
        "https://openai.test/codex",
        "https://news.test/codex",
        "https://news.ycombinator.com/item?id=42",
      ]),
    );
    expect(ranked[0]?.relatedUrls).toHaveLength(4);
    expect(ranked[0]?.components.crossSource).toBeCloseTo(2 / 3, 8);
    expect(ranked[0]?.reason).toMatch(/3 个来源/);
  });

  it("applies the configured seven-day repeat factor but ignores older history", () => {
    const candidate = item("rss:one", "A repeatable launch", {
      category: Category.NEWS,
      url: "https://example.test/launch?utm_source=feed",
    });
    const freshHistory = [
      {
        title: "A repeatable launch",
        url: "https://example.test/launch",
        source: "rss:archive",
        sentAt: "2026-07-15T08:00:00.000Z",
      },
    ];
    const oldHistory = [
      { ...freshHistory[0]!, sentAt: "2026-07-01T08:00:00.000Z" },
    ];

    const repeated = rankAndDeduplicate([candidate], freshHistory, config, NOW)[0]!;
    const old = rankAndDeduplicate([candidate], oldHistory, config, NOW)[0]!;

    expect(repeated.historyFactor).toBe(0.35);
    expect(repeated.heatScore).toBeCloseTo(old.heatScore * 0.35, 1);
    expect(repeated.reason).toMatch(/7 天/);
    expect(old.historyFactor).toBe(1);
  });

  it("uses the configured history window in the transparent reason", () => {
    const custom = {
      ...config,
      history: { lookbackDays: 3, repeatFactor: 0.4 },
    } satisfies RankingConfig;
    const candidate = item("rss:one", "Recent repeat", {
      category: Category.NEWS,
      url: "https://example.test/recent-repeat",
    });
    const result = rankAndDeduplicate(
      [candidate],
      [
        {
          title: candidate.title,
          url: candidate.url,
          source: "rss:two",
          sentAt: "2026-07-17T08:00:00.000Z",
        },
      ],
      custom,
      NOW,
    )[0]!;

    expect(result.reason).toMatch(/近 3 天/);
    expect(result.reason).not.toMatch(/近 7 天/);
  });

  it("orders deterministically by transparent heat score", () => {
    const ranked = rankAndDeduplicate(
      [
        item("reddit", "Low signal", {
          publishedAt: "2026-07-17T12:00:00.000Z",
        }),
        item("hacker-news", "High signal", { comments: 90, score: 200 }),
      ],
      [],
      config,
      NOW,
    );

    expect(ranked.map((entry) => entry.item.title)).toEqual([
      "High signal",
      "Low signal",
    ]);
    expect(ranked[0]!.heatScore).toBeGreaterThan(ranked[1]!.heatScore);
    expect(ranked.every((entry) => entry.heatScore >= 0 && entry.heatScore <= 100)).toBe(
      true,
    );
  });
});
