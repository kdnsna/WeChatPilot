import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";

import {
  CodexImageError,
  type GeneratedHeroArtifact,
} from "../../src/observer/codex-image.js";
import { loadEditorialConfig } from "../../src/observer/editorial-config.js";
import {
  inspectReportVisuals,
  prepareReportVisual,
} from "../../src/observer/report-visual.js";
import { attachIssue, buildRunReport } from "../../src/observer/run-report.js";
import { writeProjectBytesAtomic, writeProjectTextAtomic } from "../../src/lib/project-file.js";
import { validEditorialPayload } from "../helpers/editorial.js";

const RUN_ID = "018f514c-1a2b-7abc-8def-1234567890ac";
const ISSUE = { number: 7, label: "WP-000007" } as const;
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechat-visual-ledger-"));
  for (const relativePath of [
    "config/report-visual.yaml",
    "config/security-profile.yaml",
    "config/report-image-output.schema.json",
    "prompts/editorial-hero.md",
  ]) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(REPOSITORY_ROOT, relativePath)));
  }
  return root;
}

function report(root: string) {
  return attachIssue(
    buildRunReport({
      projectRoot: root,
      authority: {
        runId: RUN_ID,
        taskId: "daily-tech-digest",
        taskName: "Daily Tech Digest",
        projectLabel: "WeChatPilot",
        status: "success",
        startedAt: "2026-07-20T00:00:00.000Z",
        finishedAt: "2026-07-20T00:00:03.000Z",
      },
      draft: {
        version: 1,
        summary: ["今日技术情报生成成功"],
        metrics: [],
        failure: null,
        artifacts: [],
        editorial: validEditorialPayload(),
      },
    }),
    ISSUE,
  );
}

function png(width = 1_024, height = 1_024): Buffer {
  return Buffer.from(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#10233f"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

function generatedArtifact(root: string): GeneratedHeroArtifact {
  const pngPath = join(
    root,
    "output",
    "run-reports",
    "2026-07-20",
    `${RUN_ID}.hero.png`,
  );
  const bytes = png();
  writeProjectBytesAtomic(root, pngPath, bytes);
  return {
    pngPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    promptSha256: "b".repeat(64),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function reportSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function ledgerPath(root: string): string {
  return join(root, ".state", "observer", "visuals", `${RUN_ID}.json`);
}

describe("private report visual lifecycle", () => {
  it("persists each attempt, retries twice, and reuses the generated visual", async () => {
    const root = project();
    const artifact = generatedArtifact(root);
    const generateTwiceThenSucceed = vi
      .fn<() => Promise<GeneratedHeroArtifact>>()
      .mockRejectedValueOnce(new CodexImageError("failed"))
      .mockRejectedValueOnce(new CodexImageError("timeout"))
      .mockResolvedValue(artifact);
    const delays: number[] = [];

    const visual = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: generateTwiceThenSucceed,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(visual).toEqual({
      mode: "generated",
      attempts: 3,
      heroPath: artifact.pngPath,
      heroSha256: artifact.sha256,
      styleVersion: "editorial-v1",
      promptSha256: artifact.promptSha256,
    });
    expect(generateTwiceThenSucceed).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([5_000, 15_000]);

    const ledgerText = readFileSync(ledgerPath(root), "utf8");
    const ledger = JSON.parse(ledgerText) as Record<string, unknown>;
    expect(ledger).toMatchObject({
      status: "generated",
      attempts: 3,
      reportSha256: reportSha256(report(root)),
      heroSha256: artifact.sha256,
      heroPath: relative(root, artifact.pngPath),
    });
    expect(lstatSync(ledgerPath(root)).mode & 0o777).toBe(0o600);
    expect(ledgerText).not.toContain("Codex image generation failed");
    expect(ledgerText).not.toContain("<visual_brief>");

    const failIfCalled = vi.fn<() => Promise<GeneratedHeroArtifact>>(() => {
      throw new Error("generated visual must be reused");
    });
    const reused = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: failIfCalled,
      sleep: async () => undefined,
    });
    expect(reused).toEqual(visual);
    expect(failIfCalled).not.toHaveBeenCalled();
  });

  it("counts an interrupted generating attempt as consumed on recovery", async () => {
    const root = project();
    const aborting = vi.fn<() => Promise<GeneratedHeroArtifact>>(() => {
      throw new CodexImageError("aborted");
    });

    await expect(
      prepareReportVisual({
        projectRoot: root,
        report: report(root),
        issue: ISSUE,
        config: loadEditorialConfig(root),
        generate: aborting,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(JSON.parse(readFileSync(ledgerPath(root), "utf8"))).toMatchObject({
      status: "generating",
      attempts: 1,
    });

    const artifact = generatedArtifact(root);
    const recovered = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: async () => artifact,
      sleep: async () => undefined,
    });
    expect(recovered.attempts).toBe(2);
  });

  it("creates and reuses a deterministic fallback after three failures", async () => {
    const root = project();
    const failing = vi.fn<() => Promise<GeneratedHeroArtifact>>(() => {
      throw new CodexImageError("failed");
    });

    const fallback = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: failing,
      sleep: async () => undefined,
    });

    expect(fallback).toMatchObject({
      mode: "fallback",
      attempts: 3,
      styleVersion: "editorial-v1",
      heroSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(readFileSync(fallback.heroPath).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    const firstBytes = readFileSync(fallback.heroPath);

    const reused = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: async () => {
        throw new Error("fallback visual must be reused");
      },
      sleep: async () => undefined,
    });
    expect(reused).toEqual(fallback);
    expect(readFileSync(reused.heroPath)).toEqual(firstBytes);
    expect(readFileSync(ledgerPath(root), "utf8")).toContain(
      '"stableCode":"IMAGE_GENERATION_UNAVAILABLE"',
    );
  });

  it("falls back without a fourth call when recovery finds attempts exhausted", async () => {
    const root = project();
    let calls = 0;
    await expect(
      prepareReportVisual({
        projectRoot: root,
        report: report(root),
        issue: ISSUE,
        config: loadEditorialConfig(root),
        generate: async () => {
          calls += 1;
          if (calls < 3) {
            throw new CodexImageError("failed");
          }
          throw new CodexImageError("aborted");
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toBe(3);

    const mustNotRun = vi.fn<() => Promise<GeneratedHeroArtifact>>();
    const fallback = await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: mustNotRun,
      sleep: async () => undefined,
    });
    expect(fallback).toMatchObject({ mode: "fallback", attempts: 3 });
    expect(mustNotRun).not.toHaveBeenCalled();
  });
});

describe("visual state inspection", () => {
  it("returns counts only for pending, fallback, and invalid records", async () => {
    const root = project();
    const pendingRunId = "018f514c-1a2b-7abc-8def-1234567890ad";
    writeProjectTextAtomic(
      root,
      join(root, ".state", "observer", "visuals", `${pendingRunId}.json`),
      `${JSON.stringify({
        version: 1,
        status: "pending",
        runId: pendingRunId,
        issueNumber: 8,
        reportSha256: "a".repeat(64),
        attempts: 0,
      })}\n`,
    );
    await prepareReportVisual({
      projectRoot: root,
      report: report(root),
      issue: ISSUE,
      config: loadEditorialConfig(root),
      generate: async () => {
        throw new CodexImageError("failed");
      },
      sleep: async () => undefined,
    });
    writeProjectTextAtomic(
      root,
      join(root, ".state", "observer", "visuals", "invalid.json"),
      '{"runId":"must-not-be-returned","rawError":"secret"}\n',
    );

    const counts = inspectReportVisuals(root);
    expect(counts).toEqual({ pending: 1, fallback: 1, invalid: 1 });
    expect(Object.keys(counts)).toEqual(["pending", "fallback", "invalid"]);
    expect(JSON.stringify(counts)).not.toContain("must-not-be-returned");
  });
});
