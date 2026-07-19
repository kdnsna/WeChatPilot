import { z } from "zod";

import {
  Category,
  NormalizedItemSchema,
  type NormalizedItem,
} from "../types/item.js";
import {
  sanitizeCandidateString,
  sanitizeCandidateUrl,
} from "./sanitize.js";

const MAX_REPOSITORIES = 100;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_WINDOW_HOURS = 72;

const safeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const githubDateSchema = z.iso.datetime({ offset: true });

export const GitHubRepositorySchema = z
  .object({
    id: safeCountSchema.positive(),
    full_name: z.string().trim().min(1).max(512),
    html_url: z.string().min(1).max(4_096),
    description: z.string().max(4_096).nullable(),
    stargazers_count: safeCountSchema,
    forks_count: safeCountSchema,
    open_issues_count: safeCountSchema,
    language: z.string().max(128).nullable(),
    created_at: githubDateSchema,
    updated_at: githubDateSchema,
    fork: z.literal(false),
    archived: z.literal(false),
    owner: z
      .object({
        login: z.string().trim().min(1).max(256),
      })
      .passthrough(),
  })
  .passthrough();

export const GitHubSearchResponseSchema = z
  .object({
    total_count: safeCountSchema,
    incomplete_results: z.boolean(),
    items: z.array(z.unknown()).max(MAX_REPOSITORIES),
  })
  .passthrough();

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sanitizedNullable(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const sanitized = sanitizeCandidateString(value.trim());
  return sanitized === "" ? null : sanitized;
}

export function normalizeGitHubRepository(
  input: unknown,
  collectedAt: string,
  previousStars?: number,
  previousSnapshotAt?: string,
): NormalizedItem {
  const repository = GitHubRepositorySchema.parse(input);
  const collectedMilliseconds = Date.parse(collectedAt);
  const createdMilliseconds = Date.parse(repository.created_at);
  const ageDays = Math.max(
    1,
    Math.floor(
      Math.max(0, collectedMilliseconds - createdMilliseconds) /
        MILLISECONDS_PER_DAY,
    ),
  );

  if (
    previousStars !== undefined &&
    (!Number.isSafeInteger(previousStars) || previousStars < 0)
  ) {
    throw new RangeError("previousStars must be a safe nonnegative integer");
  }
  if ((previousStars === undefined) !== (previousSnapshotAt === undefined)) {
    throw new TypeError("previousStars and previousSnapshotAt must be supplied together");
  }
  let starDelta: number | null = null;
  let starDeltaWindowHours: number | null = null;
  let starGrowthPerDay: number | null = null;
  if (previousStars !== undefined && previousSnapshotAt !== undefined) {
    const snapshotMilliseconds = Date.parse(previousSnapshotAt);
    const windowHours =
      (collectedMilliseconds - snapshotMilliseconds) / (60 * 60 * 1_000);
    if (
      !Number.isFinite(snapshotMilliseconds) ||
      !Number.isFinite(windowHours) ||
      windowHours <= 0 ||
      windowHours > MAX_SNAPSHOT_WINDOW_HOURS
    ) {
      throw new RangeError(
        `GitHub snapshot window must be within ${MAX_SNAPSHOT_WINDOW_HOURS} hours`,
      );
    }
    starDelta = repository.stargazers_count - previousStars;
    starDeltaWindowHours = rounded(windowHours);
    starGrowthPerDay = rounded((starDelta * 24) / windowHours);
  }

  return NormalizedItemSchema.parse({
    source: "github",
    category: Category.GITHUB,
    title: sanitizeCandidateString(repository.full_name),
    url: sanitizeCandidateUrl(repository.html_url),
    author: sanitizeCandidateString(repository.owner.login),
    publishedAt: repository.created_at,
    comments: null,
    score: null,
    stars: repository.stargazers_count,
    summary: sanitizedNullable(repository.description),
    rawMetrics: {
      stars: repository.stargazers_count,
      forks: repository.forks_count,
      openIssues: repository.open_issues_count,
      language: sanitizedNullable(repository.language),
      updatedAt: repository.updated_at,
      ageDays,
      starsPerDay: rounded(repository.stargazers_count / ageDays),
      starDelta,
      starDeltaWindowHours,
      starGrowthPerDay,
    },
    collectedAt,
  });
}
