import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadPriorGitHubSnapshot,
  recordGitHubSnapshot,
} from "../../src/history/github-snapshots.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const roots: string[] = [];

function root(): string {
  const project = mkdtempSync(join(tmpdir(), "daily-tech-gh-snapshot-"));
  roots.push(project);
  mkdirSync(join(project, "data", "history"), { recursive: true });
  return project;
}

function repository(title: string, stars: number): NormalizedItem {
  return {
    source: "github",
    category: Category.GITHUB,
    title,
    url: `https://github.com/${title}`,
    author: title.split("/")[0] ?? null,
    publishedAt: "2026-07-01T00:00:00.000Z",
    comments: null,
    score: null,
    stars,
    summary: null,
    rawMetrics: { stars },
    collectedAt: "2026-07-18T06:00:00.000Z",
  };
}

afterEach(() => {
  for (const project of roots.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe("GitHub snapshot history", () => {
  it("selects the snapshot closest to 24 hours and reports the real window", () => {
    const project = root();
    recordGitHubSnapshot(
      project,
      [repository("example/project", 100)],
      new Date("2026-07-16T06:00:00.000Z"),
    );
    recordGitHubSnapshot(
      project,
      [repository("example/project", 130)],
      new Date("2026-07-17T06:00:00.000Z"),
    );
    recordGitHubSnapshot(
      project,
      [repository("example/project", 145)],
      new Date("2026-07-18T00:00:00.000Z"),
    );

    expect(
      loadPriorGitHubSnapshot(project, new Date("2026-07-18T06:00:00.000Z")),
    ).toEqual({
      capturedAt: "2026-07-17T06:00:00.000Z",
      windowHours: 24,
      stars: { "example/project": 130 },
      invalidEntries: 0,
    });
  });

  it("returns no growth baseline on first run or when snapshots are stale", () => {
    const project = root();
    expect(
      loadPriorGitHubSnapshot(project, new Date("2026-07-18T06:00:00.000Z")),
    ).toEqual({ snapshot: null, invalidEntries: 0 });
    recordGitHubSnapshot(
      project,
      [repository("example/project", 100)],
      new Date("2026-07-10T06:00:00.000Z"),
    );
    expect(
      loadPriorGitHubSnapshot(project, new Date("2026-07-18T06:00:00.000Z")),
    ).toEqual({ snapshot: null, invalidEntries: 0 });
  });

  it("sanitizes repository names, ignores non-GitHub items, and writes privately", () => {
    const project = root();
    const secret = `ghp_${"x".repeat(36)}`;
    recordGitHubSnapshot(
      project,
      [
        repository(`example/token=${secret}`, 100),
        { ...repository("rss/not-github", 50), source: "rss:test" },
      ],
      new Date("2026-07-17T06:00:00.000Z"),
    );
    const path = join(project, "data", "history", "github-stars.json");
    const stored = readFileSync(path, "utf8");

    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("rss/not-github");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("degrades malformed snapshot entries with count-only diagnostics", () => {
    const project = root();
    writeFileSync(
      join(project, "data", "history", "github-stars.json"),
      JSON.stringify({
        version: 1,
        snapshots: [
          {
            capturedAt: "2026-07-17T06:00:00.000Z",
            stars: { "example/project": 120 },
          },
          { token: "secret malformed entry" },
        ],
      }),
    );

    expect(
      loadPriorGitHubSnapshot(project, new Date("2026-07-18T06:00:00.000Z")),
    ).toMatchObject({
      capturedAt: "2026-07-17T06:00:00.000Z",
      stars: { "example/project": 120 },
      invalidEntries: 1,
    });
  });
});
