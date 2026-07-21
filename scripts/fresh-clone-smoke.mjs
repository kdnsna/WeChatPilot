import { mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = process.cwd();
const root = mkdtempSync(join(tmpdir(), "wechatpilot-fresh-"));
try {
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "src",
    "config",
    "prompts",
    "scripts",
    "tests",
    "security",
    "docs",
    "launchd",
    "AGENTS.md",
    "README.md",
  ]) {
    if (existsSync(join(source, name))) {
      cpSync(join(source, name), join(root, name), { recursive: true });
    }
  }
  const install = spawnSync("npm", ["ci"], { cwd: root, encoding: "utf8" });
  if (install.status !== 0) {
    console.error(install.stdout, install.stderr);
    process.exit(install.status ?? 1);
  }
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    process.exit(build.status ?? 1);
  }
  console.log("fresh-clone smoke ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
