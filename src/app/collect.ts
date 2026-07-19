import { join } from "node:path";

import { createGitHubCollector } from "../collectors/github.js";
import { createHackerNewsCollector } from "../collectors/hacker-news.js";
import { createRedditCollector } from "../collectors/reddit.js";
import { createRssCollector } from "../collectors/rss.js";
import {
  runCollectors,
  type CollectionRunResult,
  type RegisteredCollector,
} from "../collectors/run.js";
import { createV2exCollector } from "../collectors/v2ex.js";
import { loadConfig, type ProjectConfig } from "../config/load.js";
import {
  loadPriorGitHubSnapshot,
  recordGitHubSnapshot,
  type PriorGitHubSnapshot,
} from "../history/github-snapshots.js";
import { loadSentHistory } from "../history/store.js";
import {
  createHttpClient,
  type FetchLike,
  type HttpClient,
} from "../lib/http.js";
import { createJsonlLogger } from "../lib/logger.js";
import { createProjectPaths } from "../lib/paths.js";
import { shanghaiDateKey } from "../lib/time.js";
import {
  rankAndDeduplicate,
  type RankedItem,
} from "../ranking/score.js";
import {
  persistCollectionArtifacts,
  type CollectionArtifactPaths,
} from "../storage/artifacts.js";

export interface DailyCollectionOptions {
  readonly projectRoot: string;
  readonly now?: Date;
  readonly githubToken?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
  readonly httpClient?: HttpClient;
  readonly registrations?: readonly RegisteredCollector[];
  readonly minimumCoreSuccesses?: number;
}

export interface DailyCollectionResult {
  readonly collection: CollectionRunResult;
  readonly ranked: readonly RankedItem[];
  readonly artifacts: CollectionArtifactPaths;
  readonly logPath: string;
  readonly invalidHistoryEntries: number;
  readonly invalidSnapshotEntries: number;
  readonly eligibleItemCount: number;
}

function configuredCollectors(
  config: ProjectConfig,
  snapshot: PriorGitHubSnapshot,
  githubToken: string | undefined,
): readonly RegisteredCollector[] {
  const sources = config.sources.sources;
  const githubSnapshotOptions =
    "snapshot" in snapshot
      ? {}
      : {
          previousStars: snapshot.stars,
          previousSnapshotAt: snapshot.capturedAt,
        };
  return [
    {
      tier: sources.hackerNews.tier,
      collector: createHackerNewsCollector({
        endpoints: sources.hackerNews.endpoints,
        windowHours: config.digest.windowHours,
      }),
    },
    {
      tier: sources.v2ex.tier,
      collector: createV2exCollector({
        endpoint: sources.v2ex.endpoint,
        technicalNodes: sources.v2ex.technicalNodes,
        technicalKeywords: sources.v2ex.technicalKeywords,
        windowHours: config.digest.windowHours,
      }),
    },
    {
      tier: sources.github.tier,
      collector: createGitHubCollector({
        endpoint: sources.github.endpoint,
        lookbackDays: sources.github.lookbackDays,
        minStars: sources.github.minimumStars,
        itemLimit: sources.github.itemLimit,
        ...(githubToken === undefined || githubToken === ""
          ? {}
          : { token: githubToken }),
        ...githubSnapshotOptions,
      }),
    },
    {
      tier: sources.rss.tier,
      collector: createRssCollector({
        feeds: sources.rss.feeds.map((feed) => ({
          id: feed.id,
          name: feed.name,
          url: feed.url,
        })),
      }),
    },
    {
      tier: sources.reddit.tier,
      collector: createRedditCollector({
        endpoint: sources.reddit.url,
        subreddits: sources.reddit.subreddits,
      }),
    },
  ];
}

function defaultFetch(): FetchLike {
  return async (input, init) => await globalThis.fetch(input, init);
}

function digestEligibleItems(
  collection: CollectionRunResult,
  now: Date,
  windowHours: number,
) {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  return collection.results.flatMap((result) =>
    result.items.filter((item) => {
      if (result.sourceId === "github") {
        return true;
      }
      if (item.publishedAt === null) {
        return false;
      }
      const publishedAt = Date.parse(item.publishedAt);
      return publishedAt >= cutoff && publishedAt <= now.getTime();
    }),
  );
}

export async function runDailyCollection(
  options: DailyCollectionOptions,
): Promise<DailyCollectionResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("now must be a valid date");
  }
  const paths = createProjectPaths(options.projectRoot);
  const dateKey = shanghaiDateKey(now);
  const logPath = join(paths.logs, `collection-${dateKey}.jsonl`);
  const logger = createJsonlLogger({
    projectRoot: options.projectRoot,
    filePath: logPath,
    now: () => now,
  });

  try {
    const config = loadConfig(options.projectRoot);
    const priorSnapshot = loadPriorGitHubSnapshot(options.projectRoot, now);
    const http =
      options.httpClient ??
      createHttpClient({
        fetch: options.fetch ?? defaultFetch(),
      });
    const registrations =
      options.registrations ??
      configuredCollectors(config, priorSnapshot, options.githubToken);
    await logger.info("collection started", {
      sourceCount: registrations.length,
      minimumCoreSuccesses: options.minimumCoreSuccesses ?? 2,
    });
    const collection = await runCollectors(
      registrations,
      { http, now: () => now, signal: options.signal },
      { minimumCoreSuccesses: options.minimumCoreSuccesses ?? 2 },
    );
    const history = loadSentHistory(
      options.projectRoot,
      now,
      config.ranking.history.lookbackDays,
    );
    const eligibleItems = digestEligibleItems(
      collection,
      now,
      config.digest.windowHours,
    );
    const ranked = rankAndDeduplicate(
      eligibleItems,
      history.items,
      config.ranking,
      now,
    );
    const artifacts = persistCollectionArtifacts(
      options.projectRoot,
      now,
      collection,
      ranked,
    );
    const github = collection.results.find(
      (result) => result.sourceId === "github" && result.status === "ok",
    );
    if (github !== undefined) {
      recordGitHubSnapshot(options.projectRoot, github.items, now);
    }
    await logger.info("collection completed", {
      sourceCount: collection.results.length,
      itemCount: collection.items.length,
      eligibleItemCount: eligibleItems.length,
      rankedCount: ranked.length,
      coreSuccesses: collection.coreSuccesses,
      degraded: collection.degraded,
      invalidHistoryEntries: history.invalidEntries,
      invalidSnapshotEntries: priorSnapshot.invalidEntries,
      runId: artifacts.runId,
    });
    return {
      collection,
      ranked,
      artifacts,
      logPath,
      invalidHistoryEntries: history.invalidEntries,
      invalidSnapshotEntries: priorSnapshot.invalidEntries,
      eligibleItemCount: eligibleItems.length,
    };
  } catch (error) {
    try {
      await logger.error("collection failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    } catch {
      // The original sanitized failure remains the authoritative result.
    }
    throw error;
  }
}
