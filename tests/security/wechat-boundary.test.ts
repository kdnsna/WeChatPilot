import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("one-way WeChat boundary", () => {
  it("does not import the upstream entrypoint, router, registry, or child processes", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/delivery/wechat.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/bridge\/router|adapters\/registry|dist\/index/u);
    expect(source).not.toMatch(/child_process|spawn\s*\(|exec\s*\(/u);
    expect(source).not.toMatch(/dangerously-bypass|remote.?control/iu);
  });

  it("keeps every WeChat state artifact ignored", () => {
    const ignore = readFileSync(`${root}/.gitignore`, "utf8");
    expect(ignore).toContain(".state/*");
    expect(ignore).toContain("**/context-token*");
    expect(ignore).toContain("**/wechat-credentials*");
  });
});
