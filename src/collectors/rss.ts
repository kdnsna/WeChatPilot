import Parser from "rss-parser";

import { HttpError } from "../lib/http.js";
import {
  normalizeRssEntry,
  type RssFeedDescriptor,
} from "../normalizers/rss.js";
import {
  sanitizeCandidateString,
  sanitizeRawEvidence,
} from "../normalizers/sanitize.js";
import type {
  Collector,
  CollectorContext,
  CollectorResult,
  SourceStatus,
} from "../types/collector.js";
import type { ItemCategory, NormalizedItem } from "../types/item.js";
import { classifyCollectorError, rethrowIfAborted } from "./errors.js";

export const RSS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const DEFAULT_ITEM_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FEEDS = 64;
const MAX_ITEM_LIMIT = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_NAME_LENGTH = 128;
const MAX_URL_LENGTH = 2_048;

interface ParsedExtraFields {
  readonly author?: string;
  readonly id?: string;
}

export interface RssFeedOptions {
  readonly id: string;
  readonly name?: string;
  readonly url: string;
  readonly category?: ItemCategory;
}

export interface RssCollectorOptions {
  readonly feeds: readonly RssFeedOptions[];
  readonly itemLimitPerFeed?: number;
  readonly timeoutMs?: number;
}

interface FeedEvidence {
  readonly feedId: string;
  readonly status: SourceStatus;
  readonly receivedItems: number;
  readonly validItems: number;
  readonly invalidItems: number;
  readonly truncatedItems: number;
}

interface FeedOutcome {
  readonly evidence: FeedEvidence;
  readonly items: readonly NormalizedItem[];
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value;
}

function normalizedEndpoint(value: string): string {
  if (value.length > MAX_URL_LENGTH) {
    throw new TypeError("RSS feed URL is too long");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("RSS feeds must use public HTTP or HTTPS URLs");
  }
  return parsed.toString();
}

function normalizedIdentifier(value: string, label: string): string {
  const normalized = sanitizeCandidateString(value.normalize("NFKC").trim());
  if (normalized === "" || normalized.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return normalized;
}

function normalizedFeeds(feeds: readonly RssFeedOptions[]): readonly RssFeedOptions[] {
  if (feeds.length === 0 || feeds.length > MAX_FEEDS) {
    throw new RangeError(`feeds must contain between 1 and ${MAX_FEEDS} entries`);
  }
  const normalized = feeds.map((feed) => ({
    id: normalizedIdentifier(feed.id, "RSS feed id"),
    ...(feed.name === undefined
      ? {}
      : { name: normalizedIdentifier(feed.name, "RSS feed name") }),
    url: normalizedEndpoint(feed.url),
    ...(feed.category === undefined ? {} : { category: feed.category }),
  }));
  if (new Set(normalized.map((feed) => feed.id)).size !== normalized.length) {
    throw new TypeError("RSS feed ids must be unique");
  }
  return normalized;
}

function failedFeedEvidence(
  feedId: string,
  status: SourceStatus,
): FeedEvidence {
  return {
    feedId,
    status,
    receivedItems: 0,
    validItems: 0,
    invalidItems: 0,
    truncatedItems: 0,
  };
}

function aggregateFailureStatus(
  outcomes: readonly FeedOutcome[],
): SourceStatus {
  const statuses = outcomes.map(({ evidence }) => evidence.status);
  const first = statuses[0] ?? "error";
  return statuses.every((status) => status === first) ? first : "error";
}

function collectionWarning(
  failedFeeds: number,
  invalidItems: number,
  truncatedItems: number,
): string | undefined {
  const warnings: string[] = [];
  if (failedFeeds > 0) {
    warnings.push(`${failedFeeds} feed${failedFeeds === 1 ? "" : "s"} failed`);
  }
  if (invalidItems > 0) {
    warnings.push(
      `${invalidItems} invalid item${invalidItems === 1 ? "" : "s"} skipped`,
    );
  }
  if (truncatedItems > 0) {
    warnings.push(
      `${truncatedItems} item${truncatedItems === 1 ? "" : "s"} omitted by limits`,
    );
  }
  return warnings.length === 0
    ? undefined
    : `RSS collection degraded: ${warnings.join("; ")}`;
}

export function createRssCollector(options: RssCollectorOptions): Collector {
  const feeds = normalizedFeeds(options.feeds);
  const itemLimit = boundedPositiveInteger(
    options.itemLimitPerFeed ?? DEFAULT_ITEM_LIMIT,
    "itemLimitPerFeed",
    MAX_ITEM_LIMIT,
  );
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAX_TIMEOUT_MS,
  );
  async function collectFeed(
    feed: RssFeedOptions,
    context: CollectorContext,
    collectedAt: string,
  ): Promise<FeedOutcome> {
    let xml: string;
    try {
      xml = await context.http.getText(feed.url, {
        signal: context.signal,
        timeoutMs,
        maxResponseBytes: RSS_MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      const status = classifyCollectorError(error, context.signal);
      return { evidence: failedFeedEvidence(feed.id, status), items: [] };
    }
    rethrowIfAborted(context.signal);

    const parser = new Parser<Record<string, never>, ParsedExtraFields>();
    let parsed: Awaited<ReturnType<typeof parser.parseString>>;
    try {
      parsed = await parser.parseString(xml);
    } catch {
      const status = classifyCollectorError(
        new HttpError({ kind: "invalid_response", retryable: false }),
        context.signal,
      );
      return { evidence: failedFeedEvidence(feed.id, status), items: [] };
    }
    rethrowIfAborted(context.signal);

    const receivedItems = parsed.items.length;
    const candidates = parsed.items.slice(0, itemLimit);
    const normalizedItems: NormalizedItem[] = [];
    let invalidItems = 0;
    const descriptor: RssFeedDescriptor = {
      id: feed.id,
      url: feed.url,
      ...(feed.category === undefined ? {} : { category: feed.category }),
    };
    for (const candidate of candidates) {
      try {
        normalizedItems.push(
          normalizeRssEntry(candidate, descriptor, collectedAt),
        );
      } catch {
        invalidItems += 1;
      }
    }

    return {
      evidence: {
        feedId: feed.id,
        status: "ok",
        receivedItems,
        validItems: normalizedItems.length,
        invalidItems,
        truncatedItems: Math.max(0, receivedItems - candidates.length),
      },
      items: normalizedItems,
    };
  }

  return {
    sourceId: "rss",
    async collect(context: CollectorContext): Promise<CollectorResult> {
      const collectedAt = context.now().toISOString();
      const outcomes = await Promise.all(
        feeds.map(async (feed) => await collectFeed(feed, context, collectedAt)),
      );
      rethrowIfAborted(context.signal);
      const successfulFeeds = outcomes.filter(
        ({ evidence }) => evidence.status === "ok",
      ).length;
      const failedFeeds = outcomes.length - successfulFeeds;
      const invalidItems = outcomes.reduce(
        (total, { evidence }) => total + evidence.invalidItems,
        0,
      );
      const truncatedItems = outcomes.reduce(
        (total, { evidence }) => total + evidence.truncatedItems,
        0,
      );
      const status: SourceStatus =
        successfulFeeds > 0 ? "ok" : aggregateFailureStatus(outcomes);
      const warning = collectionWarning(
        failedFeeds,
        invalidItems,
        truncatedItems,
      );

      return {
        sourceId: "rss",
        status,
        fetchedAt: collectedAt,
        ...(successfulFeeds > 0 ? { lastSuccessfulAt: collectedAt } : {}),
        ...(warning === undefined ? {} : { warning }),
        items: outcomes.flatMap(({ items }) => items),
        rawEvidence: sanitizeRawEvidence({
          feeds: outcomes.map(({ evidence }) => evidence),
          failureCounts: {
            feeds: failedFeeds,
            invalidItems,
            truncatedItems,
          },
        }),
      };
    },
  };
}
