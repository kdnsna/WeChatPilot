import { HttpError } from "../lib/http.js";
import {
  GitHubRepositorySchema,
  GitHubSearchResponseSchema,
  normalizeGitHubRepository,
} from "../normalizers/github.js";
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

const DEFAULT_ENDPOINT = "https://api.github.com/search/repositories";
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MINIMUM_STARS = 50;
const DEFAULT_ITEM_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LOOKBACK_DAYS = 365;
const MAX_ITEM_LIMIT = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 1_024;
const MAX_SNAPSHOT_ENTRIES = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export interface GitHubCollectorOptions {
  readonly endpoint?: string;
  readonly token?: string;
  readonly lookbackDays?: number;
  readonly minStars?: number;
  readonly itemLimit?: number;
  readonly timeoutMs?: number;
  readonly previousStars?: Readonly<Record<string, number>>;
  readonly previousSnapshotAt?: string;
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value;
}

function safeNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe nonnegative integer`);
  }
  return value;
}

function publicEndpoint(value: string): string {
  if (value.length > MAX_ENDPOINT_LENGTH) {
    throw new TypeError("GitHub endpoint is too long");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("GitHub endpoint must be a valid public URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("GitHub endpoint must be a public HTTP or HTTPS URL");
  }
  return parsed.toString();
}

function optionalToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new TypeError("GitHub token is invalid");
  }
  return value;
}

function snapshot(
  input: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  if (input === undefined) {
    return {};
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_SNAPSHOT_ENTRIES) {
    throw new RangeError("previousStars contains too many entries");
  }
  const result: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const [name, stars] of entries) {
    if (name.length === 0 || name.length > 512) {
      throw new TypeError("previousStars contains an invalid repository name");
    }
    result[name] = safeNonnegativeInteger(stars, "previousStars value");
  }
  return result;
}

function snapshotTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("previousSnapshotAt must be an ISO date-time");
  }
  return new Date(value).toISOString();
}

function requestHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "daily-tech-digest/0.1",
  };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function cutoffFor(now: Date, lookbackDays: number): Date {
  return new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1_000);
}

function searchUrl(
  endpoint: string,
  cutoff: Date,
  minimumStars: number,
  itemLimit: number,
): string {
  const url = new URL(endpoint);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  url.searchParams.set(
    "q",
    `created:>=${cutoffDate} stars:>=${minimumStars} fork:false archived:false`,
  );
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(itemLimit));
  return url.toString();
}

function statusFor(error: unknown, signal?: AbortSignal): SourceStatus {
  if (error instanceof HttpError && error.kind === "aborted") {
    throw error;
  }
  if (
    error instanceof HttpError &&
    error.status === 403 &&
    error.rateLimit?.remaining === 0
  ) {
    return "rate_limited";
  }
  return classifyCollectorError(error, signal);
}

function failureResult(
  status: SourceStatus,
  collectedAt: string,
  lookbackDays: number,
  minimumStars: number,
): CollectorResult {
  return {
    sourceId: "github",
    status,
    fetchedAt: collectedAt,
    warning: sanitizeCandidateString(`GitHub request failed: ${status}`),
    items: [],
    rawEvidence: sanitizeRawEvidence({
      endpointRequests: 1,
      receivedRepositories: 0,
      validRepositories: 0,
      invalidRepositories: 0,
      truncatedRepositories: 0,
      lookbackDays,
      minimumStars,
    }),
  };
}

function warningFor(invalid: number, truncated: number, valid: number): string | undefined {
  const warnings: string[] = [];
  if (invalid > 0) {
    warnings.push(
      `GitHub skipped ${invalid} invalid repositor${invalid === 1 ? "y" : "ies"}`,
    );
  }
  if (truncated > 0) {
    warnings.push(`GitHub omitted ${truncated} repositories by limits`);
  }
  if (valid === 0) {
    warnings.push("GitHub returned no valid repositories");
  }
  return warnings.length === 0 ? undefined : warnings.join("; ");
}

export function createGitHubCollector(
  options: GitHubCollectorOptions = {},
): Collector {
  const endpoint = publicEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
  const token = optionalToken(options.token);
  const lookbackDays = boundedPositiveInteger(
    options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    "lookbackDays",
    MAX_LOOKBACK_DAYS,
  );
  const minimumStars = safeNonnegativeInteger(
    options.minStars ?? DEFAULT_MINIMUM_STARS,
    "minStars",
  );
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
  const previousStars = snapshot(options.previousStars);
  const previousSnapshotAt = snapshotTimestamp(options.previousSnapshotAt);
  if (
    (options.previousStars === undefined) !==
    (previousSnapshotAt === undefined)
  ) {
    throw new TypeError(
      "previousStars and previousSnapshotAt must be supplied together",
    );
  }

  return {
    sourceId: "github",
    async collect(context: CollectorContext): Promise<CollectorResult> {
      rethrowIfAborted(context.signal);
      const now = context.now();
      const collectedAt = now.toISOString();
      const cutoff = cutoffFor(now, lookbackDays);
      const snapshotWindowHours =
        previousSnapshotAt === undefined
          ? null
          : (now.getTime() - Date.parse(previousSnapshotAt)) / 3_600_000;
      const snapshotIsRecent =
        snapshotWindowHours !== null &&
        snapshotWindowHours > 0 &&
        snapshotWindowHours <= 72;
      let payload: unknown;
      try {
        payload = await context.http.getJson(
          searchUrl(endpoint, cutoff, minimumStars, itemLimit),
          {
            headers: requestHeaders(token),
            signal: context.signal,
            timeoutMs,
            maxResponseBytes: MAX_RESPONSE_BYTES,
          },
        );
      } catch (error) {
        return failureResult(
          statusFor(error, context.signal),
          collectedAt,
          lookbackDays,
          minimumStars,
        );
      }
      rethrowIfAborted(context.signal);

      const parsedResponse = GitHubSearchResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        return failureResult(
          "invalid",
          collectedAt,
          lookbackDays,
          minimumStars,
        );
      }

      const candidates = parsedResponse.data.items.slice(0, itemLimit);
      const items: NormalizedItem[] = [];
      let invalidRepositories = 0;
      for (const candidate of candidates) {
        try {
          const repository = GitHubRepositorySchema.parse(candidate);
          if (
            Date.parse(repository.created_at) < cutoff.getTime() ||
            repository.stargazers_count < minimumStars
          ) {
            invalidRepositories += 1;
            continue;
          }
          items.push(
            normalizeGitHubRepository(
              repository,
              collectedAt,
              snapshotIsRecent
                ? previousStars[repository.full_name]
                : undefined,
              snapshotIsRecent &&
                previousStars[repository.full_name] !== undefined
                ? previousSnapshotAt
                : undefined,
            ),
          );
        } catch {
          invalidRepositories += 1;
        }
      }
      const truncatedRepositories = Math.max(
        0,
        parsedResponse.data.items.length - candidates.length,
      );
      const warning = warningFor(
        invalidRepositories,
        truncatedRepositories,
        items.length,
      );

      return {
        sourceId: "github",
        status: "ok",
        fetchedAt: collectedAt,
        lastSuccessfulAt: collectedAt,
        ...(warning === undefined ? {} : { warning }),
        items,
        rawEvidence: sanitizeRawEvidence({
          endpointRequests: 1,
          receivedRepositories: parsedResponse.data.items.length,
          validRepositories: items.length,
          invalidRepositories,
          truncatedRepositories,
          totalCount: parsedResponse.data.total_count,
          incompleteResults: parsedResponse.data.incomplete_results,
          lookbackDays,
          minimumStars,
        }),
      };
    },
  };
}
