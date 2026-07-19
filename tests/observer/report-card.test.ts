import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Resvg } from "@resvg/resvg-js";

import type { RunReport } from "../../src/observer/run-report.js";
import {
  buildReportCardSvg,
  renderReportCard,
} from "../../src/observer/report-card.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-report-card-"));
  roots.push(root);
  return root;
}

function report(
  status: RunReport["status"] = "success",
  finishedAt = "2026-07-18T16:30:00.000Z",
): RunReport {
  const startedAt = "2026-07-18T16:29:58.500Z";
  return {
    version: 1,
    runId: "018f47a8-72df-7d5e-8c1f-96eacc20f2c3",
    taskId: "daily-digest",
    taskName: "每日技术情报",
    projectLabel: "WeChatPilot",
    status,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    summary: ["已完成候选源收集", "报告已写入私有目录"],
    metrics: [
      { label: "候选条目", value: "42" },
      { label: "入选条目", value: "10" },
    ],
    failure: status === "success" ? null : "本次运行未完成",
    artifacts: ["output/2026-07-19-digest.md"],
  };
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("report card SVG", () => {
  it("uses a fixed canvas and the required status colors", () => {
    const colors: Record<RunReport["status"], string> = {
      success: "#15803d",
      failed: "#b91c1c",
      "timed-out": "#b91c1c",
      cancelled: "#c2410c",
      interrupted: "#c2410c",
      skipped: "#64748b",
    };

    for (const [status, color] of Object.entries(colors)) {
      const svg = buildReportCardSvg(report(status as RunReport["status"]));
      expect(svg).toContain('viewBox="0 0 1080 1440"');
      expect(svg).toContain(`fill="${color}"`);
      expect(svg.match(/font-family=/gu)).toHaveLength(1);
      expect(svg).toContain('font-family="PingFang SC"');
    }
  });

  it("keeps hostile dynamic fields in escaped text nodes without resource hooks", () => {
    const hostile = {
      ...report("failed"),
      taskName: '<script href=data:text/javascript>\u202eevil</script>',
      projectLabel: "A & B href=https://evil.invalid",
      summary: ['<script>alert(1)</script> & href=data:image/png;base64,AA\u202e'],
      metrics: [
        {
          label: "href=",
          value: "data: https://evil.invalid/x?a=1&b=2\u202e",
        },
      ],
      failure: '<script src=https://evil.invalid/x></script>',
      artifacts: ["href=data:evil"],
    } as RunReport;

    const svg = buildReportCardSvg(hostile);

    expect(svg).toContain("&lt;script");
    expect(svg).toContain("&amp;");
    expect(svg).not.toMatch(/<script/iu);
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("data:");
    expect(svg).not.toContain("\u202e");
    expect(svg).not.toContain("https://evil.invalid");
    expect(svg).not.toMatch(/@font-face|url\(|<(?:image|use)\b/iu);
  });
});

describe("renderReportCard", () => {
  it("renders a real private 1080x1440 PNG and exact JSON report", () => {
    const root = projectRoot();
    const value = report();

    const artifact = renderReportCard({ projectRoot: root, report: value });
    const png = readFileSync(artifact.pngPath);
    const jsonText = readFileSync(artifact.jsonPath, "utf8");

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1440);
    expect(statSync(artifact.pngPath).mode & 0o777).toBe(0o600);
    expect(statSync(artifact.jsonPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(jsonText)).toEqual(value);
    expect(jsonText.endsWith("\n")).toBe(true);
    expect(artifact.pngPath).toBe(
      join(
        root,
        "output",
        "run-reports",
        "2026-07-19",
        `${value.runId}.png`,
      ),
    );
    expect(artifact.jsonPath).toBe(
      join(
        root,
        "output",
        "run-reports",
        "2026-07-19",
        `${value.runId}.json`,
      ),
    );
  });

  it("is deterministic for the same report in SVG, PNG, and JSON bytes", () => {
    const value = report();
    const first = renderReportCard({ projectRoot: projectRoot(), report: value });
    const second = renderReportCard({ projectRoot: projectRoot(), report: value });

    expect(buildReportCardSvg(value)).toBe(buildReportCardSvg(value));
    expect(readFileSync(first.pngPath)).toEqual(readFileSync(second.pngPath));
    expect(readFileSync(first.jsonPath)).toEqual(readFileSync(second.jsonPath));
  });

  it("derives the report directory from the finished time in Asia/Shanghai", () => {
    const root = projectRoot();
    const value = report("success", "2026-07-19T15:59:59.999Z");
    const artifact = renderReportCard({ projectRoot: root, report: value });

    expect(artifact.pngPath).toContain("/2026-07-19/");

    const next = report("success", "2026-07-19T16:00:00.000Z");
    const nextArtifact = renderReportCard({ projectRoot: root, report: next });
    expect(nextArtifact.pngPath).toContain("/2026-07-20/");
  });

  it.each([
    ["invalid signature", Buffer.alloc(24)],
    ["invalid IHDR dimensions", pngHeader(1080, 1439)],
    ["oversized output", Buffer.alloc(5 * 1_024 * 1_024 + 1)],
  ])("rejects %s with one fixed safe error before writing", (_case, bytes) => {
    vi.spyOn(Resvg.prototype, "render").mockReturnValue({
      asPng: () => bytes,
      width: 1080,
      height: 1440,
      pixels: Buffer.alloc(0),
    });
    const root = projectRoot();
    const privateMarker = "PRIVATE_REPORT_CARD_SENTINEL";
    const invalid = {
      ...report(),
      summary: [privateMarker],
    };

    expect(() => renderReportCard({ projectRoot: root, report: invalid })).toThrow(
      /^Unable to render report card$/,
    );
    expect(() => renderReportCard({ projectRoot: root, report: invalid })).not.toThrow(
      privateMarker,
    );
    expect(() => statSync(join(root, "output"))).toThrow();
  });

  it("validates the report before rendering or creating output", () => {
    const render = vi.spyOn(Resvg.prototype, "render");
    const root = projectRoot();
    const privateMarker = "PRIVATE_INVALID_REPORT_SENTINEL";
    const invalid = {
      ...report(),
      taskName: privateMarker,
      durationMs: 0,
    } as RunReport;

    expect(() => renderReportCard({ projectRoot: root, report: invalid })).toThrow(
      /^Unable to render report card$/,
    );
    expect(render).not.toHaveBeenCalled();
    expect(() => statSync(join(root, "output"))).toThrow();
  });
});
