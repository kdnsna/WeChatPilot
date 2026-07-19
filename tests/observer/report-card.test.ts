import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Resvg } from "@resvg/resvg-js";

import * as projectFile from "../../src/lib/project-file.js";
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return chunk;
}

function structurallyCompletePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1080, 0);
  ihdr.writeUInt32BE(1440, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT"),
    pngChunk("IEND"),
  ]);
}

function expectedPaths(root: string, value: RunReport) {
  const directory = join(root, "output", "run-reports", "2026-07-19");
  return {
    directory,
    pngPath: join(directory, `${value.runId}.png`),
    jsonPath: join(directory, `${value.runId}.json`),
  };
}

function svgTextEntries(svg: string): readonly { y: number; text: string }[] {
  return [...svg.matchAll(/<text\b[^>]*\by="(\d+)"[^>]*>(.*?)<\/text>/gu)].map(
    (match) => ({ y: Number(match[1]), text: match[2] ?? "" }),
  );
}

function expectNoDynamicInkPastContentEdge(
  svg: string,
  verticalBands: readonly (readonly [number, number])[],
): void {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "PingFang SC",
    },
  }).render();
  expect(image.asPng().subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const pixels = image.pixels;
  const unexpectedInk: Array<{
    readonly x: number;
    readonly y: number;
    readonly rgba: readonly number[];
  }> = [];
  for (const [top, bottom] of verticalBands) {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = 1017; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        const rgba = [...pixels.subarray(offset, offset + 4)];
        if (rgba.join(",") !== "241,245,249,255") {
          unexpectedInk.push({ x, y, rgba });
          if (unexpectedInk.length === 5) {
            expect(unexpectedInk).toEqual([]);
          }
        }
      }
    }
  }
  expect(unexpectedInk).toEqual([]);
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

  it("uses fixed non-overlapping regions for the maximum business display", () => {
    const value = {
      ...report("failed"),
      summary: [
        `S1-${"长摘要".repeat(30)}`,
        `S2-${"长摘要".repeat(30)}`,
        `S3-${"长摘要".repeat(30)}`,
        "S4-MUST-BE-OMITTED",
      ],
      metrics: Array.from({ length: 7 }, (_, index) => ({
        label: `M${index + 1}`,
        value: `V${index + 1}`,
      })),
      failure: "FAILURE-DETAIL",
    } as RunReport;

    const svg = buildReportCardSvg(value);
    const entries = svgTextEntries(svg);
    const summary = entries.filter((entry) => entry.text.startsWith("• "));
    const metrics = entries.filter((entry) => /^M[1-6]$/u.test(entry.text));
    const failure = entries.find((entry) => entry.text === "FAILURE-DETAIL");
    const footer = entries.filter((entry) =>
      /^(?:Run |Duration )/u.test(entry.text),
    );

    expect(summary).toHaveLength(6);
    expect(summary.every(({ y }) => y >= 474 && y <= 676)).toBe(true);
    expect(metrics).toHaveLength(6);
    expect(metrics.every(({ y }) => y >= 832 && y <= 1122)).toBe(true);
    expect(failure?.y).toBe(1230);
    expect(footer.map(({ y }) => y)).toEqual([1312, 1348]);
    expect(entries.every(({ y }) => y > 0 && y < 1440)).toBe(true);
    expect(Math.max(...summary.map(({ y }) => y))).toBeLessThan(
      Math.min(...metrics.map(({ y }) => y)),
    );
    expect(Math.max(...metrics.map(({ y }) => y))).toBeLessThan(failure?.y ?? 0);
    expect(failure?.y).toBeLessThan(Math.min(...footer.map(({ y }) => y)));
    expect(svg).toContain("1 more summary item omitted");
    expect(svg).toContain("1 more metric omitted");
    expect(svg).not.toContain("S4-MUST-BE-OMITTED");
    expect(svg).not.toContain("M7");
    expect(svg).not.toContain("V7");
  });

  it("removes XML 1.0 forbidden code points while preserving Chinese and emoji", () => {
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdc00);
    const forbidden = `中文😀\u0001\ufffe\uffff${loneHighSurrogate}X${loneLowSurrogate}`;
    const svg = buildReportCardSvg({
      ...report(),
      summary: [forbidden],
    });

    expect(svg).toContain("中文😀");
    expect(svg).not.toContain("\u0001");
    expect(svg).not.toContain("\ufffe");
    expect(svg).not.toContain("\uffff");
    expect(svg).not.toContain(loneHighSurrogate);
    expect(svg).not.toContain(loneLowSurrogate);
  });

  it("fits mixed-width dynamic text inside the content pixel boundary", () => {
    const mixed = "中😀Ab";
    const value = {
      ...report("failed", "9999-12-30T15:59:59.000Z"),
      startedAt: "2000-01-01T00:00:00.000Z",
      durationMs:
        Date.parse("9999-12-30T15:59:59.000Z") -
        Date.parse("2000-01-01T00:00:00.000Z"),
      projectLabel: `PROJECT-${mixed.repeat(20)}`,
      taskName: `TASK-${mixed.repeat(45)}`,
      summary: [`SUMMARY-${"中".repeat(70)}-${mixed.repeat(60)}`],
      metrics: [
        {
          label: `LABEL-${mixed.repeat(30)}`,
          value: `VALUE-${mixed.repeat(100)}`,
        },
      ],
      failure: `FAILURE-${mixed.repeat(200)}`,
      artifacts: Array.from(
        { length: 32 },
        (_, index) => `output/artifact-${index}.md`,
      ),
    } as RunReport;

    const svg = buildReportCardSvg(value);
    const entries = svgTextEntries(svg);
    const dynamic = (prefix: string) =>
      entries.filter(({ text }) => text.startsWith(prefix));

    expect(dynamic("PROJECT-")).toHaveLength(1);
    expect(dynamic("PROJECT-")[0]?.text).toMatch(/…$/u);
    expect(dynamic("TASK-")).toHaveLength(1);
    expect(dynamic("TASK-")[0]?.text).toMatch(/…$/u);
    expect(dynamic("• SUMMARY-")).toHaveLength(1);
    expect(entries.filter(({ text }) => text.startsWith("• "))).toHaveLength(2);
    expect(entries.filter(({ text }) => text.startsWith("• "))[1]?.text).toMatch(
      /…$/u,
    );
    expect(dynamic("LABEL-")[0]?.text).toMatch(/…$/u);
    expect(dynamic("VALUE-")[0]?.text).toMatch(/…$/u);
    expect(dynamic("FAILURE-")[0]?.text).toMatch(/…$/u);
    expect(dynamic("Run ")).toHaveLength(1);
    expect(dynamic("Duration ")).toHaveLength(1);
    expect(svg).not.toContain(value.projectLabel);
    expect(svg).not.toContain(value.taskName);
    expect(svg).not.toContain(value.summary[0]);
    expect(svg).not.toContain(value.metrics[0]?.label);
    expect(svg).not.toContain(value.metrics[0]?.value);
    expect(svg).not.toContain(value.failure ?? "");

    expectNoDynamicInkPastContentEdge(svg, [
      [104, 148],
      [160, 232],
      [265, 315],
      [452, 714],
      [800, 1160],
      [1170, 1240],
      [1280, 1360],
    ]);
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
    ["truncated after IHDR", pngHeader(1080, 1440)],
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

  it.each([
    ["truncated final chunk", structurallyCompletePng().subarray(0, -2)],
    ["trailing bytes after IEND", Buffer.concat([structurallyCompletePng(), Buffer.from([0])])],
    ["missing IEND", structurallyCompletePng().subarray(0, -12)],
    [
      "non-empty IEND",
      Buffer.concat([
        structurallyCompletePng().subarray(0, -12),
        pngChunk("IEND", Buffer.from([0])),
      ]),
    ],
    [
      "wrong IHDR length",
      Buffer.concat([
        structurallyCompletePng().subarray(0, 8),
        pngChunk("IHDR", Buffer.alloc(12)),
        pngChunk("IDAT"),
        pngChunk("IEND"),
      ]),
    ],
    [
      "invalid chunk CRC",
      (() => {
        const bytes = Buffer.from(structurallyCompletePng());
        bytes[29] = (bytes[29] ?? 0) ^ 0xff;
        return bytes;
      })(),
    ],
  ])("rejects a structurally invalid PNG: %s", (_case, bytes) => {
    vi.spyOn(Resvg.prototype, "render").mockReturnValue({
      asPng: () => bytes,
      width: 1080,
      height: 1440,
      pixels: Buffer.alloc(0),
    });
    const root = projectRoot();

    expect(() => renderReportCard({ projectRoot: root, report: report() })).toThrow(
      /^Unable to render report card$/,
    );
    expect(existsSync(join(root, "output"))).toBe(false);
  });

  it("does not leave a PNG when the JSON target is a pre-existing directory", () => {
    const root = projectRoot();
    const value = report();
    const paths = expectedPaths(root, value);
    mkdirSync(paths.jsonPath, { recursive: true });

    expect(() => renderReportCard({ projectRoot: root, report: value })).toThrow(
      /^Unable to render report card$/,
    );
    expect(existsSync(paths.pngPath)).toBe(false);
    expect(statSync(paths.jsonPath).isDirectory()).toBe(true);
  });

  it.each(["json", "png"] as const)(
    "rejects a pre-existing %s file without changing either target",
    (existingTarget) => {
      const root = projectRoot();
      const value = report();
      const paths = expectedPaths(root, value);
      mkdirSync(paths.directory, { recursive: true });
      const existingPath =
        existingTarget === "json" ? paths.jsonPath : paths.pngPath;
      const otherPath = existingTarget === "json" ? paths.pngPath : paths.jsonPath;
      const sentinel = Buffer.from(`existing-${existingTarget}`);
      writeFileSync(existingPath, sentinel);

      expect(() => renderReportCard({ projectRoot: root, report: value })).toThrow(
        /^Unable to render report card$/,
      );
      expect(readFileSync(existingPath)).toEqual(sentinel);
      expect(existsSync(otherPath)).toBe(false);
    },
  );

  it("removes only its new JSON when a pre-existing PNG directory blocks writing", () => {
    const root = projectRoot();
    const value = report();
    const paths = expectedPaths(root, value);
    mkdirSync(paths.pngPath, { recursive: true });

    expect(() => renderReportCard({ projectRoot: root, report: value })).toThrow(
      /^Unable to render report card$/,
    );
    expect(existsSync(paths.jsonPath)).toBe(false);
    expect(statSync(paths.pngPath).isDirectory()).toBe(true);
  });

  it("uses one-time artifact paths without replacing a completed pair", () => {
    const root = projectRoot();
    const value = report();
    const artifact = renderReportCard({ projectRoot: root, report: value });
    const pngBefore = readFileSync(artifact.pngPath);
    const jsonBefore = readFileSync(artifact.jsonPath);

    expect(() => renderReportCard({ projectRoot: root, report: value })).toThrow(
      /^Unable to render report card$/,
    );
    expect(readFileSync(artifact.pngPath)).toEqual(pngBefore);
    expect(readFileSync(artifact.jsonPath)).toEqual(jsonBefore);
  });

  it("writes JSON before PNG and removes only that new JSON if PNG writing fails", () => {
    const root = projectRoot();
    const value = report();
    const paths = expectedPaths(root, value);
    const writes: string[] = [];
    const writeText = projectFile.writeProjectTextAtomic;
    vi.spyOn(projectFile, "writeProjectTextAtomic").mockImplementation(
      (projectRoot, filePath, content) => {
        writes.push("json");
        writeText(projectRoot, filePath, content);
      },
    );
    vi.spyOn(projectFile, "writeProjectBytesAtomic").mockImplementation(() => {
      writes.push("png");
      throw new Error("PRIVATE_WRITE_FAILURE");
    });

    expect(() => renderReportCard({ projectRoot: root, report: value })).toThrow(
      /^Unable to render report card$/,
    );
    expect(writes).toEqual(["json", "png"]);
    expect(existsSync(paths.jsonPath)).toBe(false);
    expect(existsSync(paths.pngPath)).toBe(false);
  });

  it("renders XML-safe reports containing forbidden scalar input", () => {
    const root = projectRoot();
    const loneSurrogate = String.fromCharCode(0xd800);
    const value = {
      ...report(),
      summary: [`合法中文😀\ufffe${loneSurrogate}`],
    } as RunReport;

    const artifact = renderReportCard({ projectRoot: root, report: value });
    expect(readFileSync(artifact.pngPath).subarray(12, 16).toString("ascii")).toBe(
      "IHDR",
    );
    expect(JSON.parse(readFileSync(artifact.jsonPath, "utf8"))).toEqual(value);
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
