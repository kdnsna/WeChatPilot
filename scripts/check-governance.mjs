import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const required = [
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
  "PRIVACY.md",
  "DATA_FLOW.md",
  "THREAT_MODEL.md",
  "COMPATIBILITY.md",
  "docs/security/runtime-closure.md",
  "security/openvex.json",
];

const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(`missing governance files:\n${missing.join("\n")}`);
  process.exit(1);
}

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
  console.error(`tracked gitlinks are not allowed in the release archive:\n${gitlinks.join("\n")}`);
  process.exit(1);
}

console.log("governance files present");
