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

const webUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  });

const memberSchema = z.object({
  username: z.string().trim().min(1).max(128),
});

const nodeSchema = z.object({
  name: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(128),
});

const unixTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(253_402_300_799);

export const V2exTopicSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1).max(512),
  url: webUrlSchema,
  replies: z.number().int().nonnegative().optional(),
  member: memberSchema.nullable().optional(),
  node: nodeSchema,
  created: unixTimestampSchema,
  last_modified: unixTimestampSchema.optional(),
  last_touched: unixTimestampSchema.optional(),
});

export const V2exHotTopicsSchema = z.array(z.unknown()).max(100);
export type V2exTopic = z.infer<typeof V2exTopicSchema>;

export function v2exActivityUnix(topic: V2exTopic): number {
  return topic.last_touched ?? topic.last_modified ?? topic.created;
}

export function normalizeV2exTopic(
  topic: V2exTopic,
  collectedAt: string,
): NormalizedItem {
  return NormalizedItemSchema.parse({
    source: "v2ex",
    category: Category.COMMUNITY,
    title: sanitizeCandidateString(topic.title.trim()),
    url: sanitizeCandidateUrl(topic.url),
    author:
      topic.member === undefined || topic.member === null
        ? null
        : sanitizeCandidateString(topic.member.username),
    publishedAt: new Date(topic.created * 1_000).toISOString(),
    comments: topic.replies ?? null,
    score: null,
    stars: null,
    summary: null,
    rawMetrics: {
      topicId: topic.id,
      nodeName: sanitizeCandidateString(topic.node.name),
      nodeTitle: sanitizeCandidateString(topic.node.title),
      replies: topic.replies ?? null,
      lastTouched: topic.last_touched ?? null,
      lastModified: topic.last_modified ?? null,
    },
    collectedAt,
  });
}
