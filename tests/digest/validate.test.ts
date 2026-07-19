import { describe, expect, it } from "vitest";

import {
  DigestValidationError,
  parseAndValidateDigest,
} from "../../src/digest/validate.js";

const DATE = "2026-07-18";
const TITLE = "《科技与灵感日报｜2026年07月18日》";
const urls = Array.from(
  { length: 13 },
  (_, index) => `https://example.test/source-${index + 1}`,
);

function validDigest(): string {
  let urlIndex = 0;
  const entries = (count: number): string =>
    Array.from({ length: count }, (_, index) => {
      const url = urls[urlIndex] ?? urls[0]!;
      urlIndex += 1;
      return `【${index + 1}】候选标题\n事实：这是一段经过来源核验的技术事实。意义：解释技术机制、讨论热度和行业影响，并把事实与判断明确分开。依据：来源内百分位和发布时间衰减。\n原文链接：${url}`;
    }).join("\n\n");
  let digest = `${TITLE}\n\n一、今日技术社区热议\n${entries(3)}\n\n二、科技圈核心新闻\n${entries(5)}\n\n三、GitHub 今日发现\n${entries(3)}\n\n四、今日深度阅读\n${entries(2)}\n\n五、今日一句判断\n判断：当前变化值得持续观察，但不应把短期热度夸大为确定趋势。`;
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

describe("digest output validation", () => {
  it("accepts the exact section counts, candidate URLs, title, and length", () => {
    const result = parseAndValidateDigest(
      JSON.stringify({ title: TITLE, date: DATE, digest: validDigest(), sourceUrls: urls }),
      { date: DATE, allowedUrls: urls },
    );

    expect(result.title).toBe(TITLE);
    expect(result.sourceUrls).toEqual(urls);
    expect(result.digest).toContain("五、今日一句判断");
  });

  it("rejects non-JSON or extra output without echoing it", () => {
    expect(() =>
      parseAndValidateDigest("```json\n{secret}\n```", {
        date: DATE,
        allowedUrls: urls,
      }),
    ).toThrow(DigestValidationError);
  });

  it("reports schema paths and codes without echoing rejected values", () => {
    expect(() =>
      parseAndValidateDigest(
        JSON.stringify({
          title: TITLE,
          date: DATE,
          digest: "secret rejected body",
          sourceUrls: ["https://secret.test/value"],
        }),
        { date: DATE, allowedUrls: urls },
      ),
    ).toThrow(/digest:too_small.*sourceUrls:too_small/i);
    try {
      parseAndValidateDigest(
        JSON.stringify({
          title: TITLE,
          date: DATE,
          digest: "secret rejected body",
          sourceUrls: ["https://secret.test/value"],
        }),
        { date: DATE, allowedUrls: urls },
      );
    } catch (error) {
      expect(String(error)).not.toContain("secret rejected body");
      expect(String(error)).not.toContain("secret.test");
    }
  });

  it("rejects a wrong section count and an out-of-bundle URL", () => {
    const digest = validDigest().replace("【3】候选标题", "候选标题");
    expect(() =>
      parseAndValidateDigest(
        JSON.stringify({
          title: TITLE,
          date: DATE,
          digest: `${digest}\nhttps://outside.test/not-allowed`,
          sourceUrls: [...urls.slice(0, -1), "https://outside.test/not-allowed"],
        }),
        { date: DATE, allowedUrls: urls },
      ),
    ).toThrow(/section|source URL/i);
  });

  it("rejects text outside the configured 2000-3000 readable-character range", () => {
    const shortDigest = `${TITLE}\n一、今日技术社区热议\n二、科技圈核心新闻\n三、GitHub 今日发现\n四、今日深度阅读\n五、今日一句判断`;
    expect(() =>
      parseAndValidateDigest(
        JSON.stringify({ title: TITLE, date: DATE, digest: shortDigest, sourceUrls: urls }),
        { date: DATE, allowedUrls: urls },
      ),
    ).toThrow(/digest:too_small/i);
  });
});
