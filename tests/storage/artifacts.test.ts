import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CollectionRunResult } from "../../src/collectors/run.js";
import type { RankedItem } from "../../src/ranking/score.js";
import { persistCollectionArtifacts } from "../../src/storage/artifacts.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T00:05:06.789Z");
const roots: string[] = [];

function item(): NormalizedItem {
  return {
    source: "fixture",
    category: Category.NEWS,
    title: "Token context_token=must-not-persist",
    url: "https://example.test/item?access_token=hidden&view=full",
    author: null,
    publishedAt: NOW.toISOString(),
    comments: null,
    score: null,
    stars: null,
    summary: null,
    rawMetrics: {},
    collectedAt: NOW.toISOString(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("collection artifacts", () => {
  it("persists redacted raw and ranked evidence under a dated project directory", () => {
    const root = mkdtempSync(join(tmpdir(), "daily-tech-artifact-"));
    roots.push(root);
    const candidate = item();
    const collection: CollectionRunResult = {
      results: [
        {
          sourceId: "fixture",
          status: "ok",
          fetchedAt: NOW.toISOString(),
          lastSuccessfulAt: NOW.toISOString(),
          items: [candidate],
          rawEvidence: {
            authorization: "Bearer raw-secret",
            candidateCount: 1,
          },
        },
      ],
      items: [candidate],
      degraded: false,
      coreSuccesses: 1,
      minimumCoreSuccesses: 1,
    };
    const ranked: RankedItem[] = [
      {
        item: candidate,
        heatScore: 50,
        baseHeatScore: 50,
        components: {
          engagement: 0.5,
          popularity: 0.5,
          velocity: 0.5,
          recency: 1,
          crossSource: 0,
          sourceQuality: 1,
        },
        historyFactor: 1,
        velocityMetric: "none",
        confirmedBy: ["fixture"],
        relatedUrls: [candidate.url],
        duplicateCount: 0,
        reason: "fixture",
      },
    ];

    const paths = persistCollectionArtifacts(root, NOW, collection, ranked);
    const raw = readFileSync(paths.rawPath, "utf8");
    const scores = readFileSync(paths.rankedPath, "utf8");

    expect(paths.runId).toBe("20260718T000506789Z");
    expect(paths.rawPath).toContain(join("data", "raw", "2026-07-18"));
    expect(raw).toContain("candidateCount");
    expect(`${raw}${scores}`).not.toMatch(/must-not-persist|raw-secret|access_token=hidden/);
    expect(`${raw}${scores}`).toContain("view=full");
    expect(statSync(paths.rawPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.rankedPath).mode & 0o777).toBe(0o600);
  });
});
