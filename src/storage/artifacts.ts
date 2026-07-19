import { join } from "node:path";

import type { CollectionRunResult } from "../collectors/run.js";
import { writeProjectTextAtomic } from "../lib/project-file.js";
import { createProjectPaths } from "../lib/paths.js";
import { shanghaiDateKey } from "../lib/time.js";
import type { RankedItem } from "../ranking/score.js";
import { redactSecrets } from "../security/redact.js";

const MAX_ARTIFACT_BYTES = 20 * 1_024 * 1_024;

export interface CollectionArtifactPaths {
  readonly runId: string;
  readonly rawPath: string;
  readonly rankedPath: string;
}

function runIdentifier(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Artifact timestamp must be a valid date");
  }
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function privateJson(value: unknown): string {
  const serialized = `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_BYTES) {
    throw new RangeError("Collection artifact exceeded the configured size limit");
  }
  return serialized;
}

export function persistCollectionArtifacts(
  projectRoot: string,
  now: Date,
  collection: CollectionRunResult,
  ranked: readonly RankedItem[],
): CollectionArtifactPaths {
  const paths = createProjectPaths(projectRoot);
  const dateKey = shanghaiDateKey(now);
  const runId = runIdentifier(now);
  const directory = join(paths.raw, dateKey);
  const rawPath = join(directory, `${runId}-raw.json`);
  const rankedPath = join(directory, `${runId}-ranked.json`);
  writeProjectTextAtomic(
    projectRoot,
    rawPath,
    privateJson({
      version: 1,
      runId,
      date: dateKey,
      collectedAt: now.toISOString(),
      degraded: collection.degraded,
      coreSuccesses: collection.coreSuccesses,
      minimumCoreSuccesses: collection.minimumCoreSuccesses,
      sources: collection.results,
    }),
  );
  writeProjectTextAtomic(
    projectRoot,
    rankedPath,
    privateJson({
      version: 1,
      runId,
      date: dateKey,
      ranked,
    }),
  );
  return { runId, rawPath, rankedPath };
}
