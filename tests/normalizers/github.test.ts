import { describe, expect, it } from "vitest";

import {
  GitHubRepositorySchema,
  normalizeGitHubRepository,
} from "../../src/normalizers/github.js";
import { NormalizedItemSchema } from "../../src/types/item.js";

const NOW = "2026-07-18T06:00:00.000Z";

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    full_name: "example/verified-project",
    html_url: "https://github.com/example/verified-project",
    description: "A verifiable public project.",
    stargazers_count: 1_200,
    forks_count: 80,
    open_issues_count: 12,
    language: "TypeScript",
    created_at: "2026-07-08T06:00:00.000Z",
    updated_at: "2026-07-18T05:00:00.000Z",
    fork: false,
    archived: false,
    owner: { login: "example" },
    ...overrides,
  };
}

describe("GitHub normalizer", () => {
  it("retains verifiable metadata, transparent metrics, and explicit unknown first-run growth", () => {
    const item = normalizeGitHubRepository(repository(), NOW);

    expect(item).toEqual({
      source: "github",
      category: "github",
      title: "example/verified-project",
      url: "https://github.com/example/verified-project",
      author: "example",
      publishedAt: "2026-07-08T06:00:00.000Z",
      comments: null,
      score: null,
      stars: 1_200,
      summary: "A verifiable public project.",
      rawMetrics: {
        stars: 1_200,
        forks: 80,
        openIssues: 12,
        language: "TypeScript",
        updatedAt: "2026-07-18T05:00:00.000Z",
        ageDays: 10,
        starsPerDay: 120,
        starDelta: null,
        starDeltaWindowHours: null,
        starGrowthPerDay: null,
      },
      collectedAt: NOW,
    });
    expect(NormalizedItemSchema.safeParse(item).success).toBe(true);
  });

  it("computes a real snapshot delta without labeling cumulative stars as growth", () => {
    const item = normalizeGitHubRepository(
      repository(),
      NOW,
      1_125,
      "2026-07-17T00:00:00.000Z",
    );

    expect(item.rawMetrics).toMatchObject({
      stars: 1_200,
      starsPerDay: 120,
      starDelta: 75,
      starDeltaWindowHours: 30,
      starGrowthPerDay: 60,
    });
  });

  it("requires a timestamp for a snapshot delta and rejects a stale window", () => {
    expect(() => normalizeGitHubRepository(repository(), NOW, 1_125)).toThrow(
      /snapshot/i,
    );
    expect(() =>
      normalizeGitHubRepository(
        repository(),
        NOW,
        1_125,
        "2026-07-01T00:00:00.000Z",
      ),
    ).toThrow(/window/i);
  });

  it("redacts candidate text and URL credentials/query secrets before runtime parsing", () => {
    const fakeToken = `ghp_${"x".repeat(36)}`;
    const item = normalizeGitHubRepository(
      repository({
        full_name: `example/token=${fakeToken}`,
        html_url: `https://candidate-user:candidate-pass@github.com/example/project?access_token=${fakeToken}&tab=readme`,
        description: `Authorization: Bearer ${fakeToken}`,
        owner: { login: `token=${fakeToken}` },
      }),
      NOW,
    );

    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toContain("candidate-user");
    expect(serialized).not.toContain("candidate-pass");
    expect(new URL(item.url).searchParams.get("access_token")).toBe(
      "[REDACTED]",
    );
    expect(item.stars).toBe(1_200);
    expect(item.rawMetrics.forks).toBe(80);
  });

  it("rejects unsafe source integers and enforces the constructed item contract", () => {
    expect(
      GitHubRepositorySchema.safeParse(
        repository({ stargazers_count: Number.MAX_SAFE_INTEGER + 1 }),
      ).success,
    ).toBe(false);
    expect(() => normalizeGitHubRepository(repository(), "not-a-date")).toThrow();
  });
});
