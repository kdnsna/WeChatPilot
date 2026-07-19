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
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDailyDigest } from "../../src/app/digest.js";
import type { RegisteredCollector } from "../../src/collectors/run.js";
import type { HttpClient } from "../../src/lib/http.js";
import { Category, type NormalizedItem } from "../../src/types/item.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-07-18T06:00:00.000Z");
const roots: string[] = [];
const http: HttpClient = {
  getJson: async () => ({}),
  getText: async () => "",
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-digest-app-"));
  roots.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  for (const name of [
    "sources.yaml",
    "ranking.yaml",
    "digest.yaml",
    "digest-output.schema.json",
  ]) {
    copyFileSync(join(repositoryRoot, "config", name), join(root, "config", name));
  }
  copyFileSync(
    join(repositoryRoot, "prompts", "daily-digest.md"),
    join(root, "prompts", "daily-digest.md"),
  );
  return root;
}

function item(source: string, category: NormalizedItem["category"]): NormalizedItem {
  return {
    source,
    category,
    title: `${source} context_token=must-not-enter-prompt`,
    url: `https://example.test/${source}`,
    author: null,
    publishedAt: "2026-07-18T05:00:00.000Z",
    comments: category === Category.COMMUNITY ? 30 : null,
    score: category === Category.COMMUNITY ? 50 : null,
    stars: category === Category.GITHUB ? 100 : null,
    summary: null,
    rawMetrics: {},
    collectedAt: NOW.toISOString(),
  };
}

const generatedTitles = [
  "Compiler",
  "Database",
  "Satellite",
  "Encryption",
  "Robotics",
  "Networking",
  "Storage",
  "Kernel",
  "Browser",
  "Language",
  "Inference",
  "Privacy",
  "Sensors",
] as const;

function generatedItems(): NormalizedItem[] {
  return generatedTitles.map((title, index) => {
    const category =
      index < 3
        ? Category.COMMUNITY
        : index < 10
          ? Category.NEWS
          : Category.GITHUB;
    const source =
      category === Category.COMMUNITY
        ? "hacker-news"
        : category === Category.GITHUB
          ? "github"
          : "rss:test";
    return {
      ...item(source, category),
      title,
      url:
        index === 0
          ? "https://blocked.test/story?view=full"
          : `https://example.test/generated-${index + 1}`,
      rawMetrics:
        index === 0
          ? {
              hnId: 42,
              discussionUrl: "https://news.ycombinator.com/item?id=42",
            }
          : {},
    };
  });
}

function generatedDigest(urls: readonly string[]): string {
  let urlIndex = 0;
  const entries = (count: number): string =>
    Array.from({ length: count }, (_, index) => {
      const url = urls[urlIndex] ?? urls[0]!;
      urlIndex += 1;
      return `【${index + 1}】候选标题\n事实：这是一段经过来源核验的技术事实。意义：解释技术机制、讨论热度和行业影响，并把事实与判断明确分开。依据：来源内百分位和发布时间衰减。\n原文链接：${url}`;
    }).join("\n\n");
  let digest = `《科技与灵感日报｜2026年07月18日》\n\n一、今日技术社区热议\n${entries(3)}\n\n二、科技圈核心新闻\n${entries(5)}\n\n三、GitHub 今日发现\n${entries(3)}\n\n四、今日深度阅读\n${entries(2)}\n\n五、今日一句判断\n判断：当前变化值得持续观察，但不应把短期热度夸大为确定趋势。`;
  while (
    [
      ...digest
        .replace(/https?:\/\/[^\s<>"']+/gu, "")
        .replace(/\s/gu, ""),
    ].length < 2_100
  ) {
    digest += "需要继续用公开指标和后续事实验证这一判断。";
  }
  return digest;
}

function registration(
  sourceId: string,
  candidate: NormalizedItem,
): RegisteredCollector {
  return {
    tier: "core",
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runDailyDigest", () => {
  it("creates a non-executing Codex dry-run input and safe invocation", async () => {
    const root = project();
    const execute = vi.fn(async () => "must not run");
    const linkProbe = vi.fn(async () => true);
    const result = await runDailyDigest({
      projectRoot: root,
      now: NOW,
      dryRun: true,
      httpClient: http,
      registrations: [
        registration("hacker-news", item("hacker-news", Category.COMMUNITY)),
        registration("github", item("github", Category.GITHUB)),
      ],
      minimumCoreSuccesses: 2,
      executeCodex: execute,
      linkProbe,
    });

    expect(result.status).toBe("dry-run");
    expect(execute).not.toHaveBeenCalled();
    expect(linkProbe).not.toHaveBeenCalled();
    const input = readFileSync(result.inputPath, "utf8");
    expect(input).toContain("<candidate_data>");
    expect(input).not.toContain("must-not-enter-prompt");
    expect(result.invocation.args).toContain("read-only");
    expect(result.invocation.args).toContain("shell_tool");
    expect(result.invocation.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("repairs selected links after validation and before writing artifacts", async () => {
    const root = project();
    const candidates = generatedItems();
    const primaryUrls = candidates.map((candidate) => candidate.url);
    const discussionUrl = "https://news.ycombinator.com/item?id=42";
    const execute = vi.fn(async () =>
      JSON.stringify({
        title: "《科技与灵感日报｜2026年07月18日》",
        date: "2026-07-18",
        digest: generatedDigest(primaryUrls),
        sourceUrls: primaryUrls,
      }),
    );
    const linkProbe = vi.fn(
      async (url: string) => url !== "https://blocked.test/story?view=full",
    );

    const result = await runDailyDigest({
      projectRoot: root,
      now: NOW,
      httpClient: http,
      registrations: [
        {
          tier: "core",
          collector: {
            sourceId: "fixture",
            async collect() {
              return {
                sourceId: "fixture",
                status: "ok" as const,
                fetchedAt: NOW.toISOString(),
                lastSuccessfulAt: NOW.toISOString(),
                items: candidates,
              };
            },
          },
        },
      ],
      minimumCoreSuccesses: 1,
      executeCodex: execute,
      linkProbe,
    });

    expect(result.status).toBe("generated");
    if (result.status !== "generated") {
      throw new Error("expected generated digest");
    }
    expect(result.output.sourceUrls).toContain(discussionUrl);
    expect(result.output.sourceUrls).not.toContain(primaryUrls[0]);
    expect(result.output.digest).toContain(discussionUrl);
    expect(readFileSync(result.digestPath, "utf8")).toContain(discussionUrl);
    expect(readFileSync(result.jsonPath, "utf8")).toContain(discussionUrl);
    const historyManifest = readFileSync(
      join(root, "output", "2026-07-18-history.json"),
      "utf8",
    );
    expect(historyManifest).toContain(discussionUrl);
    expect(historyManifest).not.toContain(primaryUrls[0]);
  });
});
