import type { RankingConfig } from "../config/schema.js";
import type { NormalizedItem } from "../types/item.js";
import { canonicalizeUrl, clusterItems, titleSimilarity } from "./cluster.js";
import { percentileRanks } from "./percentile.js";

export interface SentHistoryItem {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly sentAt: string;
}

export interface ScoreComponents {
  readonly engagement: number;
  readonly popularity: number;
  readonly velocity: number;
  readonly recency: number;
  readonly crossSource: number;
  readonly sourceQuality: number;
}

export type VelocityMetric =
  | "starDelta"
  | "starGrowthPerDay"
  | "starsPerDayLifetime"
  | "engagementPerHour"
  | "none";

export interface RankedItem {
  readonly item: NormalizedItem;
  readonly heatScore: number;
  readonly baseHeatScore: number;
  readonly components: ScoreComponents;
  readonly historyFactor: number;
  readonly velocityMetric: VelocityMetric;
  readonly confirmedBy: readonly string[];
  readonly relatedUrls: readonly string[];
  readonly duplicateCount: number;
  readonly reason: string;
}

interface ItemMetrics {
  readonly engagement: number | null;
  readonly popularity: number | null;
  readonly velocity: number | null;
  readonly velocityMetric: VelocityMetric;
}

function sourceFamily(source: string): keyof RankingConfig["sourceWeights"] {
  const lower = source.toLocaleLowerCase("en-US");
  if (lower === "hacker-news" || lower.startsWith("hacker-news:")) {
    return "hackerNews";
  }
  if (lower === "v2ex" || lower.startsWith("v2ex:")) {
    return "v2ex";
  }
  if (lower === "github" || lower.startsWith("github:")) {
    return "github";
  }
  if (lower === "reddit" || lower.startsWith("reddit:")) {
    return "reddit";
  }
  return "rss";
}

function safeHackerNewsDiscussionUrl(item: NormalizedItem): string | null {
  if (sourceFamily(item.source) !== "hackerNews") {
    return null;
  }
  const hnId = item.rawMetrics.hnId;
  const discussionUrl = item.rawMetrics.discussionUrl;
  if (
    typeof hnId !== "number" ||
    !Number.isSafeInteger(hnId) ||
    hnId <= 0 ||
    typeof discussionUrl !== "string"
  ) {
    return null;
  }
  const expected = `https://news.ycombinator.com/item?id=${hnId}`;
  return discussionUrl === expected ? discussionUrl : null;
}

function metricNumber(item: NormalizedItem, key: string): number | null {
  const value = item.rawMetrics[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function signedMetricNumber(item: NormalizedItem, key: string): number | null {
  const value = item.rawMetrics[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function itemMetrics(item: NormalizedItem, now: Date): ItemMetrics {
  const dailyStarGrowth = signedMetricNumber(item, "starGrowthPerDay");
  const starDelta =
    signedMetricNumber(item, "starDelta24h") ??
    signedMetricNumber(item, "starDelta");
  const lifetimePace = metricNumber(item, "starsPerDay");
  const publishedAt =
    item.publishedAt === null ? null : Date.parse(item.publishedAt);
  const engagementVelocity =
    publishedAt === null || item.comments === null
      ? null
      : item.comments /
        Math.max(1, (now.getTime() - publishedAt) / 3_600_000);
  return {
    engagement: item.comments,
    popularity: item.stars ?? item.score,
    velocity:
      dailyStarGrowth !== null
        ? Math.max(0, dailyStarGrowth)
        : starDelta !== null
          ? Math.max(0, starDelta)
          : lifetimePace ?? engagementVelocity,
    velocityMetric:
      dailyStarGrowth !== null
        ? "starGrowthPerDay"
        : starDelta !== null
          ? "starDelta"
          : lifetimePace !== null
            ? "starsPerDayLifetime"
            : engagementVelocity !== null
              ? "engagementPerHour"
              : "none",
  };
}

function recencyScore(item: NormalizedItem, now: Date, halfLifeHours: number): number {
  const timestamp = Date.parse(item.publishedAt ?? item.collectedAt);
  const ageHours = Math.max(0, (now.getTime() - timestamp) / 3_600_000);
  return Math.max(0, Math.min(1, 2 ** (-ageHours / halfLifeHours)));
}

function crossSourceScore(distinctSources: number, cap: number): number {
  if (distinctSources <= 1) {
    return 0;
  }
  if (cap <= 1) {
    return 1;
  }
  return Math.min(1, (Math.min(distinctSources, cap) - 1) / (cap - 1));
}

function weightedScore(
  components: ScoreComponents,
  weights: RankingConfig["formula"]["weights"],
): number {
  return (
    components.engagement * weights.engagement +
    components.popularity * weights.popularity +
    components.velocity * weights.velocity +
    components.recency * weights.recency +
    components.crossSource * weights.crossSource +
    components.sourceQuality * weights.sourceQuality
  );
}

function recentHistoryMatch(
  items: readonly NormalizedItem[],
  history: readonly SentHistoryItem[],
  config: RankingConfig,
  now: Date,
): boolean {
  const cutoff = now.getTime() - config.history.lookbackDays * 86_400_000;
  return history.some((entry) => {
    const sentAt = Date.parse(entry.sentAt);
    if (!Number.isFinite(sentAt) || sentAt < cutoff || sentAt > now.getTime()) {
      return false;
    }
    const historyUrl = canonicalizeUrl(
      entry.url,
      config.clustering.stripTrackingParameters,
    );
    return items.some((item) => {
      if (
        canonicalizeUrl(item.url, config.clustering.stripTrackingParameters) ===
        historyUrl
      ) {
        return true;
      }
      const similarity = titleSimilarity(item.title, entry.title);
      return (
        similarity.token >= config.clustering.titleTokenSimilarityThreshold ||
        similarity.characterBigram >=
          config.clustering.titleCharacterBigramThreshold
      );
    });
  });
}

const COMPONENT_LABELS: Readonly<Record<keyof ScoreComponents, string>> = {
  engagement: "来源内讨论度",
  popularity: "来源内热度",
  velocity: "增长速度",
  recency: "发布时间",
  crossSource: "跨来源印证",
  sourceQuality: "来源质量",
};

function selectionReason(
  components: ScoreComponents,
  confirmedBy: readonly string[],
  historyFactor: number,
  historyLookbackDays: number,
): string {
  const strongest = (Object.entries(components) as Array<[
    keyof ScoreComponents,
    number,
  ]>)
    .filter(([key, value]) => key !== "crossSource" && value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([key, value]) => `${COMPONENT_LABELS[key]} ${Math.round(value * 100)}%`);
  if (confirmedBy.length > 1) {
    strongest.push(`${confirmedBy.length} 个来源交叉印证`);
  }
  if (historyFactor < 1) {
    strongest.push(`近 ${historyLookbackDays} 天已推送内容降权`);
  }
  return strongest.join("；");
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function rankAndDeduplicate(
  items: readonly NormalizedItem[],
  history: readonly SentHistoryItem[],
  config: RankingConfig,
  now: Date,
): readonly RankedItem[] {
  const metrics = items.map((item) => itemMetrics(item, now));
  const componentByItem = new Map<NormalizedItem, Omit<ScoreComponents, "crossSource">>();
  const groupedIndexes = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    const family = sourceFamily(item.source);
    const indexes = groupedIndexes.get(family) ?? [];
    indexes.push(index);
    groupedIndexes.set(family, indexes);
  }

  for (const [family, indexes] of groupedIndexes) {
    const engagement = percentileRanks(
      indexes.map((index) => metrics[index]?.engagement ?? null),
    );
    const popularity = percentileRanks(
      indexes.map((index) => metrics[index]?.popularity ?? null),
    );
    const velocity = percentileRanks(
      indexes.map((index) => metrics[index]?.velocity ?? null),
    );
    for (const [localIndex, itemIndex] of indexes.entries()) {
      const item = items[itemIndex];
      if (item === undefined) {
        continue;
      }
      componentByItem.set(item, {
        engagement: engagement[localIndex] ?? 0,
        popularity: popularity[localIndex] ?? 0,
        velocity: velocity[localIndex] ?? 0,
        recency: recencyScore(item, now, config.recency.halfLifeHours),
        sourceQuality: Math.max(
          0,
          Math.min(1, config.sourceWeights[family as keyof typeof config.sourceWeights]),
        ),
      });
    }
  }

  const ranked = clusterItems(items, config.clustering).map((cluster): RankedItem => {
    const confirmedBy = [...new Set(cluster.items.map((item) => item.source))].sort();
    const crossSource = crossSourceScore(
      confirmedBy.length,
      config.crossSource.confirmationCap,
    );
    const scoredCandidates = cluster.items.map((item) => {
      const partial = componentByItem.get(item);
      if (partial === undefined) {
        throw new Error("missing normalized score components");
      }
      const components: ScoreComponents = { ...partial, crossSource };
      return {
        item,
        components,
        weighted: weightedScore(components, config.formula.weights),
      };
    });
    scoredCandidates.sort(
      (left, right) =>
        right.weighted - left.weighted ||
        Date.parse(right.item.publishedAt ?? right.item.collectedAt) -
          Date.parse(left.item.publishedAt ?? left.item.collectedAt) ||
        left.item.url.localeCompare(right.item.url),
    );
    const representative = scoredCandidates[0];
    if (representative === undefined) {
      throw new Error("ranking cluster must contain at least one item");
    }
    const repeated = recentHistoryMatch(cluster.items, history, config, now);
    const historyFactor = repeated ? config.history.repeatFactor : 1;
    const baseHeatScore = roundScore(representative.weighted * 100);
    const relatedUrls = [
      ...new Set(
        cluster.items.flatMap((item) => {
          const discussionUrl = safeHackerNewsDiscussionUrl(item);
          return discussionUrl === null
            ? [item.url]
            : [item.url, discussionUrl];
        }),
      ),
    ];
    const representativeIndex = items.indexOf(representative.item);

    return {
      item: representative.item,
      heatScore: roundScore(baseHeatScore * historyFactor),
      baseHeatScore,
      components: representative.components,
      historyFactor,
      velocityMetric: metrics[representativeIndex]?.velocityMetric ?? "none",
      confirmedBy,
      relatedUrls,
      duplicateCount: cluster.items.length - 1,
      reason: selectionReason(
        representative.components,
        confirmedBy,
        historyFactor,
        config.history.lookbackDays,
      ),
    };
  });

  return ranked.sort(
    (left, right) =>
      right.heatScore - left.heatScore ||
      Date.parse(right.item.publishedAt ?? right.item.collectedAt) -
        Date.parse(left.item.publishedAt ?? left.item.collectedAt) ||
      left.item.url.localeCompare(right.item.url),
  );
}
