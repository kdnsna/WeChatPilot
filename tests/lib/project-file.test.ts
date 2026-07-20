import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectBytes,
  readProjectText,
  writeProjectBytesAtomic,
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
  it("atomically writes private binary project files", () => {
    const project = root();
    const path = join(project, "private", "image.png");
    const content = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    writeProjectBytesAtomic(project, path, content);
    writeProjectBytesAtomic(
      project,
      path,
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    );

    expect(readFileSync(path)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(project, "private")).mode & 0o777).toBe(0o700);
  });

  it("does not follow binary target or parent symlinks", () => {
    const project = root();
    const outside = root();
    const outsideTarget = join(outside, "outside.png");
    writeFileSync(outsideTarget, "unchanged", { mode: 0o600 });

    mkdirSync(join(project, "private"));
    symlinkSync(outsideTarget, join(project, "private", "target.png"));
    symlinkSync(outside, join(project, "linked"));

    expect(() =>
      writeProjectBytesAtomic(
        project,
        join(project, "private", "target.png"),
        Uint8Array.from([1]),
      ),
    ).toThrow(/symlink|outside/i);
    expect(() =>
      writeProjectBytesAtomic(
        project,
        join(project, "linked", "child.png"),
        Uint8Array.from([2]),
      ),
    ).toThrow(/symlink|outside/i);
    expect(readFileSync(outsideTarget, "utf8")).toBe("unchanged");
  });

  it("cleans its unique temporary file when an atomic rename fails", () => {
    const project = root();
    const parent = join(project, "private");
    const target = join(parent, "image.png");
    mkdirSync(target, { recursive: true });

    expect(() =>
      writeProjectBytesAtomic(project, target, Uint8Array.from([1, 2, 3])),
    ).toThrow();

    expect(readdirSync(parent)).toEqual(["image.png"]);
  });

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

  it("reads bounded private regular bytes and rejects unsafe identity or permissions", () => {
    const project = root();
    const parent = join(project, "private");
    const path = join(parent, "image.png");
    const content = Buffer.from([1, 2, 3, 4]);
    writeProjectBytesAtomic(project, path, content);

    expect(readProjectBytes(project, path, 4)).toEqual(content);
    expect(() => readProjectBytes(project, path, 3)).toThrow(/size limit/i);
    chmodSync(path, 0o640);
    expect(() => readProjectBytes(project, path, 4)).toThrow(/private regular file/i);
  });

  it("never follows a symlink while reading private project bytes", () => {
    const project = root();
    const outside = root();
    const parent = join(project, "private");
    const outsidePath = join(outside, "outside.bin");
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(outsidePath, Buffer.from("unchanged"), { mode: 0o600 });
    symlinkSync(outsidePath, join(parent, "linked.bin"));

    expect(() =>
      readProjectBytes(project, join(parent, "linked.bin"), 100),
    ).toThrow(/symlink|private regular file/i);
    expect(readFileSync(outsidePath, "utf8")).toBe("unchanged");
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
