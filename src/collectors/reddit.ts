import Parser from "rss-parser";

import { HttpError } from "../lib/http.js";
import { normalizeRedditEntry } from "../normalizers/reddit.js";
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
import type { NormalizedItem } from "../types/item.js";
import { classifyCollectorError, rethrowIfAborted } from "./errors.js";
import { RSS_MAX_RESPONSE_BYTES } from "./rss.js";

const DEFAULT_ITEM_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ITEM_LIMIT = 100;
const MAX_SUBREDDITS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_URL_LENGTH = 2_048;

interface RedditParserExtraFields {
  readonly author?: string;
  readonly id?: string;
}

export interface RedditCollectorOptions {
  readonly endpoint: string;
  readonly subreddits: readonly string[];
  readonly itemLimit?: number;
  readonly timeoutMs?: number;
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

function publicEndpoint(value: string): string {
  if (value.length > MAX_URL_LENGTH) {
    throw new TypeError("Reddit endpoint is too long");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("Reddit endpoint must be a public HTTP or HTTPS URL");
  }
  return parsed.toString();
}

function normalizedSubreddits(values: readonly string[]): readonly string[] {
  if (values.length === 0 || values.length > MAX_SUBREDDITS) {
    throw new RangeError(
      `subreddits must contain between 1 and ${MAX_SUBREDDITS} entries`,
    );
  }
  const normalized = values.map((value) => {
    const subreddit = sanitizeCandidateString(value.normalize("NFKC").trim());
    if (!/^[A-Za-z0-9_]{1,64}$/.test(subreddit)) {
      throw new TypeError("subreddits must contain valid public names");
    }
    return subreddit;
  });
  if (new Set(normalized.map((value) => value.toLocaleLowerCase("en-US"))).size !== normalized.length) {
    throw new TypeError("subreddits must be unique");
  }
  return normalized;
}

function failureResult(
  status: SourceStatus,
  collectedAt: string,
  subreddits: readonly string[],
  warning: string,
): CollectorResult {
  return {
    sourceId: "reddit",
    status,
    fetchedAt: collectedAt,
    warning: sanitizeCandidateString(warning),
    items: [],
    rawEvidence: sanitizeRawEvidence({
      endpointRequests: 1,
      configuredSubreddits: subreddits,
      receivedEntries: 0,
      validEntries: 0,
      invalidEntries: 0,
      truncatedEntries: 0,
    }),
  };
}

function successWarning(
  invalidEntries: number,
  truncatedEntries: number,
  validEntries: number,
): string | undefined {
  const warnings: string[] = [];
  if (invalidEntries > 0) {
    warnings.push(
      `Reddit skipped ${invalidEntries} invalid entr${invalidEntries === 1 ? "y" : "ies"}`,
    );
  }
  if (truncatedEntries > 0) {
    warnings.push(
      `Reddit omitted ${truncatedEntries} entr${truncatedEntries === 1 ? "y" : "ies"} by limits`,
    );
  }
  if (validEntries === 0) {
    warnings.push("Reddit returned no valid entries");
  }
  return warnings.length === 0 ? undefined : warnings.join("; ");
}

export function createRedditCollector(
  options: RedditCollectorOptions,
): Collector {
  const endpoint = publicEndpoint(options.endpoint);
  const subreddits = normalizedSubreddits(options.subreddits);
  const itemLimit = boundedPositiveInteger(
    options.itemLimit ?? DEFAULT_ITEM_LIMIT,
    "itemLimit",
    MAX_ITEM_LIMIT,
  );
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAX_TIMEOUT_MS,
  );
  const parser = new Parser<Record<string, never>, RedditParserExtraFields>();

  return {
    sourceId: "reddit",
    async collect(context: CollectorContext): Promise<CollectorResult> {
      const collectedAt = context.now().toISOString();
      let xml: string;
      try {
        xml = await context.http.getText(endpoint, {
          signal: context.signal,
          timeoutMs,
          maxResponseBytes: RSS_MAX_RESPONSE_BYTES,
        });
      } catch (error) {
        const status = classifyCollectorError(error, context.signal);
        return failureResult(
          status,
          collectedAt,
          subreddits,
          `Reddit request failed: ${status}`,
        );
      }
      rethrowIfAborted(context.signal);

      let parsed: Awaited<ReturnType<typeof parser.parseString>>;
      try {
        parsed = await parser.parseString(xml);
      } catch {
        const status = classifyCollectorError(
          new HttpError({ kind: "invalid_response", retryable: false }),
          context.signal,
        );
        return failureResult(
          status,
          collectedAt,
          subreddits,
          "Reddit returned malformed RSS",
        );
      }
      rethrowIfAborted(context.signal);

      const receivedEntries = parsed.items.length;
      const candidates = parsed.items.slice(0, itemLimit);
      const items: NormalizedItem[] = [];
      let invalidEntries = 0;
      for (const candidate of candidates) {
        try {
          items.push(
            normalizeRedditEntry(candidate, { endpoint }, collectedAt),
          );
        } catch {
          invalidEntries += 1;
        }
      }
      const truncatedEntries = Math.max(
        0,
        receivedEntries - candidates.length,
      );
      const warning = successWarning(
        invalidEntries,
        truncatedEntries,
        items.length,
      );

      return {
        sourceId: "reddit",
        status: "ok",
        fetchedAt: collectedAt,
        lastSuccessfulAt: collectedAt,
        ...(warning === undefined ? {} : { warning }),
        items,
        rawEvidence: sanitizeRawEvidence({
          endpointRequests: 1,
          configuredSubreddits: subreddits,
          receivedEntries,
          validEntries: items.length,
          invalidEntries,
          truncatedEntries,
        }),
      };
    },
  };
}
