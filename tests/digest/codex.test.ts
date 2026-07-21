import { describe, expect, it } from "vitest";

import type { DigestConfig } from "../../src/config/schema.js";
import {
  buildCodexInvocation,
  safeCodexEnvironment,
} from "../../src/digest/codex.js";

const projectRoot = "/Users/example/project";
const codex: DigestConfig["codex"] = {
  version: "0.144.4",
  nodeExecutable: "/path/to/node",
  javascriptEntrypoint: "/path/to/codex.js",
  direct: false,
  globalArgs: [
    "--search",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    "{projectRoot}",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
  ],
  command: "exec",
  execArgs: [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--output-schema",
    "{projectRoot}/config/digest-output.schema.json",
    "-",
  ],
  stdinOnly: true,
  forbiddenArgs: [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--yolo",
    "--add-dir",
    "workspace-write",
    "danger-full-access",
    "--skip-git-repo-check",
  ],
};

describe("safe Codex invocation", () => {
  it("uses the absolute Node entrypoint and preserves argument ordering", () => {
    const invocation = buildCodexInvocation(codex, projectRoot, {
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin",
    });

    expect(invocation.executable).toBe(codex.nodeExecutable);
    expect(invocation.args[0]).toBe(codex.javascriptEntrypoint);
    expect(invocation.args).toEqual([
      codex.javascriptEntrypoint,
      "--search",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--cd",
      projectRoot,
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--output-schema",
      `${projectRoot}/config/digest-output.schema.json`,
      "-",
    ]);
    expect(invocation.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("preserves auth-location and network basics while removing unrelated secrets", () => {
    const input: NodeJS.ProcessEnv = {
      HOME: "/Users/example",
      CODEX_HOME: "/Users/example/.codex",
      PATH: "/usr/bin:/bin",
      LANG: "zh_CN.UTF-8",
      HTTPS_PROXY: "http://127.0.0.1:6152",
      GITHUB_TOKEN: "ghp_must_not_reach_codex",
      BOT_TOKEN: "must-not-reach-codex",
      OPENAI_API_KEY: "must-use-existing-chatgpt-login-instead",
    };

    const result = safeCodexEnvironment(input);

    expect(result).toMatchObject({
      HOME: input.HOME,
      CODEX_HOME: input.CODEX_HOME,
      PATH: input.PATH,
      LANG: input.LANG,
      HTTPS_PROXY: input.HTTPS_PROXY,
    });
    expect(result).not.toHaveProperty("GITHUB_TOKEN");
    expect(result).not.toHaveProperty("BOT_TOKEN");
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(input.GITHUB_TOKEN).toBe("ghp_must_not_reach_codex");
  });
});
