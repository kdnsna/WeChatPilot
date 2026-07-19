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

export const HackerNewsStorySchema = z.object({
  id: z.number().int().positive(),
  type: z.string().max(32),
  by: z.string().trim().min(1).max(128).optional(),
  time: z.number().int().nonnegative().max(253_402_300_799),
  title: z.string().trim().min(1).max(512),
  url: z.string().trim().min(1).max(2_048).optional(),
  text: z.string().max(10_000).optional(),
  score: z.number().int().nonnegative().optional(),
  descendants: z.number().int().nonnegative().optional(),
  dead: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export type HackerNewsStory = z.infer<typeof HackerNewsStorySchema>;

export interface HackerNewsListRanks {
  readonly topRank: number | null;
  readonly newRank: number | null;
}

const SUMMARY_LIMIT = 280;

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function shortPlainText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const plainText = decodeCommonHtmlEntities(value)
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plainText === "") {
    return null;
  }
  const sanitized = sanitizeCandidateString(plainText);
  if (sanitized.length <= SUMMARY_LIMIT) {
    return sanitized;
  }
  return `${sanitized.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
}

function discussionUrl(storyId: number): string {
  return `https://news.ycombinator.com/item?id=${storyId}`;
}

function storyUrl(story: HackerNewsStory): string {
  if (story.url !== undefined) {
    try {
      return sanitizeCandidateUrl(story.url);
    } catch {
      // Invalid or non-web story URLs use the public discussion permalink.
    }
  }
  return discussionUrl(story.id);
}

export function normalizeHackerNewsStory(
  story: HackerNewsStory,
  ranks: HackerNewsListRanks,
  collectedAt: string,
): NormalizedItem {
  return NormalizedItemSchema.parse({
    source: "hacker-news",
    category: Category.COMMUNITY,
    title: sanitizeCandidateString(story.title.trim()),
    url: storyUrl(story),
    author:
      story.by === undefined ? null : sanitizeCandidateString(story.by),
    publishedAt: new Date(story.time * 1_000).toISOString(),
    comments: story.descendants ?? null,
    score: story.score ?? null,
    stars: null,
    summary: shortPlainText(story.text),
    rawMetrics: {
      hnId: story.id,
      discussionUrl: discussionUrl(story.id),
      topRank: ranks.topRank,
      newRank: ranks.newRank,
      activityUnix: story.time,
      score: story.score ?? null,
      descendants: story.descendants ?? null,
    },
    collectedAt,
  });
}
