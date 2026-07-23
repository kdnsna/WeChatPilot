import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runWechatPilot } from "../../src/cli/wechatpilot.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("wechatpilot demo", () => {
  it("generates offline sample artifacts without private state", async () => {
    const root = mkdtempSync(join(tmpdir(), "wechatpilot-demo-"));
    temporaryRoots.push(root);

    const result = await runWechatPilot(["demo", "--project-root", root]);
    const record = result as {
      ok: boolean;
      status: string;
      format: string;
      text: string;
      digestPath: string;
      imagePath: string;
    };

    expect(record.ok).toBe(true);
    expect(record.status).toBe("demo-ready");
    expect(record.format).toBe("human");
    expect(record.text).toContain("does not access WeChat");
    expect(record.text).toContain("Safe next steps");
    expect(readFileSync(record.digestPath, "utf8")).toContain("Public Preview Demo");
    expect(readFileSync(record.imagePath).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
