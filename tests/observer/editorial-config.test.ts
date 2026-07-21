import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildEditorialImageInvocation,
  loadEditorialConfig,
} from "../../src/observer/editorial-config.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-editorial-config-"));
  const configDirectory = join(root, "config");
  mkdirSync(configDirectory);
  for (const name of [
    "report-visual.yaml",
    "report-image-output.schema.json",
    "security-profile.yaml",
  ]) {
    copyFileSync(
      join(projectRoot, "config", name),
      join(configDirectory, name),
    );
  }
  temporaryRoots.push(root);
  return root;
}

function mutateConfig(needle: string, replacement: string): string {
  const root = fixtureRoot();
  const path = join(
    root,
    "config",
    needle.startsWith("mode:") ? "report-visual.yaml" : "security-profile.yaml",
  );
  const original = readFileSync(path, "utf8");
  expect(original).toContain(needle);
  const index = original.lastIndexOf(needle);
  writeFileSync(
    path,
    `${original.slice(0, index)}${replacement}${original.slice(index + needle.length)}`,
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("editorial image configuration", () => {
  it("loads one exact image-only Codex profile", () => {
    const config = loadEditorialConfig(projectRoot);
    expect(config.mode).toBe("editorial");
    expect(config.canvas).toEqual({
      width: 1080,
      height: 2400,
      maximumBytes: 5_242_880,
    });
    expect(config.generation).toEqual({
      maximumAttempts: 3,
      timeoutMs: 180_000,
    });
    expect(config.style).toEqual({
      version: "editorial-v1",
      heroHeight: 480,
    });

    const invocation = buildEditorialImageInvocation(config, projectRoot, {
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "must-not-reach-child",
    });
    expect(invocation.cwd).toBe(projectRoot);
    expect(invocation.executable).toBe(config.codex.javascriptEntrypoint);
    expect(config.codex.direct).toBe(true);
    expect(invocation.args).toContain("image_generation");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).not.toContain("danger-full-access");
    expect(invocation.args).not.toContain("--add-dir");
    expect(invocation.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it.each([
    ["    - read-only\n", "    - workspace-write\n"],
    ["    - image_generation\n", "    - shell_tool\n"],
    [
      "    - \"{projectRoot}/config/report-image-output.schema.json\"\n",
      "    - \"{projectRoot}/config/other.schema.json\"\n",
    ],
    ["mode: editorial\n", "mode: another-profile\n"],
  ])("rejects a mutated image profile", (needle, replacement) => {
    const root = mutateConfig(needle, replacement);
    expect(() => loadEditorialConfig(root)).toThrowError(
      "Invalid editorial report configuration",
    );
  });

  it("rejects adding a sandbox bypass without echoing it", () => {
    const secretLikeValue = "--dangerously-bypass-approvals-and-sandbox";
    const root = mutateConfig(
      "  command: exec\n",
      `    - ${secretLikeValue}\n  command: exec\n`,
    );

    let message = "";
    try {
      loadEditorialConfig(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Invalid editorial report configuration");
    expect(message).not.toContain(secretLikeValue);
  });
});
