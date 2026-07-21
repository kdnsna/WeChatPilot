import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  renderFixedEditorialPreview,
  runRenderRunReportPreviewCli,
} from "../../src/cli/render-run-report-preview.js";
import {
  FIXED_PREVIEW_RUN_ID,
} from "../../src/observer/fixed-editorial-report.js";

const ROOT = "/private/tmp/editorial-preview-test";

describe("fixed editorial report preview", () => {
  it("uses numbering, production visual preparation, and the editorial compositor without delivery", async () => {
    const calls: string[] = [];
    const issue = { number: 12, label: "WP-000012" };
    const result = await renderFixedEditorialPreview({
      projectRoot: ROOT,
      dependencies: {
        assignIssue: vi.fn(async () => {
          calls.push("assign");
          return issue;
        }),
        loadConfig: vi.fn(() => {
          calls.push("config");
          return { mode: "editorial" } as never;
        }),
        prepareVisual: vi.fn(async ({ report }) => {
          calls.push("visual");
          expect(report.issueLabel).toBe(issue.label);
          return {
            mode: "generated" as const,
            attempts: 1,
            heroPath: `${ROOT}/output/preview.hero.png`,
            heroSha256: "a".repeat(64),
            styleVersion: "editorial-v1" as const,
            promptSha256: "b".repeat(64),
          };
        }),
        render: vi.fn(({ report }) => {
          calls.push("render");
          return {
            pngPath: `${ROOT}/output/run-reports/2026-07-20/${report.runId}.png`,
            jsonPath: `${ROOT}/output/run-reports/2026-07-20/${report.runId}.json`,
            issueLabel: report.issueLabel!,
            visualMode: "generated" as const,
          };
        }),
      },
    });

    expect(calls).toEqual(["assign", "config", "visual", "render"]);
    expect(result.pngPath).toBe(
      `${ROOT}/output/run-reports/2026-07-20/${FIXED_PREVIEW_RUN_ID}.png`,
    );
  });

  it("prints only the stable rendered status and accepts no overrides", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const render = vi.fn(async () => ({
      pngPath: `${ROOT}/output/run-reports/2026-07-20/${FIXED_PREVIEW_RUN_ID}.png`,
      jsonPath: `${ROOT}/output/run-reports/2026-07-20/${FIXED_PREVIEW_RUN_ID}.json`,
      issueLabel: "WP-000012",
      visualMode: "generated" as const,
    }));
    await expect(
      runRenderRunReportPreviewCli(
        ["--project-root", ROOT],
        { stdout, stderr },
        { render },
      ),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      '{"ok":true,"status":"rendered"}\n',
    );
    expect(stderr).not.toHaveBeenCalled();

    for (const arguments_ of [
      ["--recipient", "owner"],
      ["--prompt", "PRIVATE_PROMPT"],
      ["--image", "/private/image.png"],
    ]) {
      stdout.mockClear();
      stderr.mockClear();
      render.mockClear();
      await expect(
        runRenderRunReportPreviewCli(arguments_, { stdout, stderr }, { render }),
      ).resolves.toBe(1);
      expect(render).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat().join("")).not.toContain(arguments_.at(-1));
    }
  });

  it("does not import or expose any WeChat sender", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src", "cli", "render-run-report-preview.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/delivery\/wechat|prepareWechat|sendWechat|deliverRunReport/u);
  });
});
