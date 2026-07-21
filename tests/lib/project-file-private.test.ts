import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readPrivateProjectText,
  readPublicProjectText,
  writeProjectTextAtomic,
} from "../../src/lib/project-file.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-private-read-"));
  roots.push(root);
  return root;
}

describe("public vs private project text reads", () => {
  it("allows public text under ordinary project files", () => {
    const root = project();
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "daily-digest.md"), "hello", "utf8");
    expect(readPublicProjectText(root, join(root, "prompts", "daily-digest.md"), 100)).toBe("hello");
  });

  it("requires private state permissions for private text", () => {
    const root = project();
    const parent = join(root, ".state");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    const path = join(parent, "secret.json");
    writeProjectTextAtomic(root, path, '{"ok":true}\n');
    expect(readPrivateProjectText(root, path, 100)).toBe('{"ok":true}\n');

    chmodSync(path, 0o644);
    expect(() => readPrivateProjectText(root, path, 100)).toThrow(/private regular file/i);
  });
});
