import type { CollectorResult } from "../types/collector.js";
import type { NormalizedItem, RawMetricValue } from "../types/item.js";
import type { RankedItem, ScoreComponents, VelocityMetric } from "../ranking/score.js";
import { redactSecrets } from "../security/redact.js";
import { shanghaiDateKey } from "../lib/time.js";

export type DigestLane = "community" | "news" | "github" | "deepReading";

export interface DigestCandidate {
  readonly id: string;
  readonly lanes: readonly DigestLane[];
  readonly source: string;
  readonly category: NormalizedItem["category"];
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly comments: number | null;
  readonly score: number | null;
  readonly stars: number | null;
  readonly summary: string | null;
  readonly rawMetrics: Readonly<Record<string, RawMetricValue>>;
  readonly heatScore: number;
  readonly components: ScoreComponents;
  readonly historyFactor: number;
  readonly velocityMetric: VelocityMetric;
  readonly confirmedBy: readonly string[];
  readonly relatedUrls: readonly string[];
  readonly reason: string;
}

export interface DigestCandidateBundle {
  readonly version: 1;
  readonly date: string;
  readonly generatedAt: string;
  readonly timezone: "Asia/Shanghai";
  readonly quotas: {
    readonly community: 3;
    readonly news: 5;
    readonly github: 3;
    readonly deepReading: 2;
  };
  readonly sourceStatuses: readonly {
    readonly source: string;
    readonly status: string;
    readonly itemCount: number;
  }[];
  readonly candidates: readonly DigestCandidate[];
}

const DEEP_SOURCES = new Set([
  "ars-technica",
  "mit-technology-review",
  "the-register",
  "wired",
  "openai",
  "deepmind",
  "google-ai",
  "microsoft-ai",
  "hugging-face",
  "mistral-ai",
  "nvidia",
]);

function depthScore(entry: RankedItem): number {
  const summaryLength = entry.item.summary?.length ?? 0;
  return (
    entry.heatScore +
    Math.min(20, summaryLength / 50) +
    (DEEP_SOURCES.has(entry.item.source) ? 15 : 0) +
    (entry.item.category === "deep-reading" ? 20 : 0)
  );
}

function addLane(
  selected: Map<string, { ranked: RankedItem; lanes: Set<DigestLane> }>,
  entries: readonly RankedItem[],
  lane: DigestLane,
): void {
  for (const ranked of entries) {
    const existing = selected.get(ranked.item.url);
    if (existing === undefined) {
      selected.set(ranked.item.url, { ranked, lanes: new Set([lane]) });
    } else {
      existing.lanes.add(lane);
    }
  }
}

function candidate(
  id: string,
  ranked: RankedItem,
  lanes: ReadonlySet<DigestLane>,
): DigestCandidate {
  return {
    id,
    lanes: [...lanes],
    source: ranked.item.source,
    category: ranked.item.category,
    title: ranked.item.title,
    url: ranked.item.url,
    author: ranked.item.author,
    publishedAt: ranked.item.publishedAt,
    comments: ranked.item.comments,
    score: ranked.item.score,
    stars: ranked.item.stars,
    summary: ranked.item.summary,
    rawMetrics: ranked.item.rawMetrics,
    heatScore: ranked.heatScore,
    components: ranked.components,
    historyFactor: ranked.historyFactor,
    velocityMetric: ranked.velocityMetric,
    confirmedBy: ranked.confirmedBy,
    relatedUrls: ranked.relatedUrls,
    reason: ranked.reason,
  };
}

export function buildCandidateBundle(
  ranked: readonly RankedItem[],
  sourceResults: readonly CollectorResult[],
  now: Date,
): DigestCandidateBundle {
  const selected = new Map<
    string,
    { ranked: RankedItem; lanes: Set<DigestLane> }
  >();
  const community = ranked.filter(
    (entry) => entry.item.category === "community",
  );
  const github = ranked.filter((entry) => entry.item.category === "github");
  const news = ranked.filter(
    (entry) =>
      entry.item.category === "news" ||
      entry.item.category === "deep-reading",
  );
  const deepReading = [...news]
    .sort((left, right) => depthScore(right) - depthScore(left))
    .slice(0, 8);
  addLane(selected, community.slice(0, 8), "community");
  addLane(selected, news.slice(0, 18), "news");
  addLane(selected, github.slice(0, 8), "github");
  addLane(selected, deepReading, "deepReading");

  return {
    version: 1,
    date: shanghaiDateKey(now),
    generatedAt: now.toISOString(),
    timezone: "Asia/Shanghai",
    quotas: { community: 3, news: 5, github: 3, deepReading: 2 },
    sourceStatuses: sourceResults.map((result) => ({
      source: result.sourceId,
      status: result.status,
      itemCount: result.items.length,
    })),
    candidates: [...selected.values()].map(({ ranked: entry, lanes }, index) =>
      candidate(`C${String(index + 1).padStart(3, "0")}`, entry, lanes),
    ),
  };
}

function escapedJson(value: unknown): string {
  const redacted = redactSecrets(value);
  return JSON.stringify(redacted, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function buildDigestPrompt(
  basePrompt: string,
  bundle: DigestCandidateBundle,
): string {
  return `${basePrompt.trim()}\n\n以下是本次唯一允许使用的候选数据：\n<candidate_data>\n${escapedJson(bundle)}\n</candidate_data>\n`;
}
