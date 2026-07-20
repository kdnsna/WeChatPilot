import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

it("applies the reviewed QR long-poll timeout patch after every vendor build", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    readonly scripts: Record<string, string>;
  };
  const upstreamSource = read("vendor/cli-in-wechat/src/ilink/auth.ts");
  const runtimeSource = read("vendor/cli-in-wechat/dist/ilink/auth.js");
  const patch = read("patches/cli-in-wechat-qr-status-timeout.patch");

  expect(packageJson.scripts["vendor:build"]).toContain("npm run vendor:patch");
  expect(upstreamSource).toContain("timeoutMs: 15_000");
  expect(runtimeSource).toContain("timeoutMs: 45_000");
  expect(runtimeSource).not.toContain("timeoutMs: 15_000");
  expect(patch).toContain("-    const res = await fetchWithRetry");
  expect(patch).toContain("+    const res = await fetchWithRetry");
  expect(patch).toContain("timeoutMs: 45_000");
});
