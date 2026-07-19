import { join } from "node:path";

import { z } from "zod";

import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import { createProjectPaths } from "../lib/paths.js";
import { sanitizeCandidateString } from "../normalizers/sanitize.js";
import type { NormalizedItem } from "../types/item.js";

const MAX_FILE_BYTES = 5 * 1_024 * 1_024;
const MAX_REPOSITORIES = 10_000;
const MAX_SNAPSHOTS = 32;
const MIN_BASELINE_HOURS = 6;
const MAX_BASELINE_HOURS = 72;
const TARGET_BASELINE_HOURS = 24;

const starsSchema = z
  .record(
    z.string().min(1).max(512),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  )
  .refine(
    (stars) => Object.keys(stars).length <= MAX_REPOSITORIES,
    `snapshot must contain at most ${MAX_REPOSITORIES} repositories`,
  );

const SnapshotSchema = z
  .object({
    capturedAt: z.iso.datetime({ offset: true }),
    stars: starsSchema,
  })
  .strict();

interface Snapshot extends z.infer<typeof SnapshotSchema> {}

interface SnapshotDocument {
  readonly snapshots: readonly Snapshot[];
  readonly invalidEntries: number;
}

export type PriorGitHubSnapshot =
  | {
      readonly snapshot: null;
      readonly invalidEntries: number;
    }
  | {
      readonly capturedAt: string;
      readonly windowHours: number;
      readonly stars: Readonly<Record<string, number>>;
      readonly invalidEntries: number;
    };

function filePath(projectRoot: string): string {
  return join(createProjectPaths(projectRoot).history, "github-stars.json");
}

function readDocument(projectRoot: string): SnapshotDocument {
  const text = readProjectText(projectRoot, filePath(projectRoot), MAX_FILE_BYTES);
  if (text === null) {
    return { snapshots: [], invalidEntries: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { snapshots: [], invalidEntries: 1 };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { snapshots?: unknown }).snapshots)
  ) {
    return { snapshots: [], invalidEntries: 1 };
  }

  const candidates = (parsed as { snapshots: unknown[] }).snapshots;
  let invalidEntries = Math.max(0, candidates.length - MAX_SNAPSHOTS);
  const snapshots: Snapshot[] = [];
  for (const candidate of candidates.slice(-MAX_SNAPSHOTS)) {
    const result = SnapshotSchema.safeParse(candidate);
    if (!result.success) {
      invalidEntries += 1;
      continue;
    }
    snapshots.push(result.data);
  }
  return { snapshots, invalidEntries };
}

export function loadPriorGitHubSnapshot(
  projectRoot: string,
  now: Date,
): PriorGitHubSnapshot {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("now must be a valid date");
  }
  const document = readDocument(projectRoot);
  const eligible = document.snapshots
    .map((snapshot) => ({
      snapshot,
      windowHours:
        (now.getTime() - Date.parse(snapshot.capturedAt)) / 3_600_000,
    }))
    .filter(
      ({ windowHours }) =>
        windowHours >= MIN_BASELINE_HOURS &&
        windowHours <= MAX_BASELINE_HOURS,
    )
    .sort(
      (left, right) =>
        Math.abs(left.windowHours - TARGET_BASELINE_HOURS) -
          Math.abs(right.windowHours - TARGET_BASELINE_HOURS) ||
        right.windowHours - left.windowHours,
    );
  const selected = eligible[0];
  if (selected === undefined) {
    return { snapshot: null, invalidEntries: document.invalidEntries };
  }
  return {
    capturedAt: selected.snapshot.capturedAt,
    windowHours: Math.round(selected.windowHours * 100) / 100,
    stars: selected.snapshot.stars,
    invalidEntries: document.invalidEntries,
  };
}

export function recordGitHubSnapshot(
  projectRoot: string,
  items: readonly NormalizedItem[],
  capturedAt: Date,
): void {
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new RangeError("capturedAt must be a valid date");
  }
  const document = readDocument(projectRoot);
  const stars: Record<string, number> = {};
  for (const item of items) {
    if (item.source !== "github" || item.stars === null) {
      continue;
    }
    const repository = sanitizeCandidateString(item.title);
    if (repository.length > 0 && repository.length <= 512) {
      stars[repository] = item.stars;
    }
  }
  const snapshot = SnapshotSchema.parse({
    capturedAt: capturedAt.toISOString(),
    stars,
  });
  const retentionCutoff = capturedAt.getTime() - 8 * 86_400_000;
  const retained = [...document.snapshots, snapshot]
    .filter(
      (entry) =>
        Date.parse(entry.capturedAt) >= retentionCutoff &&
        Date.parse(entry.capturedAt) <= capturedAt.getTime(),
    )
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    .slice(-MAX_SNAPSHOTS);
  writeProjectTextAtomic(
    projectRoot,
    filePath(projectRoot),
    `${JSON.stringify({ version: 1, snapshots: retained }, null, 2)}\n`,
  );
}
