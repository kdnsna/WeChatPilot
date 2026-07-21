import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertProjectPath,
  createProjectPaths,
  resolveProjectPath,
} from "../../src/lib/paths.js";

const temporaryRoots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-digest-paths-"));
  temporaryRoots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return project;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("project paths", () => {
  it("resolves a relative path inside the project root", () => {
    const root = projectRoot();
    expect(resolveProjectPath(root, "data", "raw", "items.json")).toBe(
      resolve(root, "data/raw/items.json"),
    );
  });

  it.each([
    ["parent traversal", ["..", "outside.json"]],
    ["nested traversal", ["data", "..", "..", "outside.json"]],
    ["absolute outside path", [resolve("/tmp", "outside.json")]],
  ])("rejects %s", (_label, segments) => {
    const root = projectRoot();
    expect(() => resolveProjectPath(root, ...segments)).toThrow(
      /outside project root|traversal|absolute/i,
    );
  });

  it("does not confuse a sibling with a matching path prefix for a child", () => {
    const root = projectRoot();
    expect(() =>
      assertProjectPath(root, `${root}-backup/items.json`),
    ).toThrow(/outside project root/i);
  });

  it("rejects an existing project-local symlink that escapes the project", () => {
    const root = projectRoot();
    const outside = join(resolve(root, ".."), "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));

    expect(() => resolveProjectPath(root, "linked", "escape.json")).toThrow(
      /outside project root|symlink/i,
    );
  });

  it("builds the complete project directory map", () => {
    const root = projectRoot();
    expect(createProjectPaths(root)).toEqual({
      root,
      appRoot: root,
      workspaceRoot: root,
      stateRoot: resolve(root, ".state"),
      config: resolve(root, "config"),
      data: resolve(root, "data"),
      raw: resolve(root, "data/raw"),
      history: resolve(root, "data/history"),
      output: resolve(root, "output"),
      logs: resolve(root, "logs"),
      state: resolve(root, ".state"),
    });
  });
});
