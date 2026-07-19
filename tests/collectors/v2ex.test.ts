import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createV2exCollector } from "../../src/collectors/v2ex.js";
import {
  HttpError,
  createHttpClient,
  type FetchLike,
} from "../../src/lib/http.js";
import { V2exTopicSchema } from "../../src/normalizers/v2ex.js";
import { CollectorResultSchema } from "../../src/types/collector.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const ENDPOINT = "https://v2ex.test/api/topics/hot.json";
const fixturePath = fileURLToPath(
  new URL("../fixtures/v2ex/hot.json", import.meta.url),
);
const hotTopics = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

const technicalFilter = {
  technicalNodes: ["programmer", "python", "typescript", "linux"],
  technicalKeywords: ["kubernetes"],
} as const;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createCollector(
  filter: {
    readonly technicalNodes: readonly string[];
    readonly technicalKeywords: readonly string[];
  } = technicalFilter,
  options: { readonly evidenceLimit?: number } = {},
) {
  return createV2exCollector({ endpoint: ENDPOINT, ...filter, ...options });
}

function topicPayload(
  id: number,
  options: {
    readonly nodeName?: string;
    readonly nodeTitle?: string;
    readonly title?: string;
    readonly content?: string;
  } = {},
): Record<string, unknown> {
  return {
    id,
    title: options.title ?? `Topic ${id}`,
    url: `https://www.v2ex.com/t/${id}`,
    content: options.content ?? `Content ${id}`,
    replies: id % 10,
    member: null,
    node: {
      name: options.nodeName ?? "life",
      title: options.nodeTitle ?? "生活",
    },
    created: 1784372400,
  };
}

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return new Error("expected promise to reject");
  } catch (error) {
    return error;
  }
}

describe("V2EX collector", () => {
  it("rejects unsafe upstream topic IDs and reply counts", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const baseTopic = topicPayload(101, { nodeName: "programmer" });

    expect(V2exTopicSchema.safeParse({ ...baseTopic, id: unsafe }).success).toBe(
      false,
    );
    expect(
      V2exTopicSchema.safeParse({ ...baseTopic, replies: unsafe }).success,
    ).toBe(false);
  });

  it("fetches hot topics once and normalizes reply, node, author, and time fields", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (input) => {
      calls.push(String(input));
      return jsonResponse(hotTopics);
    };
    const result = await createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
    });

    expect(calls).toEqual([ENDPOINT]);
    expect(result.items[0]).toEqual({
      source: "v2ex",
      category: "community",
      title: "Node.js 22 production lessons",
      url: "https://www.v2ex.com/t/201",
      author: "alice",
      publishedAt: "2026-07-18T10:00:00.000Z",
      comments: 21,
      score: null,
      stars: null,
      summary: null,
      rawMetrics: {
        topicId: 201,
        nodeName: "programmer",
        nodeTitle: "程序员",
        replies: 21,
        lastTouched: 1784372400,
        lastModified: 1784370600,
      },
      collectedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(result.rawEvidence).toMatchObject({
      topics: expect.arrayContaining([expect.objectContaining({ id: 201 })]),
      failureCounts: { requests: 0, invalidPayloads: 0 },
    });
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("redacts untrusted topic strings and URL secrets from items and evidence", async () => {
    const secrets = {
      title: `v2ex-title-${"a".repeat(24)}`,
      member: `v2ex-member-${"b".repeat(24)}`,
      nodeName: `v2ex-node-name-${"c".repeat(24)}`,
      nodeTitle: `v2ex-node-title-${"d".repeat(24)}`,
      username: `v2ex-user-${"e".repeat(24)}`,
      password: `v2ex-password-${"f".repeat(24)}`,
      session: `v2ex-session-${"g".repeat(24)}`,
      clientSecret: `v2ex-client-${"h".repeat(24)}`,
      accessToken: `v2ex-access-${"i".repeat(24)}`,
    } as const;
    const payload = {
      ...topicPayload(699),
      title: `Kubernetes token=${secrets.title}`,
      url:
        `https://${secrets.username}:${secrets.password}@www.v2ex.com/t/699` +
        `?session=${secrets.session}&client_secret=${secrets.clientSecret}` +
        `&access%5Ftoken=${secrets.accessToken}&view=full`,
      replies: 17,
      member: { username: `session=${secrets.member}` },
      node: {
        name: `python token=${secrets.nodeName}`,
        title: `client_secret=${secrets.nodeTitle}`,
      },
    };

    const result = await createCollector().collect({
      http: createHttpClient({ fetch: async () => jsonResponse([payload]) }),
      now: () => NOW,
    });
    const item = result.items[0];
    const evidence = result.rawEvidence as unknown as {
      readonly topics: readonly Record<string, unknown>[];
    };
    const rawTopic = evidence.topics[0];

    expect(item).toMatchObject({
      title: "Kubernetes token=[REDACTED]",
      author: "session=[REDACTED]",
      comments: 17,
      rawMetrics: {
        topicId: 699,
        nodeName: "python token=[REDACTED]",
        nodeTitle: "client_secret=[REDACTED]",
        replies: 17,
      },
    });
    expect(rawTopic).toMatchObject({
      id: 699,
      title: "Kubernetes token=[REDACTED]",
      replies: 17,
      member: { username: "session=[REDACTED]" },
      node: {
        name: "python token=[REDACTED]",
        title: "client_secret=[REDACTED]",
      },
    });
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(item)).not.toContain(secret);
      expect(JSON.stringify(rawTopic)).not.toContain(secret);
    }

    for (const candidateUrl of [item?.url, rawTopic?.url]) {
      expect(typeof candidateUrl).toBe("string");
      const parsedUrl = new URL(String(candidateUrl));
      expect(decodeURIComponent(parsedUrl.username)).toBe("[REDACTED]");
      expect(parsedUrl.password).toBe("");
      expect(parsedUrl.searchParams.get("session")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("client_secret")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("access_token")).toBe("[REDACTED]");
      expect(parsedUrl.searchParams.get("view")).toBe("full");
    }
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("keeps a recent topic when either its configured node or title is technical", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({ fetch: async () => jsonResponse(hotTopics) }),
      now: () => NOW,
    });

    expect(result.items.map((item) => item.rawMetrics.topicId)).toEqual([
      201,
      202,
      205,
    ]);
    expect(result.items[1]).toMatchObject({
      title: "Kubernetes production incident review",
      author: null,
      rawMetrics: { nodeName: "all4all", nodeTitle: "二手交易信息" },
    });
  });

  it("uses last_touched, then last_modified, then created for the activity window", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({ fetch: async () => jsonResponse(hotTopics) }),
      now: () => NOW,
    });

    expect(result.items.map((item) => item.rawMetrics.topicId)).not.toContain(204);
    expect(result.items.map((item) => item.rawMetrics.topicId)).not.toContain(206);
    expect(result.items.find((item) => item.rawMetrics.topicId === 205)).toMatchObject({
      publishedAt: "2026-07-15T12:00:00.000Z",
      rawMetrics: {
        lastTouched: 1784372400,
        lastModified: 1784203200,
      },
    });
  });

  it("returns ok with an explicit warning when no topic is technically relevant", async () => {
    const result = await createCollector({
      technicalNodes: ["hardware"],
      technicalKeywords: ["quantum-safe-impossible-match"],
    }).collect({
      http: createHttpClient({ fetch: async () => jsonResponse(hotTopics) }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "ok",
      items: [],
      warning: "V2EX returned no technically relevant topics",
    });
  });

  it("returns invalid for a malformed payload without leaking response values", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () => jsonResponse({ unexpected: "fixture-value" }),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      sourceId: "v2ex",
      status: "invalid",
      items: [],
      warning: "V2EX returned an invalid payload",
      rawEvidence: {
        topics: [],
        failureCounts: { requests: 0, invalidPayloads: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-value");
    expect(CollectorResultSchema.safeParse(result).success).toBe(true);
  });

  it("skips a malformed topic while retaining valid topics", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () =>
          jsonResponse([
            topicPayload(701, {
              nodeName: "python",
              nodeTitle: "Python",
              title: "Python release notes",
            }),
            { id: 702, unexpected: "invalid topic fixture" },
          ]),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "ok",
      lastSuccessfulAt: "2026-07-18T12:00:00.000Z",
      warning: "V2EX skipped 1 invalid topic",
      items: [
        expect.objectContaining({
          rawMetrics: expect.objectContaining({ topicId: 701 }),
        }),
      ],
      rawEvidence: {
        failureCounts: {
          receivedTopics: 2,
          validTopics: 1,
          invalidTopics: 1,
          selectedTopics: 1,
          evidenceIncluded: 1,
          evidenceTruncated: 0,
        },
      },
    });
  });

  it("returns invalid when a nonempty envelope contains no valid topics", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () =>
          jsonResponse([
            { id: 801, unexpected: "invalid one" },
            { title: "missing required fields" },
          ]),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "invalid",
      items: [],
      warning: "V2EX returned an invalid payload",
      rawEvidence: {
        topics: [],
        failureCounts: {
          receivedTopics: 2,
          validTopics: 0,
          invalidTopics: 2,
          selectedTopics: 0,
          evidenceIncluded: 0,
          evidenceTruncated: 0,
        },
      },
    });
    expect(result).not.toHaveProperty("lastSuccessfulAt");
  });

  it("treats an empty topic envelope as a successful empty collection", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({ fetch: async () => jsonResponse([]) }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "ok",
      items: [],
      lastSuccessfulAt: "2026-07-18T12:00:00.000Z",
      warning: "V2EX returned no technically relevant topics",
      rawEvidence: {
        topics: [],
        failureCounts: {
          receivedTopics: 0,
          validTopics: 0,
          invalidTopics: 0,
          selectedTopics: 0,
          evidenceIncluded: 0,
          evidenceTruncated: 0,
        },
      },
    });
  });

  it("returns invalid instead of throwing for an out-of-range created timestamp", async () => {
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () =>
          jsonResponse([
            {
              id: 999,
              title: "Python timestamp fixture",
              url: "https://www.v2ex.com/t/999",
              replies: 1,
              member: null,
              node: { name: "python", title: "Python" },
              created: 9_000_000_000_000,
              last_touched: 1784372400,
            },
          ]),
      }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "invalid",
      items: [],
      warning: "V2EX returned an invalid payload",
    });
  });

  it("rejects an oversized hot-topic array before normalization or evidence capture", async () => {
    const topics = [...Array(101)].map((_, index) => ({
      id: index + 1,
      title: `Python topic ${index + 1}`,
      url: `https://www.v2ex.com/t/${index + 1}`,
      replies: 0,
      member: null,
      node: { name: "python", title: "Python" },
      created: 1784372400,
    }));
    const result = await createCollector().collect({
      http: createHttpClient({ fetch: async () => jsonResponse(topics) }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "invalid",
      items: [],
      rawEvidence: { topics: [] },
    });
  });

  it("places a late selected topic first in bounded raw evidence", async () => {
    const payload = [
      topicPayload(901),
      topicPayload(902),
      topicPayload(903),
      topicPayload(904),
      topicPayload(905, {
        nodeName: "python",
        nodeTitle: "Python",
        title: "Python packaging update",
      }),
    ];
    const result = await createCollector(technicalFilter, {
      evidenceLimit: 2,
    }).collect({
      http: createHttpClient({ fetch: async () => jsonResponse(payload) }),
      now: () => NOW,
    });
    const evidence = result.rawEvidence as unknown as {
      readonly topics: readonly { readonly id: number }[];
    };

    expect(result.items.map((item) => item.rawMetrics.topicId)).toEqual([905]);
    expect(evidence.topics.map((topic) => topic.id)).toEqual([905, 901]);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: {
        receivedTopics: 5,
        validTopics: 5,
        invalidTopics: 0,
        selectedTopics: 1,
        evidenceIncluded: 2,
        evidenceTruncated: 3,
      },
    });
  });

  it("discloses when selected topics exceed the evidence limit", async () => {
    const payload = [
      topicPayload(911, { nodeName: "python", nodeTitle: "Python" }),
      topicPayload(912, { nodeName: "python", nodeTitle: "Python" }),
      topicPayload(913, { nodeName: "python", nodeTitle: "Python" }),
      topicPayload(914),
    ];
    const result = await createCollector(technicalFilter, {
      evidenceLimit: 2,
    }).collect({
      http: createHttpClient({ fetch: async () => jsonResponse(payload) }),
      now: () => NOW,
    });
    const evidence = result.rawEvidence as unknown as {
      readonly topics: readonly { readonly id: number }[];
    };

    expect(result.items.map((item) => item.rawMetrics.topicId)).toEqual([
      911,
      912,
      913,
    ]);
    expect(evidence.topics.map((topic) => topic.id)).toEqual([911, 912]);
    expect(result.warning).toMatch(/1 selected topic omitted/i);
    expect(result.rawEvidence).toMatchObject({
      failureCounts: {
        receivedTopics: 4,
        validTopics: 4,
        invalidTopics: 0,
        selectedTopics: 3,
        evidenceIncluded: 2,
        evidenceTruncated: 2,
      },
    });
  });

  it("does not mirror topic content into normalized items or raw evidence", async () => {
    const content = "Ordinary body text that must stay outside candidate evidence.";
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () =>
          jsonResponse([
            topicPayload(921, {
              nodeName: "python",
              nodeTitle: "Python",
              content,
            }),
          ]),
      }),
      now: () => NOW,
    });

    expect(result.items[0]?.summary).toBeNull();
    expect(JSON.stringify(result.rawEvidence)).not.toContain(content);
  });

  it.each([
    [401, "unauthorized"],
    [403, "blocked"],
    [429, "rate_limited"],
  ] as const)("degrades HTTP %i to %s", async (status, expectedStatus) => {
    let requests = 0;
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () => {
          requests += 1;
          return jsonResponse({ unavailable: true }, status);
        },
      }),
      now: () => NOW,
    });

    expect(requests).toBe(1);
    expect(result).toMatchObject({
      sourceId: "v2ex",
      status: expectedStatus,
      items: [],
      warning: `V2EX request failed: ${expectedStatus}`,
    });
    expect(JSON.stringify(result)).not.toContain(ENDPOINT);
  });

  it("classifies a bounded HTTP timeout", async () => {
    const fetch: FetchLike = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const result = await createCollector().collect({
      http: createHttpClient({ fetch, timeoutMs: 10 }),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "timeout",
      items: [],
      warning: "V2EX request failed: timeout",
    });
  });

  it("classifies a generic network failure without exposing its message", async () => {
    let attempts = 0;
    const result = await createCollector().collect({
      http: createHttpClient({
        fetch: async () => {
          attempts += 1;
          throw new TypeError("fixture network detail");
        },
        retryDelayMs: 0,
        sleep: async () => undefined,
      }),
      now: () => NOW,
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      status: "error",
      items: [],
      warning: "V2EX request failed: error",
    });
    expect(JSON.stringify(result)).not.toContain("fixture network detail");
  });

  it("propagates a pre-aborted signal without invoking fetch", async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort("operator stop");
    const outcome = await rejectionOf(
      createCollector().collect({
        http: createHttpClient({
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse(hotTopics);
          },
        }),
        now: () => NOW,
        signal: controller.signal,
      }),
    );

    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("operator stop");
    expect(fetchCalls).toBe(0);
  });

  it("propagates a mid-flight abort instead of returning source health", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const fetch: FetchLike = async (_input, init) => {
      markStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const collection = createCollector().collect({
      http: createHttpClient({ fetch }),
      now: () => NOW,
      signal: controller.signal,
    });
    await started;
    controller.abort("operator stop");

    const outcome = await rejectionOf(collection);
    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ kind: "aborted", retryable: false });
    expect(JSON.stringify(outcome)).not.toContain(ENDPOINT);
  });
});
