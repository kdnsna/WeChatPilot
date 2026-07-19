import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runDailyCollection } from "../../src/app/collect.js";
import type { HttpClient } from "../../src/lib/http.js";
import type { RegisteredCollector } from "../../src/collectors/run.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-07-18T06:00:00.000Z");
const roots: string[] = [];
const http: HttpClient = {
  getJson: async () => ({}),
  getText: async () => "",
};

function root(): string {
  const project = mkdtempSync(join(tmpdir(), "daily-tech-app-"));
  roots.push(project);
  mkdirSync(join(project, "config"), { recursive: true });
  for (const name of ["sources.yaml", "ranking.yaml", "digest.yaml"]) {
    copyFileSync(join(repositoryRoot, "config", name), join(project, "config", name));
  }
  return project;
}

function item(
  source: string,
  category: NormalizedItem["category"] = Category.NEWS,
): NormalizedItem {
  return {
    source,
    category,
    title: `${source} verified item`,
    url: `https://example.test/${source}`,
    author: null,
    publishedAt: "2026-07-18T05:00:00.000Z",
    comments: source === "hacker-news" ? 20 : null,
    score: source === "hacker-news" ? 50 : null,
    stars: source === "github" ? 100 : null,
    summary: null,
    rawMetrics: source === "github" ? { stars: 100, starDelta: null } : {},
    collectedAt: NOW.toISOString(),
  };
}

function registration(
  sourceId: string,
  tier: "core" | "optional",
  candidate: NormalizedItem,
): RegisteredCollector {
  return {
    tier,
    collector: {
      sourceId,
      async collect() {
        return {
          sourceId,
          status: "ok" as const,
          fetchedAt: NOW.toISOString(),
          lastSuccessfulAt: NOW.toISOString(),
          items: [candidate],
        };
      },
    },
  };
}

afterEach(() => {
  for (const project of roots.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe("runDailyCollection", () => {
  it("collects, ranks, persists, snapshots GitHub, and logs count-only status", async () => {
    const project = root();
    const result = await runDailyCollection({
      projectRoot: project,
      now: NOW,
      httpClient: http,
      registrations: [
        registration("hacker-news", "core", item("hacker-news", Category.COMMUNITY)),
        registration("github", "core", item("github", Category.GITHUB)),
        registration("rss", "optional", {
          ...item("rss:old", Category.NEWS),
          publishedAt: "2026-07-15T05:00:00.000Z",
        }),
        {
          tier: "optional",
          collector: {
            sourceId: "reddit",
            async collect() {
              throw new Error("Bearer pipeline-secret");
            },
          },
        },
      ],
      minimumCoreSuccesses: 2,
    });

    expect(result.collection.items).toHaveLength(3);
    expect(result.eligibleItemCount).toBe(2);
    expect(result.ranked).toHaveLength(2);
    expect(result.collection.degraded).toBe(true);
    expect(readFileSync(result.artifacts.rawPath, "utf8")).toContain("hacker-news");
    expect(readFileSync(result.artifacts.rawPath, "utf8")).toContain("rss:old");
    expect(readFileSync(result.artifacts.rankedPath, "utf8")).not.toContain("rss:old");
    expect(
      readFileSync(join(project, "data", "history", "github-stars.json"), "utf8"),
    ).toContain('"github verified item": 100');
    const log = readFileSync(result.logPath, "utf8");
    expect(log).toContain("collection completed");
    expect(log).not.toContain("pipeline-secret");
  });

  it("does not persist a successful run when too few core collectors succeed", async () => {
    const project = root();
    await expect(
      runDailyCollection({
        projectRoot: project,
        now: NOW,
        httpClient: http,
        registrations: [
          registration("hacker-news", "core", item("hacker-news")),
          {
            tier: "core",
            collector: {
              sourceId: "github",
              async collect() {
                throw new Error("private failure detail");
              },
            },
          },
        ],
        minimumCoreSuccesses: 2,
      }),
    ).rejects.toMatchObject({ name: "CollectionRunError" });
    const log = readFileSync(
      join(project, "logs", "collection-2026-07-18.jsonl"),
      "utf8",
    );
    expect(log).toContain("collection failed");
    expect(log).not.toContain("private failure detail");
  });
});
