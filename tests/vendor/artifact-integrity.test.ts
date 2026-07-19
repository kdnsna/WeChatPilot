import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { verifyVendorWechatArtifacts } from "../../src/delivery/wechat.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
const artifacts = [
  "ilink/auth.js",
  "utils/http.js",
  "utils/logger.js",
  "utils/crypto.js",
] as const;

function fixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-vendor-integrity-"));
  roots.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "config", "vendor-wechat-artifacts.json"),
    join(root, "config", "vendor-wechat-artifacts.json"),
  );
  for (const artifact of artifacts) {
    const destination = join(root, "vendor", "cli-in-wechat", "dist", artifact);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      join(repositoryRoot, "vendor", "cli-in-wechat", "dist", artifact),
      destination,
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("reviewed WeChat runtime artifact closure", () => {
  it("accepts the Node 22 build of the exact pinned allowed modules", () => {
    expect(() => verifyVendorWechatArtifacts(repositoryRoot)).not.toThrow();
  });

  it("rejects a modified ignored dist artifact before dynamic import", () => {
    const root = fixtureProject();
    writeFileSync(
      join(root, "vendor", "cli-in-wechat", "dist", "ilink", "auth.js"),
      "export const login = async () => ({ compromised: true });\n",
      "utf8",
    );

    expect(() => verifyVendorWechatArtifacts(root)).toThrow(/integrity/i);
  });
});
