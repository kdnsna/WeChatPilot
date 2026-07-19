import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadSentHistory, recordSentItems } from "../../src/history/store.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const NOW = new Date("2026-07-18T08:00:00.000+08:00");
const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-history-"));
  roots.push(root);
  mkdirSync(join(root, "data", "history"), { recursive: true });
  return root;
}

function item(title: string, url = "https://example.test/article"): NormalizedItem {
  return {
    source: "rss:test",
    category: Category.NEWS,
    title,
    url,
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

describe("sent history store", () => {
  it("records sanitized sent items and loads only the configured lookback", () => {
    const root = projectRoot();
    recordSentItems(
      root,
      [
        item(
          "Launch context_token=do-not-store",
          "https://user:password@example.test/article?token=secret&view=full",
        ),
      ],
      new Date("2026-07-15T08:00:00.000+08:00"),
    );
    recordSentItems(
      root,
      [item("Old item", "https://example.test/old")],
      new Date("2026-06-20T08:00:00.000+08:00"),
    );

    const loaded = loadSentHistory(root, NOW, 7);
    const stored = readFileSync(
      join(root, "data", "history", "sent-items.json"),
      "utf8",
    );

    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]?.title).toContain("[REDACTED]");
    expect(loaded.items[0]?.url).toContain("view=full");
    expect(stored).not.toMatch(/do-not-store|password|token=secret/);
  });

  it("skips malformed entries with count-only diagnostics", () => {
    const root = projectRoot();
    writeFileSync(
      join(root, "data", "history", "sent-items.json"),
      JSON.stringify([
        {
          title: "Valid",
          url: "https://example.test/valid",
          source: "rss:test",
          sentAt: "2026-07-17T00:00:00.000Z",
        },
        { title: "secret malformed", authorization: "Bearer secret-value" },
      ]),
    );

    const loaded = loadSentHistory(root, NOW, 7);

    expect(loaded.items).toHaveLength(1);
    expect(loaded.invalidEntries).toBe(1);
    expect(JSON.stringify(loaded)).not.toContain("secret-value");
  });

  it("degrades a malformed history document to an empty result", () => {
    const root = projectRoot();
    writeFileSync(join(root, "data", "history", "sent-items.json"), "not-json");

    expect(loadSentHistory(root, NOW, 7)).toEqual({
      items: [],
      invalidEntries: 1,
    });
  });

  it("keeps persisted history bounded to thirty days and ten thousand entries", () => {
    const root = projectRoot();
    const many = Array.from({ length: 10_050 }, (_, index) =>
      item(`Item ${index}`, `https://example.test/${index}`),
    );

    recordSentItems(root, many, NOW);
    const stored = JSON.parse(
      readFileSync(join(root, "data", "history", "sent-items.json"), "utf8"),
    ) as unknown[];

    expect(stored).toHaveLength(10_000);
  });
});
