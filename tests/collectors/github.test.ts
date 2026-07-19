import { describe, expect, it } from "vitest";

import { createGitHubCollector } from "../../src/collectors/github.js";
import { HttpError } from "../../src/lib/http.js";
import { GitHubSearchResponseSchema } from "../../src/normalizers/github.js";
import { CollectorResultSchema } from "../../src/types/collector.js";

const NOW = new Date("2026-07-18T06:00:00.000Z");

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
    created_at: "2026-07-10T06:00:00.000Z",
    updated_at: "2026-07-18T05:00:00.000Z",
    fork: false,
    archived: false,
    owner: { login: "example" },
    ...overrides,
  };
}

describe("GitHub collector", () => {
  it("queries recent non-fork non-archived repositories, sends required headers, and skips bad items", async () => {
    const fakeToken = `github_pat_${"z".repeat(24)}`;
    let requestedUrl = "";
    const collector = createGitHubCollector({
      token: fakeToken,
      lookbackDays: 14,
      minStars: 100,
      itemLimit: 10,
      previousStars: { "example/verified-project": 1_150 },
      previousSnapshotAt: "2026-07-17T06:00:00.000Z",
    });
    const result = await collector.collect({
      http: {
        getText: async () => {
          throw new Error("unexpected text request");
        },
        getJson: async (url, options) => {
          requestedUrl = url.toString();
          const headers = new Headers(options?.headers);
          expect(headers.get("accept")).toBe("application/vnd.github+json");
          expect(headers.get("x-github-api-version")).toBe("2022-11-28");
          expect(headers.get("user-agent")).toContain("daily-tech-digest");
          expect(headers.get("authorization")).toBe(`Bearer ${fakeToken}`);
          expect(options?.signal).toBeUndefined();
          expect(options?.maxResponseBytes).toBe(2 * 1_024 * 1_024);
          return {
            total_count: 2,
            incomplete_results: false,
            items: [
              repository(),
              repository({ id: Number.MAX_SAFE_INTEGER + 1 }),
            ],
          };
        },
      },
      now: () => NOW,
    });

    const query = new URL(requestedUrl).searchParams;
    expect(query.get("q")).toContain("created:>=2026-07-04");
    expect(query.get("q")).toContain("stars:>=100");
    expect(query.get("q")).toContain("fork:false");
    expect(query.get("q")).toContain("archived:false");
    expect(query.get("sort")).toBe("stars");
    expect(query.get("order")).toBe("desc");
    expect(query.get("per_page")).toBe("10");
    expect(result).toMatchObject({
      sourceId: "github",
      status: "ok",
      fetchedAt: NOW.toISOString(),
      lastSuccessfulAt: NOW.toISOString(),
      warning: "GitHub skipped 1 invalid repository",
      items: [
        {
          title: "example/verified-project",
          stars: 1_200,
          rawMetrics: {
            starDelta: 50,
            starDeltaWindowHours: 24,
            starGrowthPerDay: 50,
          },
        },
      ],
      rawEvidence: {
        endpointRequests: 1,
        receivedRepositories: 2,
        validRepositories: 1,
        invalidRepositories: 1,
        truncatedRepositories: 0,
        totalCount: 2,
        incompleteResults: false,
        lookbackDays: 14,
        minimumStars: 100,
      },
    });
    expect(JSON.stringify(result)).not.toContain(fakeToken);
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("works without a token and does not invent growth on first collection", async () => {
    const collector = createGitHubCollector({ itemLimit: 5 });
    const result = await collector.collect({
      http: {
        getText: async () => "",
        getJson: async (_url, options) => {
          expect(new Headers(options?.headers).has("authorization")).toBe(false);
          return {
            total_count: 1,
            incomplete_results: false,
            items: [repository()],
          };
        },
      },
      now: () => NOW,
    });

    expect(result.items[0]?.rawMetrics.starDelta).toBeNull();
  });

  it("redacts untrusted response candidates from items and evidence", async () => {
    const fakeToken = `ghp_${"q".repeat(36)}`;
    const result = await createGitHubCollector({}).collect({
      http: {
        getText: async () => "",
        getJson: async () => ({
          total_count: 1,
          incomplete_results: false,
          items: [
            repository({
              full_name: `example/token=${fakeToken}`,
              html_url: `https://candidate-user:candidate-pass@github.com/example/project?api_key=${fakeToken}`,
              description: `token=${fakeToken}`,
              owner: { login: `token=${fakeToken}` },
            }),
          ],
        }),
      },
      now: () => NOW,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toContain("candidate-user");
    expect(serialized).not.toContain("candidate-pass");
    expect(result.items[0]?.stars).toBe(1_200);
  });

  it.each([
    [new HttpError({ kind: "rate_limited", retryable: false, status: 429 }), "rate_limited"],
    [
      new HttpError({
        kind: "blocked",
        retryable: false,
        status: 403,
        rateLimit: { remaining: 0 },
      }),
      "rate_limited",
    ],
    [new HttpError({ kind: "blocked", retryable: false, status: 403 }), "blocked"],
  ] as const)("degrades a GitHub API failure to %s", async (error, status) => {
    Object.assign(error, { detail: "token=error-payload-must-not-leak" });
    const result = await createGitHubCollector({}).collect({
      http: {
        getText: async () => "",
        getJson: async () => {
          throw error;
        },
      },
      now: () => NOW,
    });

    expect(result).toMatchObject({ sourceId: "github", status, items: [] });
    expect(JSON.stringify(result)).not.toContain("error-payload-must-not-leak");
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("propagates aborted requests as HttpError(kind=aborted)", async () => {
    await expect(
      createGitHubCollector({}).collect({
        http: {
          getText: async () => "",
          getJson: async () => {
            throw new HttpError({ kind: "aborted", retryable: false });
          },
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("bounds options and response size", () => {
    expect(() => createGitHubCollector({ lookbackDays: 366 })).toThrow(RangeError);
    expect(() => createGitHubCollector({ itemLimit: 101 })).toThrow(RangeError);
    expect(() => createGitHubCollector({ minStars: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      RangeError,
    );
    expect(
      GitHubSearchResponseSchema.safeParse({
        total_count: 101,
        incomplete_results: false,
        items: Array.from({ length: 101 }, () => ({})),
      }).success,
    ).toBe(false);
    expect(() =>
      createGitHubCollector({ previousStars: { "example/project": 1 } }),
    ).toThrow(/snapshot/i);
  });

  it("rejects malformed endpoints without retaining URL secrets in the error", () => {
    const fakeSecret = `ghp_${"e".repeat(36)}`;
    let thrown: unknown;
    try {
      createGitHubCollector({
        endpoint: `not a URL?access_token=${fakeSecret}`,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(fakeSecret);
    expect(JSON.stringify(thrown)).not.toContain(fakeSecret);
  });
});
