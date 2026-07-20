import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeReportImage,
  runProbeReportImageCli,
} from "../../src/cli/probe-report-image.js";
import { writeProjectBytesAtomic } from "../../src/lib/project-file.js";

const RUN_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-07-20T02:00:00.000Z");
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "report-image-probe-"));
  roots.push(root);
  return root;
}

function png(): Buffer {
  return Buffer.from(
    new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#10233f"/></svg>',
    )
      .render()
      .asPng(),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("report image capability probe", () => {
  it("writes a minimal private marker and removes only the verified copied hero", async () => {
    const root = project();
    const heroPath = join(
      root,
      "output",
      "run-reports",
      "2026-07-20",
      `${RUN_ID}.hero.png`,
    );
    const bytes = png();
    const hash = createHash("sha256").update(bytes).digest("hex");

    await probeReportImage({
      projectRoot: root,
      dependencies: {
        now: () => NOW,
        createRunId: () => RUN_ID,
        loadConfig: () => ({
          codex: { version: "0.144.4" },
          style: { version: "editorial-v1" },
        }) as never,
        generate: async () => {
          writeProjectBytesAtomic(root, heroPath, bytes);
          return {
            pngPath: heroPath,
            sha256: hash,
            promptSha256: "b".repeat(64),
          };
        },
      },
    });

    expect(existsSync(heroPath)).toBe(false);
    const markerPath = join(
      root,
      ".state",
      "observer",
      "report-image-capability.json",
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as object;
    expect(marker).toEqual({
      codexVersion: "0.144.4",
      styleVersion: "editorial-v1",
      succeededAt: NOW.toISOString(),
      artifactSha256: hash,
    });
    expect(Object.keys(marker)).toHaveLength(4);
  });

  it("prints only stable JSON and rejects every override", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const probe = vi.fn(async () => undefined);
    await expect(
      runProbeReportImageCli([], { stdout, stderr }, { probe }),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith('{"ok":true,"status":"ready"}\n');
    expect(stderr).not.toHaveBeenCalled();

    for (const arguments_ of [
      ["--prompt", "PRIVATE_PROMPT"],
      ["--model", "gpt-image-2"],
      ["--path", "/private/hero.png"],
      ["--project-root", "relative"],
    ]) {
      stdout.mockClear();
      stderr.mockClear();
      probe.mockClear();
      await expect(
        runProbeReportImageCli(arguments_, { stdout, stderr }, { probe }),
      ).resolves.toBe(1);
      expect(probe).not.toHaveBeenCalled();
      const output = stderr.mock.calls.flat().join("");
      expect(output).toBe(
        '{"error":"ProbeReportImageUsageError","message":"inspect project logs"}\n',
      );
      expect(output).not.toContain(arguments_.at(-1));
    }
  });
});
