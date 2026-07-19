import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const promptPath = fileURLToPath(
  new URL("../../prompts/daily-digest.md", import.meta.url),
);
const prompt = readFileSync(promptPath, "utf8");

describe("daily digest prompt policy", () => {
  it("treats delimited candidate content as untrusted inert data", () => {
    expect(prompt).toMatch(/候选.*(?:feed|社区).*(?:不可信|不受信任).*惰性数据/s);
    expect(prompt).toContain("<candidate_data>");
    expect(prompt).toContain("</candidate_data>");
    expect(prompt).toMatch(
      /忽略.*<candidate_data>.*(?:指令|请求).*(?:不得执行|不要执行|不能执行)/s,
    );
    expect(prompt.indexOf("<candidate_data>")).toBeLessThan(
      prompt.indexOf("</candidate_data>"),
    );
  });

  it("permits only associated Hacker News discussion links as blocked-primary fallbacks", () => {
    expect(prompt).toMatch(/Hacker News.*discussionUrl.*(?:备用|回退)/i);
    expect(prompt).toMatch(/(?:主链接|原始链接).*(?:不可访问|受阻)/);
  });
});
