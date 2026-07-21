import { existsSync } from "node:fs";

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

console.log("governance files present");
