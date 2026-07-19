import { z } from "zod";

import {
  HackerNewsStorySchema,
  normalizeHackerNewsStory,
  type HackerNewsListRanks,
  type HackerNewsStory,
} from "../normalizers/hacker-news.js";
import {
  sanitizeCandidateString,
  sanitizeCandidateUrl,
  sanitizeEvidenceValue,
  sanitizeRawEvidence,
} from "../normalizers/sanitize.js";
import type {
  Collector,
  CollectorContext,
  CollectorResult,
  JsonValue,
  SourceStatus,
} from "../types/collector.js";
import type { NormalizedItem } from "../types/item.js";
import { classifyCollectorError } from "./errors.js";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_LIST_LIMIT = 500;
const MAX_CONCURRENCY = 32;
const MAX_EVIDENCE_ITEMS = 100;

const storyIdListSchema = z.array(z.number().int().positive());

export interface HackerNewsCollectorOptions {
  readonly endpoints: {
    readonly top: string;
    readonly new: string;
  };
  readonly itemUrlTemplate?: string;
  readonly itemUrl?: (id: number) => string;
  readonly listLimit?: number;
  readonly concurrency?: number;
  readonly windowHours?: number;
}

interface ListSuccess {
  readonly ok: true;
  readonly ids: readonly number[];
}

interface ListFailure {
  readonly ok: false;
  readonly ids: readonly number[];
  readonly status: SourceStatus;
}

type ListOutcome = ListSuccess | ListFailure;

interface ItemSuccess {
  readonly ok: true;
  readonly story: HackerNewsStory;
}

interface ItemFailure {
  readonly ok: false;
  readonly invalid: boolean;
  readonly status: ItemFailureStatus;
}

type ItemOutcome = ItemSuccess | ItemFailure;

const ITEM_FAILURE_STATUSES = [
  "unauthorized",
  "blocked",
  "rate_limited",
  "timeout",
  "invalid",
  "error",
] as const;

type ItemFailureStatus = (typeof ITEM_FAILURE_STATUSES)[number];

function requirePositiveInteger(
  value: number,
  label: string,
  maximum?: number,
): number {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value;
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive number`);
  }
  return value;
}

function requireWebUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Hacker News endpoints must use HTTP or HTTPS");
  }
  return parsed.toString();
}

function derivedItemUrlTemplate(topEndpoint: string): string {
  const placeholder = "__DAILY_TECH_ITEM_ID__";
  const parsed = new URL(topEndpoint);
  const replacedPath = parsed.pathname.replace(
    /\/(?:topstories|newstories)\.json$/,
    `/item/${placeholder}.json`,
  );
  parsed.pathname =
    replacedPath === parsed.pathname
      ? `/v0/item/${placeholder}.json`
      : replacedPath;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(placeholder, "{id}");
}

function createItemUrlBuilder(
  options: HackerNewsCollectorOptions,
  topEndpoint: string,
): (id: number) => string {
  if (options.itemUrl !== undefined) {
    return (id) => requireWebUrl(options.itemUrl?.(id) ?? "");
  }

  const template = options.itemUrlTemplate ?? derivedItemUrlTemplate(topEndpoint);
  if (!template.includes("{id}")) {
    throw new TypeError("Hacker News item URL template must contain {id}");
  }
  requireWebUrl(template.replaceAll("{id}", "1"));
  return (id) => requireWebUrl(template.replaceAll("{id}", String(id)));
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await task(value);
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all([...Array(workerCount)].map(async () => await worker()));
  return results;
}

function mergeFailureStatuses(statuses: readonly SourceStatus[]): SourceStatus {
  const firstStatus = statuses[0] ?? "error";
  return statuses.every((status) => status === firstStatus)
    ? firstStatus
    : "error";
}

function itemFailureStatus(status: SourceStatus): ItemFailureStatus {
  return ITEM_FAILURE_STATUSES.includes(status as ItemFailureStatus)
    ? (status as ItemFailureStatus)
    : "error";
}

function emptyItemFailureCounts(): Record<ItemFailureStatus, number> {
  return {
    unauthorized: 0,
    blocked: 0,
    rate_limited: 0,
    timeout: 0,
    invalid: 0,
    error: 0,
  };
}

function degradedWarning(
  listFailures: number,
  itemRequestFailures: number,
  invalidItems: number,
): string | undefined {
  const warnings: string[] = [];
  if (listFailures === 1) {
    warnings.push("one list request failed");
  }
  if (itemRequestFailures > 0) {
    warnings.push(
      `${itemRequestFailures} item request${itemRequestFailures === 1 ? "" : "s"} failed`,
    );
  }
  if (invalidItems > 0) {
    warnings.push(
      `${invalidItems} invalid item payload${invalidItems === 1 ? "" : "s"}`,
    );
  }
  return warnings.length === 0
    ? undefined
    : `Hacker News collection degraded: ${warnings.join("; ")}`;
}

function storyEvidence(story: HackerNewsStory): JsonValue {
  let url: string | null = null;
  if (story.url !== undefined) {
    try {
      url = sanitizeCandidateUrl(story.url);
    } catch {
      // Invalid or non-web URLs are not retained as evidence.
    }
  }

  return sanitizeEvidenceValue({
    id: story.id,
    type: story.type,
    by: story.by ?? null,
    time: story.time,
    title: story.title,
    url,
    text:
      story.text === undefined
        ? null
        : sanitizeCandidateString(story.text).slice(0, 512),
    score: story.score ?? null,
    descendants: story.descendants ?? null,
    dead: story.dead ?? null,
    deleted: story.deleted ?? null,
  });
}

export function createHackerNewsCollector(
  options: HackerNewsCollectorOptions,
): Collector {
  const topEndpoint = requireWebUrl(options.endpoints.top);
  const newEndpoint = requireWebUrl(options.endpoints.new);
  const itemUrl = createItemUrlBuilder(options, topEndpoint);
  const listLimit = requirePositiveInteger(
    options.listLimit ?? DEFAULT_LIST_LIMIT,
    "listLimit",
    MAX_LIST_LIMIT,
  );
  const concurrency = requirePositiveInteger(
    options.concurrency ?? DEFAULT_CONCURRENCY,
    "concurrency",
    MAX_CONCURRENCY,
  );
  const windowHours = requirePositiveNumber(
    options.windowHours ?? DEFAULT_WINDOW_HOURS,
    "windowHours",
  );

  async function collectList(
    context: CollectorContext,
    endpoint: string,
  ): Promise<ListOutcome> {
    try {
      const payload = await context.http.getJson(endpoint, {
        signal: context.signal,
      });
      const parsed = storyIdListSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, ids: [], status: "invalid" };
      }
      return { ok: true, ids: parsed.data.slice(0, listLimit) };
    } catch (error) {
      return {
        ok: false,
        ids: [],
        status: classifyCollectorError(error, context.signal),
      };
    }
  }

  return {
    sourceId: "hacker-news",
    async collect(context: CollectorContext): Promise<CollectorResult> {
      const collectedAtDate = context.now();
      const collectedAt = collectedAtDate.toISOString();
      const [top, fresh] = await Promise.all([
        collectList(context, topEndpoint),
        collectList(context, newEndpoint),
      ]);
      const listFailures = [top, fresh].filter(
        (outcome): outcome is ListFailure => !outcome.ok,
      );
      const topIds = top.ids;
      const newIds = fresh.ids;

      if (listFailures.length === 2) {
        return {
          sourceId: "hacker-news",
          status: mergeFailureStatuses(
            listFailures.map((failure) => failure.status),
          ),
          fetchedAt: collectedAt,
          items: [],
          warning: "Hacker News list requests failed",
          rawEvidence: sanitizeRawEvidence({
            listIds: { top: [], new: [] },
            items: [],
            failureCounts: {
              lists: 2,
              itemRequests: 0,
              invalidItems: 0,
              filteredItems: 0,
              itemFailuresByStatus: emptyItemFailureCounts(),
            },
          }),
        };
      }

      const ranks = new Map<number, HackerNewsListRanks>();
      for (const [index, id] of topIds.entries()) {
        if (!ranks.has(id)) {
          ranks.set(id, { topRank: index + 1, newRank: null });
        }
      }
      for (const [index, id] of newIds.entries()) {
        const existing = ranks.get(id);
        ranks.set(id, {
          topRank: existing?.topRank ?? null,
          newRank: existing?.newRank ?? index + 1,
        });
      }
      const ids = [...ranks.keys()];
      const outcomes = await mapConcurrent(
        ids,
        concurrency,
        async (id): Promise<ItemOutcome> => {
          try {
            const payload = await context.http.getJson(itemUrl(id), {
              signal: context.signal,
            });
            const parsed = HackerNewsStorySchema.safeParse(payload);
            return parsed.success && parsed.data.id === id
              ? ({ ok: true, story: parsed.data } satisfies ItemSuccess)
              : ({
                  ok: false,
                  invalid: true,
                  status: "invalid",
                } satisfies ItemFailure);
          } catch (error) {
            return {
              ok: false,
              invalid: false,
              status: itemFailureStatus(
                classifyCollectorError(error, context.signal),
              ),
            } satisfies ItemFailure;
          }
        },
      );

      const rawItems: HackerNewsStory[] = [];
      const normalizedItems: NormalizedItem[] = [];
      let itemRequestFailures = 0;
      let invalidItems = 0;
      let filteredItems = 0;
      let evaluatedItems = 0;
      const itemFailuresByStatus = emptyItemFailureCounts();
      const nowMs = collectedAtDate.getTime();
      const cutoffMs = nowMs - windowHours * 3_600_000;

      for (const [index, outcome] of outcomes.entries()) {
        if (!outcome.ok) {
          itemFailuresByStatus[outcome.status] += 1;
          if (outcome.invalid) {
            invalidItems += 1;
          } else {
            itemRequestFailures += 1;
          }
          continue;
        }
        const story = outcome.story;
        evaluatedItems += 1;
        rawItems.push(story);
        const publishedMs = story.time * 1_000;
        if (
          story.type !== "story" ||
          story.dead === true ||
          story.deleted === true ||
          publishedMs < cutoffMs ||
          publishedMs > nowMs
        ) {
          filteredItems += 1;
          continue;
        }
        const id = ids[index];
        const itemRanks = id === undefined ? undefined : ranks.get(id);
        if (itemRanks === undefined) {
          itemRequestFailures += 1;
          continue;
        }
        normalizedItems.push(
          normalizeHackerNewsStory(story, itemRanks, collectedAt),
        );
      }

      const warning = degradedWarning(
        listFailures.length,
        itemRequestFailures,
        invalidItems,
      );
      const itemStatuses = outcomes
        .filter((outcome): outcome is ItemFailure => !outcome.ok)
        .map((outcome) => outcome.status);
      const status =
        ids.length > 0 && evaluatedItems === 0
          ? mergeFailureStatuses(itemStatuses)
          : "ok";
      return {
        sourceId: "hacker-news",
        status,
        fetchedAt: collectedAt,
        ...(status === "ok" ? { lastSuccessfulAt: collectedAt } : {}),
        items: normalizedItems,
        ...(warning === undefined ? {} : { warning }),
        rawEvidence: sanitizeRawEvidence({
          listIds: { top: [...topIds], new: [...newIds] },
          items: rawItems.slice(0, MAX_EVIDENCE_ITEMS).map(storyEvidence),
          failureCounts: {
            lists: listFailures.length,
            itemRequests: itemRequestFailures,
            invalidItems,
            filteredItems,
            itemFailuresByStatus,
          },
        }),
      };
    },
  };
}
