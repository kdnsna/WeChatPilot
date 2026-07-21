import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WECHAT_TRANSPORT_RUNTIME_CLOSURE } from "../../src/transport/wechat-transport.js";

const root = resolve(process.cwd());

describe("WeChat runtime closure", () => {
  it("contains no vulnerable or remote-control dependency", () => {
    const sources = [
      readFileSync(resolve(root, "src/delivery/wechat.ts"), "utf8"),
      readFileSync(resolve(root, "src/transport/wechat-transport.ts"), "utf8"),
    ].join("\n");
    expect(WECHAT_TRANSPORT_RUNTIME_CLOSURE).toEqual(["node:crypto", "globalThis.fetch"]);
    expect(sources).not.toMatch(/cli-in-wechat|undici|ProxyAgent|initProxyFromEnv|bridge\/router|adapters\/registry/iu);
  });

  it("keeps undici outside the installed production graph", () => {
    const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    expect(lock.packages).not.toHaveProperty("node_modules/undici");
  });
});
