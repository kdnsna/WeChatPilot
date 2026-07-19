import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectText,
  writeProjectTextAtomic,
} from "../../src/lib/project-file.js";

const roots: string[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "daily-tech-file-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project file persistence", () => {
  it("atomically writes and reads a private project-local file", () => {
    const project = root();
    const path = join(project, "data", "history", "items.json");

    writeProjectTextAtomic(project, path, "first");
    writeProjectTextAtomic(project, path, "second");

    expect(readProjectText(project, path, 100)).toBe("second");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(project, "data", "history")).mode & 0o777).toBe(0o700);
  });

  it("returns null for a missing file and rejects oversized reads", () => {
    const project = root();
    const path = join(project, "state.json");

    expect(readProjectText(project, path, 100)).toBeNull();
    writeProjectTextAtomic(project, path, "12345");
    expect(() => readProjectText(project, path, 4)).toThrow(/size limit/i);
  });

  it("rejects writes through a symlink and paths outside the project", () => {
    const project = root();
    const outside = root();
    mkdirSync(join(project, "data"));
    symlinkSync(outside, join(project, "data", "linked"));

    expect(() =>
      writeProjectTextAtomic(
        project,
        join(project, "data", "linked", "escape.json"),
        "blocked",
      ),
    ).toThrow(/symlink|outside/i);
    expect(() =>
      writeProjectTextAtomic(project, join(outside, "escape.json"), "blocked"),
    ).toThrow(/outside/i);
  });

  it("repairs permissive parent permissions on normal project directories", () => {
    const project = root();
    const parent = join(project, "output");
    mkdirSync(parent);
    chmodSync(parent, 0o755);

    writeProjectTextAtomic(project, join(parent, "digest.txt"), "digest");

    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });
});
