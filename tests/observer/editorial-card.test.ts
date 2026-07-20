import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";

import { pngDimensions } from "../../src/lib/png.js";
import { writeProjectBytesAtomic } from "../../src/lib/project-file.js";
import {
  buildEditorialCardSvg,
  renderEditorialReportCard,
} from "../../src/observer/editorial-card.js";
import type { PreparedReportVisual } from "../../src/observer/report-visual.js";
import { attachIssue, buildRunReport, type RunReport } from "../../src/observer/run-report.js";
import { buildStatusEditorialReport } from "../../src/report/editorial.js";
import { validEditorialPayload } from "../helpers/editorial.js";

const RUN_ID = "018f514c-1a2b-7abc-8def-1234567890ac";
const ISSUE = { number: 127, label: "WP-000127" } as const;

function project(): string {
  return mkdtempSync(join(tmpdir(), "wechat-editorial-card-"));
}

function hero(width = 1_024, height = 1_024): Buffer {
  return Buffer.from(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#173052"/><circle cx="70%" cy="50%" r="24%" fill="#d97941"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

function editorial(highlightCount = 5) {
  const base = validEditorialPayload();
  return {
    ...base,
    highlights: Array.from({ length: highlightCount }, (_, index) => ({
      ...base.highlights[0]!,
      title: `技术信号 ${index + 1}：Codex 自动化进展`,
      whyItMatters:
        `这是第 ${index + 1} 项经过核验的变化，它会影响本地自动化的稳定性、恢复边界和本周实施优先级。`,
      sourceCount: index % 3 === 0 ? 3 : 2,
      confidence: index % 3 === 0 ? "high" as const : "medium-high" as const,
    })),
  };
}

function report(
  status: RunReport["status"] = "success",
  highlightCount = 5,
): RunReport {
  const payload =
    status === "success"
      ? editorial(highlightCount)
      : buildStatusEditorialReport({
          reason: status === "interrupted" ? "interrupted" : "failed",
          date: "2026-07-20",
        });
  return attachIssue(
    buildRunReport({
      projectRoot: "/tmp/editorial-card-fixture",
      authority: {
        runId: RUN_ID,
        taskId: "daily-tech-digest",
        taskName: "每日技术情报",
        projectLabel: "WeChatPilot",
        status,
        startedAt: "2026-07-20T00:00:00.000Z",
        finishedAt: "2026-07-20T00:00:03.500Z",
      },
      draft: {
        version: 1,
        summary: [status === "success" ? "今日日报已生成并发送" : "本次任务未产生正常情报"],
        metrics: [
          { label: "日期", value: "2026-07-20" },
          { label: "消息分段", value: "3" },
        ],
        failure: status === "success" ? null : "运行状态需要值守员关注",
        artifacts: [],
        editorial: payload,
      },
    }),
    ISSUE,
  );
}

function preparedVisual(
  root: string,
  mode: "generated" | "fallback" = "generated",
): PreparedReportVisual {
  const bytes = mode === "generated" ? hero() : hero(1_080, 480);
  const heroPath = join(root, "output", "run-reports", "2026-07-20", `${RUN_ID}.hero.png`);
  mkdirSync(dirname(heroPath), { recursive: true });
  writeProjectBytesAtomic(root, heroPath, bytes);
  return {
    mode,
    attempts: mode === "generated" ? 1 : 3,
    heroPath,
    heroSha256: createHash("sha256").update(bytes).digest("hex"),
    styleVersion: "editorial-v1",
    ...(mode === "generated" ? { promptSha256: "b".repeat(64) } : {}),
  };
}

describe("fixed editorial card SVG", () => {
  it("uses five ordered zones with visible issue and signal numbering", () => {
    const value = report();
    const svg = buildEditorialCardSvg({
      report: value,
      heroPng: hero(),
      visualMode: "generated",
    });

    expect(svg).toContain('viewBox="0 0 1080 2400"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain("WP-000127");
    expect(svg).toContain("01");
    expect(svg).toContain("05");
    expect(svg).toContain(RUN_ID.slice(0, 8).toUpperCase());
    expect(svg).toContain("日报正文：确认成功");
    expect(svg).toContain("报告图：已生成");
    expect(svg).not.toContain("AI 主视觉暂不可用");
    const sections = ["今日结论", "TOP SIGNALS", "NEXT ACTIONS", "CODEX AUDIT"];
    expect(sections.map((section) => svg.indexOf(section))).toEqual(
      [...sections].map((section) => svg.indexOf(section)).sort((a, b) => a - b),
    );
  });

  it.each([
    ["low signal", "success" as const, 1, "LOW SIGNAL"],
    ["skipped", "skipped" as const, 0, "SKIPPED"],
    ["failed", "failed" as const, 0, "FAILED"],
    ["interrupted", "interrupted" as const, 0, "INTERRUPTED"],
  ])("renders an honest %s variant", (_case, status, count, marker) => {
    const svg = buildEditorialCardSvg({
      report: report(status, count),
      heroPng: hero(1_080, 480),
      visualMode: "fallback",
    });
    expect(svg).toContain(marker);
    expect(svg).toContain("AI 主视觉暂不可用");
    expect(svg).toContain("报告图：固定背景");
    if (status !== "success") {
      expect(svg).not.toContain("日报正文：确认成功");
      expect(svg).not.toContain("技术信号 1");
    }
  });

  it("allows one trusted embedded hero and neutralizes report-controlled resources", () => {
    const base = report();
    const hostile = {
      ...base,
      taskName:
        '@font-face <script href="https://evil.invalid">url(</script>\u202e',
      editorial: {
        ...base.editorial!,
        executiveSummary:
          '<script href="data:image/png;base64,ATTACK">https://evil.invalid url(</script>\u202e',
        highlights: base.editorial!.highlights.map((item) => ({
          ...item,
          title: '<script href="https://evil.invalid">url(</script>\u202e',
        })),
      },
    } as RunReport;
    const svg = buildEditorialCardSvg({
      report: hostile,
      heroPng: hero(),
      visualMode: "generated",
    });

    expect(svg.match(/data:image\/png;base64,/gu)).toHaveLength(1);
    expect(svg.match(/\shref=/gu)).toHaveLength(1);
    expect(svg).not.toMatch(/<script|https:\/\/evil\.invalid|url\(|@font-face/iu);
    expect(svg).not.toContain("\u202e");
  });
});

describe("editorial card artifact", () => {
  it.each(["generated", "fallback"] as const)(
    "renders and reuses a private 1080x2400 %s card",
    (mode) => {
      const root = project();
      const value = report();
      const visual = preparedVisual(root, mode);
      const artifact = renderEditorialReportCard({
        projectRoot: root,
        report: value,
        visual,
      });
      const png = readFileSync(artifact.pngPath);

      expect(pngDimensions(png)).toEqual({ width: 1_080, height: 2_400 });
      expect(png.byteLength).toBeLessThanOrEqual(5 * 1_024 * 1_024);
      expect(statSync(artifact.pngPath).mode & 0o777).toBe(0o600);
      expect(statSync(artifact.jsonPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(artifact.jsonPath, "utf8"))).toEqual(value);
      expect(artifact).toMatchObject({ issueLabel: ISSUE.label, visualMode: mode });
      expect(renderEditorialReportCard({ projectRoot: root, report: value, visual })).toEqual(
        artifact,
      );
    },
    30_000,
  );
});
