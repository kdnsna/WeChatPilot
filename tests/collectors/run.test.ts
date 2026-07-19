import { describe, expect, it } from "vitest";

import { CollectionRunError, runCollectors } from "../../src/collectors/run.js";
import { HttpError, type HttpClient } from "../../src/lib/http.js";
import type {
  Collector,
  CollectorContext,
  CollectorResult,
} from "../../src/types/collector.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const http: HttpClient = {
  getJson: async () => ({}),
  getText: async () => "",
};

function item(source: string): NormalizedItem {
  return {
    source,
    category: Category.NEWS,
    title: `${source} item`,
    url: `https://example.test/${source}`,
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

function collector(
  sourceId: string,
  implementation?: (context: CollectorContext) => Promise<CollectorResult>,
): Collector {
  return {
    sourceId,
    collect:
      implementation ??
      (async () => ({
        sourceId,
        status: "ok",
        fetchedAt: NOW.toISOString(),
        lastSuccessfulAt: NOW.toISOString(),
        items: [item(sourceId)],
      })),
  };
}

describe("runCollectors", () => {
  it("runs sources independently and degrades a rejected optional source safely", async () => {
    const result = await runCollectors(
      [
        { tier: "core", collector: collector("hacker-news") },
        { tier: "core", collector: collector("github") },
        { tier: "core", collector: collector("rss") },
        {
          tier: "optional",
          collector: collector("reddit", async () => {
            throw new Error("Bearer secret-token-must-not-leak");
          }),
        },
      ],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 2 },
    );

    expect(result.items).toHaveLength(3);
    expect(result.degraded).toBe(true);
    expect(result.coreSuccesses).toBe(3);
    expect(result.results.find((entry) => entry.sourceId === "reddit")).toMatchObject({
      status: "error",
      items: [],
      warning: "reddit collector failed safely",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token-must-not-leak");
  });

  it("tolerates one core failure when the configured minimum still succeeds", async () => {
    const result = await runCollectors(
      [
        { tier: "core", collector: collector("hacker-news") },
        { tier: "core", collector: collector("github") },
        {
          tier: "core",
          collector: collector("rss", async () => {
            throw new Error("feed unavailable");
          }),
        },
      ],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 2 },
    );

    expect(result.coreSuccesses).toBe(2);
    expect(result.degraded).toBe(true);
    expect(result.items.map((candidate) => candidate.source).sort()).toEqual([
      "github",
      "hacker-news",
    ]);
  });

  it("fails with count-only diagnostics below the core-source threshold", async () => {
    const outcome = runCollectors(
      [
        { tier: "core", collector: collector("hacker-news") },
        {
          tier: "core",
          collector: collector("github", async () => {
            throw new Error("ghp_sensitive_value");
          }),
        },
        {
          tier: "core",
          collector: collector("rss", async () => {
            throw new Error("private feed detail");
          }),
        },
      ],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 2 },
    );

    await expect(outcome).rejects.toMatchObject({
      name: "CollectionRunError",
      coreSuccesses: 1,
      minimumCoreSuccesses: 2,
    });
    const error = await outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectionRunError);
    expect(JSON.stringify(error)).not.toMatch(/sensitive|private feed/i);
  });

  it("propagates global cancellation instead of converting it to degradation", async () => {
    const controller = new AbortController();
    controller.abort("local operator detail");

    await expect(
      runCollectors(
        [
          {
            tier: "core",
            collector: collector("hacker-news", async () => {
              throw new HttpError({ kind: "aborted", retryable: false });
            }),
          },
        ],
        { http, now: () => NOW, signal: controller.signal },
        { minimumCoreSuccesses: 1 },
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("treats an invalid collector contract as a sanitized source failure", async () => {
    const malformed = collector("malformed", async () => ({
      sourceId: "malformed",
      status: "ok",
      fetchedAt: "not-a-date",
      items: [],
    }));
    const result = await runCollectors(
      [
        { tier: "core", collector: collector("hacker-news") },
        { tier: "optional", collector: malformed },
      ],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 1 },
    );

    expect(result.results.find((entry) => entry.sourceId === "malformed")).toMatchObject({
      status: "invalid",
      items: [],
    });
  });

  it("redacts a valid but untrusted collector result at the orchestration boundary", async () => {
    const untrusted = collector("untrusted", async () => ({
      sourceId: "untrusted",
      status: "ok",
      fetchedAt: NOW.toISOString(),
      lastSuccessfulAt: NOW.toISOString(),
      items: [
        {
          ...item("untrusted"),
          title: "context_token=collector-secret",
          url: "https://user:password@example.test/item?token=url-secret&view=full",
        },
      ],
      rawEvidence: { authorization: "Bearer evidence-secret" },
    }));

    const result = await runCollectors(
      [{ tier: "core", collector: untrusted }],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 1 },
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/collector-secret|password|url-secret|evidence-secret/);
    expect(result.items[0]?.title).toContain("[REDACTED]");
    expect(result.items[0]?.url).toContain("view=full");
  });

  it("starts independent collectors concurrently", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = (sourceId: string): Collector =>
      collector(sourceId, async () => {
        started.push(sourceId);
        if (started.length === 2) {
          release?.();
        }
        await gate;
        return {
          sourceId,
          status: "ok",
          fetchedAt: NOW.toISOString(),
          lastSuccessfulAt: NOW.toISOString(),
          items: [item(sourceId)],
        };
      });

    const result = await runCollectors(
      [
        { tier: "core", collector: blocking("one") },
        { tier: "core", collector: blocking("two") },
      ],
      { http, now: () => NOW },
      { minimumCoreSuccesses: 2 },
    );

    expect(started.sort()).toEqual(["one", "two"]);
    expect(result.items).toHaveLength(2);
  });
});
