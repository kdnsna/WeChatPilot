import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "wechatpilot-fresh-"));
try {
  const trackedFiles = spawnSync("git", ["ls-files", "--stage"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (trackedFiles.status !== 0) {
    console.error(trackedFiles.stderr);
    process.exit(trackedFiles.status ?? 1);
  }
  const gitlinks = trackedFiles.stdout
    .split("\n")
    .filter((line) => line.startsWith("160000 "));
  if (gitlinks.length > 0) {
    console.error(`fresh-clone archive contains unsupported gitlinks:\n${gitlinks.join("\n")}`);
    process.exit(1);
  }

  const archive = spawnSync("git", ["archive", "HEAD"], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    console.error(archive.stderr?.toString("utf8"));
    process.exit(archive.status ?? 1);
  }
  const extract = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout, encoding: "utf8" });
  if (extract.status !== 0) process.exit(extract.status ?? 1);
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
