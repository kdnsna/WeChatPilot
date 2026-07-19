import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DigestCandidate } from "../../src/digest/candidates.js";
import type { DigestOutput } from "../../src/digest/validate.js";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-digest-manifest-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("digest history manifest", () => {
  it("binds the selected accessible URL to the digest and its source item", async () => {
    const module = await import("../../src/history/digest-manifest.js").catch(
      () => ({}),
    );
    const writeDigestHistoryManifest = (
      module as {
        writeDigestHistoryManifest?: (...args: readonly unknown[]) => string;
      }
    ).writeDigestHistoryManifest;
    const loadDigestHistoryManifest = (
      module as {
        loadDigestHistoryManifest?: (...args: readonly unknown[]) => unknown;
      }
    ).loadDigestHistoryManifest;
    expect(writeDigestHistoryManifest).toBeTypeOf("function");
    expect(loadDigestHistoryManifest).toBeTypeOf("function");
    if (
      writeDigestHistoryManifest === undefined ||
      loadDigestHistoryManifest === undefined
    ) {
      return;
    }

    const root = project();
    const output: DigestOutput = {
      title: "《科技与灵感日报｜2026年07月19日》",
      date: "2026-07-19",
      digest: "日报正文与来源链接",
      sourceUrls: ["https://news.ycombinator.com/item?id=42"],
    };
    const candidate = {
      id: "C001",
      lanes: ["community"],
      title: "A compiler release",
      source: "hacker-news",
      category: "community",
      url: "https://example.test/compiler",
      author: null,
      publishedAt: "2026-07-19T00:00:00.000Z",
      comments: 42,
      score: 80,
      stars: null,
      summary: null,
      rawMetrics: {},
      heatScore: 90,
      components: {
        engagement: 1,
        popularity: 1,
        velocity: 1,
        recency: 1,
        crossSource: 0.5,
        sourceQuality: 1,
      },
      historyFactor: 1,
      velocityMetric: "engagementPerHour",
      confirmedBy: ["hacker-news"],
      relatedUrls: ["https://news.ycombinator.com/item?id=42"],
      reason: "fixture",
    } satisfies DigestCandidate;

    const path = writeDigestHistoryManifest(root, output, [candidate]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadDigestHistoryManifest(root, output.date, output.digest)).toEqual([
      {
        title: candidate.title,
        source: candidate.source,
        url: output.sourceUrls[0],
      },
    ]);
    expect(() =>
      loadDigestHistoryManifest(root, output.date, `${output.digest}篡改`),
    ).toThrow(/manifest|日报/u);
  });
});
