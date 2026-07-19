import { join } from "node:path";

import { z } from "zod";

import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import { createProjectPaths } from "../lib/paths.js";
import {
  sanitizeCandidateString,
  sanitizeCandidateUrl,
} from "../normalizers/sanitize.js";
import type { SentHistoryItem } from "../ranking/score.js";
import type { NormalizedItem } from "../types/item.js";

const HISTORY_FILE_NAME = "sent-items.json";
const MAX_HISTORY_BYTES = 5 * 1_024 * 1_024;
const MAX_HISTORY_ENTRIES = 10_000;
const RETENTION_DAYS = 30;

const SentHistoryItemSchema = z
  .object({
    title: z.string().min(1).max(512),
    url: z
      .string()
      .max(4_096)
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    source: z.string().min(1).max(128),
    sentAt: z.iso.datetime({ offset: true }),
  })
  .strict();

interface HistoryDocument {
  readonly items: readonly SentHistoryItem[];
  readonly invalidEntries: number;
}

export interface LoadedSentHistory extends HistoryDocument {}

export interface SentHistoryReference {
  readonly title: string;
  readonly url: string;
  readonly source: string;
}

function historyPath(projectRoot: string): string {
  return join(createProjectPaths(projectRoot).history, HISTORY_FILE_NAME);
}

function normalizedEntry(entry: SentHistoryItem): SentHistoryItem {
  return SentHistoryItemSchema.parse({
    title: sanitizeCandidateString(entry.title),
    url: sanitizeCandidateUrl(entry.url),
    source: sanitizeCandidateString(entry.source),
    sentAt: entry.sentAt,
  });
}

function readDocument(projectRoot: string): HistoryDocument {
  const text = readProjectText(
    projectRoot,
    historyPath(projectRoot),
    MAX_HISTORY_BYTES,
  );
  if (text === null) {
    return { items: [], invalidEntries: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { items: [], invalidEntries: 1 };
  }
  if (!Array.isArray(parsed)) {
    return { items: [], invalidEntries: 1 };
  }

  const items: SentHistoryItem[] = [];
  let invalidEntries = Math.max(0, parsed.length - MAX_HISTORY_ENTRIES);
  for (const candidate of parsed.slice(-MAX_HISTORY_ENTRIES)) {
    const result = SentHistoryItemSchema.safeParse(candidate);
    if (!result.success) {
      invalidEntries += 1;
      continue;
    }
    items.push(normalizedEntry(result.data));
  }
  return { items, invalidEntries };
}

export function loadSentHistory(
  projectRoot: string,
  now: Date,
  lookbackDays: number,
): LoadedSentHistory {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays <= 0) {
    throw new RangeError("lookbackDays must be a positive safe integer");
  }
  const document = readDocument(projectRoot);
  const cutoff = now.getTime() - lookbackDays * 86_400_000;
  return {
    items: document.items.filter((entry) => {
      const sentAt = Date.parse(entry.sentAt);
      return sentAt >= cutoff && sentAt <= now.getTime();
    }),
    invalidEntries: document.invalidEntries,
  };
}

export function recordSentItems(
  projectRoot: string,
  items: readonly NormalizedItem[],
  sentAt: Date,
): void {
  recordSentReferences(
    projectRoot,
    items.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
    })),
    sentAt,
  );
}

export function recordSentReferences(
  projectRoot: string,
  items: readonly SentHistoryReference[],
  sentAt: Date,
): void {
  if (!Number.isFinite(sentAt.getTime())) {
    throw new RangeError("sentAt must be a valid date");
  }
  const document = readDocument(projectRoot);
  const newEntries = items.map((item) =>
    normalizedEntry({
      title: item.title,
      url: item.url,
      source: item.source,
      sentAt: sentAt.toISOString(),
    }),
  );
  const combined = [...document.items, ...newEntries].sort(
    (left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt),
  );
  const newestTimestamp = combined.reduce(
    (latest, entry) => Math.max(latest, Date.parse(entry.sentAt)),
    sentAt.getTime(),
  );
  const retentionCutoff = newestTimestamp - RETENTION_DAYS * 86_400_000;
  const retained = combined
    .filter((entry) => Date.parse(entry.sentAt) >= retentionCutoff)
    .slice(-MAX_HISTORY_ENTRIES);
  writeProjectTextAtomic(
    projectRoot,
    historyPath(projectRoot),
    `${JSON.stringify(retained, null, 2)}\n`,
  );
}
