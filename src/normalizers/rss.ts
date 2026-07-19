import { z } from "zod";

import {
  Category,
  CategorySchema,
  NormalizedItemSchema,
  type ItemCategory,
  type NormalizedItem,
} from "../types/item.js";
import {
  sanitizeCandidateString,
  sanitizeCandidateUrl,
} from "./sanitize.js";

const MAX_INPUT_TEXT_LENGTH = 256 * 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_AUTHOR_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_ENTRY_ID_LENGTH = 256;
const MAX_URL_LENGTH = 2_048;

const RssEntrySchema = z
  .object({
    title: z.string().max(MAX_INPUT_TEXT_LENGTH),
    link: z.string().max(MAX_URL_LENGTH),
    creator: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    author: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    isoDate: z.string().max(128).optional(),
    pubDate: z.string().max(128).optional(),
    summary: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    content: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    contentSnippet: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    guid: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
    id: z.string().max(MAX_INPUT_TEXT_LENGTH).optional(),
  })
  .passthrough();

const RssFeedDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    url: z.string().trim().min(1).max(MAX_URL_LENGTH),
    category: CategorySchema.optional(),
  })
  .strict();

export interface RssFeedDescriptor {
  readonly id: string;
  readonly url: string;
  readonly category?: ItemCategory;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 16);
      try {
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : " ";
      } catch {
        return " ";
      }
    })
    .replace(/&#([0-9]+);/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      try {
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : " ";
      } catch {
        return " ";
      }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'");
}

export function cleanSyndicationText(
  value: string,
  maximumLength: number,
): string | null {
  const decoded = decodeHtmlEntities(value);
  const plainText = decoded
    .replace(/<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|section|article|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();

  if (plainText === "") {
    return null;
  }
  const sanitized = sanitizeCandidateString(plainText);
  if (sanitized.length <= maximumLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, maximumLength - 1).trimEnd()}…`;
}

function requiredText(value: string, maximumLength: number): string {
  const result = cleanSyndicationText(value, maximumLength);
  if (result === null) {
    throw new TypeError("Syndication item text must not be empty");
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

function resolvedItemUrl(link: string, feedUrl: string): string {
  let resolved: string;
  try {
    resolved = new URL(link, feedUrl).toString();
  } catch {
    throw new TypeError("Syndication item link is invalid");
  }
  if (resolved.length > MAX_URL_LENGTH) {
    throw new TypeError("Syndication item link is too long");
  }
  return sanitizeCandidateUrl(resolved);
}

function entryId(entry: z.infer<typeof RssEntrySchema>): string | null {
  return optionalText(entry.guid ?? entry.id, MAX_ENTRY_ID_LENGTH);
}

export function normalizeRssEntry(
  input: unknown,
  descriptorInput: RssFeedDescriptor,
  collectedAt: string,
): NormalizedItem {
  const entry = RssEntrySchema.parse(input);
  const descriptor = RssFeedDescriptorSchema.parse(descriptorInput);
  const id = entryId(entry);
  const rawMetrics: Record<string, string | number | boolean | null> = {
    feedId: sanitizeCandidateString(descriptor.id),
  };
  if (id !== null) {
    rawMetrics.entryId = id;
  }

  return NormalizedItemSchema.parse({
    source: sanitizeCandidateString(descriptor.id),
    category: descriptor.category ?? Category.NEWS,
    title: requiredText(entry.title, MAX_TITLE_LENGTH),
    url: resolvedItemUrl(entry.link, descriptor.url),
    author: optionalText(
      entry.creator ?? entry.author,
      MAX_AUTHOR_LENGTH,
    ),
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
