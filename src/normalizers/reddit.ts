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
import { cleanSyndicationText } from "./rss.js";

const MAX_INPUT_TEXT_LENGTH = 256 * 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_AUTHOR_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_REDDIT_ID_LENGTH = 256;
const MAX_URL_LENGTH = 2_048;

const RedditEntrySchema = z
  .object({
    title: z.string().max(MAX_INPUT_TEXT_LENGTH),
    link: z.string().max(MAX_URL_LENGTH),
    author: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    creator: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    isoDate: z.string().max(128).optional(),
    pubDate: z.string().max(128).optional(),
    summary: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    content: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    contentSnippet: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    id: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    guid: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
  })
  .passthrough();

const RedditDescriptorSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(MAX_URL_LENGTH),
  })
  .strict();

export interface RedditFeedDescriptor {
  readonly endpoint: string;
}

function requiredText(value: string, maximumLength: number): string {
  const result = cleanSyndicationText(value, maximumLength);
  if (result === null) {
    throw new TypeError("Reddit entry text must not be empty");
  }
  return result;
}

function optionalText(
  value: string | undefined,
  maximumLength: number,
): string | null {
  return value === undefined
    ? null
    : cleanSyndicationText(value, maximumLength);
}

function normalizedDate(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function resolvedLink(link: string, endpoint: string): string {
  let resolved: string;
  try {
    resolved = new URL(link, endpoint).toString();
  } catch {
    throw new TypeError("Reddit entry link is invalid");
  }
  if (resolved.length > MAX_URL_LENGTH) {
    throw new TypeError("Reddit entry link is too long");
  }
  return sanitizeCandidateUrl(resolved);
}

function subredditFromUrl(value: string): string {
  const match = new URL(value).pathname.match(/^\/r\/([^/]+)(?:\/|$)/i);
  if (match?.[1] === undefined) {
    throw new TypeError("Reddit entry link has no subreddit");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    throw new TypeError("Reddit subreddit is invalid");
  }
  const sanitized = sanitizeCandidateString(decoded.normalize("NFKC").trim());
  if (sanitized === "" || sanitized.length > 64) {
    throw new TypeError("Reddit subreddit is invalid");
  }
  return sanitized;
}

export function normalizeRedditEntry(
  input: unknown,
  descriptorInput: RedditFeedDescriptor,
  collectedAt: string,
): NormalizedItem {
  const entry = RedditEntrySchema.parse(input);
  const descriptor = RedditDescriptorSchema.parse(descriptorInput);
  const url = resolvedLink(entry.link, descriptor.endpoint);
  const rawMetrics: Record<string, string | number | boolean | null> = {
    subreddit: subredditFromUrl(url),
  };
  const id = optionalText(
    entry.id ?? entry.guid,
    MAX_REDDIT_ID_LENGTH,
  );
  if (id !== null) {
    rawMetrics.redditId = id;
  }

  return NormalizedItemSchema.parse({
    source: "reddit",
    category: Category.COMMUNITY,
    title: requiredText(entry.title, MAX_TITLE_LENGTH),
    url,
    author: optionalText(entry.author ?? entry.creator, MAX_AUTHOR_LENGTH),
    publishedAt: normalizedDate(entry.isoDate ?? entry.pubDate),
    comments: null,
    score: null,
    stars: null,
    summary: optionalText(
      entry.summary ?? entry.content ?? entry.contentSnippet,
      MAX_SUMMARY_LENGTH,
    ),
    rawMetrics,
    collectedAt,
  });
}
