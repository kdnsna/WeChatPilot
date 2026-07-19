import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const EXPECTED_REPOSITORY = "https://github.com/sgaofen/cli-in-wechat";
const EXPECTED_COMMIT = "75d7db9338e133080fef9914b92ceb5e3ebd0dfc";
const SUBMODULE_PATH = "vendor/cli-in-wechat";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const submoduleRoot = resolve(repositoryRoot, SUBMODULE_PATH);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function normalizedRepository(url: string): string {
  return url.replace(/\.git$/, "");
}

it("pins cli-in-wechat as a detached submodule at the reviewed upstream commit", () => {
  expect(
    existsSync(submoduleRoot),
    `${SUBMODULE_PATH} must be initialized before the upstream pin can be verified`,
  ).toBe(true);

  expect(git(submoduleRoot, "rev-parse", "--is-inside-work-tree")).toBe("true");
  expect(realpathSync(git(submoduleRoot, "rev-parse", "--show-toplevel"))).toBe(
    realpathSync(submoduleRoot),
  );
  expect(normalizedRepository(git(submoduleRoot, "remote", "get-url", "origin"))).toBe(
    EXPECTED_REPOSITORY,
  );
  expect(git(submoduleRoot, "rev-parse", "HEAD")).toBe(EXPECTED_COMMIT);

  expect(
    git(repositoryRoot, "config", "--file", ".gitmodules", "--get", `submodule.${SUBMODULE_PATH}.path`),
  ).toBe(SUBMODULE_PATH);
  expect(
    normalizedRepository(
      git(repositoryRoot, "config", "--file", ".gitmodules", "--get", `submodule.${SUBMODULE_PATH}.url`),
    ),
  ).toBe(EXPECTED_REPOSITORY);

  const configuredBranch = spawnSync(
    "git",
    ["config", "--file", ".gitmodules", "--get", `submodule.${SUBMODULE_PATH}.branch`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(configuredBranch.status).toBe(1);
  expect(configuredBranch.stdout).toBe("");

  const localBranchOverride = spawnSync(
    "git",
    ["config", "--local", "--get", `submodule.${SUBMODULE_PATH}.branch`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(localBranchOverride.status).toBe(1);
  expect(localBranchOverride.stdout).toBe("");

  const symbolicHead = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: submoduleRoot,
    encoding: "utf8",
  });
  expect(symbolicHead.status).toBe(1);
  expect(symbolicHead.stdout).toBe("");

  expect(git(repositoryRoot, "ls-files", "--stage", "--", SUBMODULE_PATH)).toBe(
    `160000 ${EXPECTED_COMMIT} 0\t${SUBMODULE_PATH}`,
  );
});
