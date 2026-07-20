import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { isValidPng, pngDimensions } from "../lib/png.js";
import {
  readProjectBytes,
  writeProjectBytesAtomic,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import type { PreparedReportVisual } from "./report-visual.js";
import {
  escapeText,
  fitTextLines,
  shanghaiParts,
  singleLine,
  stableReportJson,
  textNode,
} from "./report-card.js";
import { RunReportSchema, type RunReport } from "./run-report.js";

const CARD_WIDTH = 1_080;
const CARD_HEIGHT = 2_400;
const HERO_HEIGHT = 480;
const MAXIMUM_PNG_BYTES = 5 * 1_024 * 1_024;
const MAXIMUM_HERO_BYTES = 20 * 1_024 * 1_024;
const MAXIMUM_JSON_BYTES = 256 * 1_024;
const SAFE_RENDER_ERROR = "Unable to render editorial report card";
const PAPER = "#f3eee4";
const NAVY = "#10233f";
const ORANGE = "#d97941";
const INK = "#17243a";
const MUTED = "#667085";

const STATUS: Record<
  RunReport["status"],
  { readonly english: string; readonly chinese: string; readonly color: string }
> = {
  success: { english: "SUCCESS", chinese: "已完成", color: "#2f6f55" },
  failed: { english: "FAILED", chinese: "失败", color: "#a44236" },
  "timed-out": { english: "TIMED OUT", chinese: "超时", color: "#a44236" },
  cancelled: { english: "CANCELLED", chinese: "已取消", color: "#b35f2c" },
  interrupted: { english: "INTERRUPTED", chinese: "已中断", color: "#b35f2c" },
  skipped: { english: "SKIPPED", chinese: "已跳过", color: "#667085" },
};

const CONFIDENCE = {
  high: "高",
  "medium-high": "中高",
  medium: "中",
} as const;

const IMPACT = {
  high: "高影响",
  "medium-high": "中高影响",
  medium: "中影响",
  exploratory: "探索信号",
} as const;

export interface EditorialCardArtifact {
  readonly pngPath: string;
  readonly jsonPath: string;
  readonly issueLabel: string;
  readonly visualMode: "generated" | "fallback";
}

function multiline(options: {
  readonly x: number;
  readonly y: number;
  readonly lines: readonly string[];
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 500 | 600 | 700;
  readonly color?: string;
}): readonly string[] {
  return options.lines.map((line, index) =>
    textNode(
      options.x,
      options.y + index * options.lineHeight,
      options.size,
      options.weight,
      line,
      options.color ?? INK,
    ),
  );
}

function validHero(heroPng: Buffer, visualMode: "generated" | "fallback"): void {
  if (heroPng.byteLength > MAXIMUM_HERO_BYTES) {
    throw new Error(SAFE_RENDER_ERROR);
  }
  const dimensions = pngDimensions(heroPng);
  if (
    dimensions === null ||
    (visualMode === "generated"
      ? dimensions.width < 768 || dimensions.height < 768
      : dimensions.width !== 1_080 || dimensions.height !== 480)
  ) {
    throw new Error(SAFE_RENDER_ERROR);
  }
}

function bodyConfirmed(report: RunReport): boolean {
  return report.status === "success" && report.editorial?.kind === "digest";
}

function executiveText(report: RunReport): string {
  return report.editorial?.executiveSummary ?? report.summary[0] ?? "本次运行未提供编辑部摘要。";
}

function auditNumber(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

export function buildEditorialCardSvg(options: {
  readonly report: RunReport;
  readonly heroPng: Buffer;
  readonly visualMode: "generated" | "fallback";
}): string {
  validHero(options.heroPng, options.visualMode);
  const report = options.report;
  const status = STATUS[report.status] ?? STATUS.failed;
  const finished = shanghaiParts(report.finishedAt);
  const issueLabel = report.issueLabel ?? "WP-UNASSIGNED";
  const editorial = report.editorial;
  const isStatusReceipt = editorial?.kind === "status";
  const highlights = (editorial?.highlights ?? []).slice(0, 5);
  const actions = (editorial?.actions ?? []).slice(0, 3);
  const audit = editorial?.audit;
  const nodes: string[] = [];
  const heroData = options.heroPng.toString("base64");

  nodes.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="PingFang SC, Hiragino Sans GB, sans-serif">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${PAPER}"/>`,
    `<image x="0" y="0" width="${CARD_WIDTH}" height="${HERO_HEIGHT}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${heroData}"/>`,
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${HERO_HEIGHT}" fill="${NAVY}" opacity="0.42"/>`,
    `<rect x="64" y="54" width="8" height="58" rx="4" fill="${ORANGE}"/>`,
    textNode(92, 78, 20, 700, "WECHATPILOT · DAILY SIGNAL", "#ffffff"),
    textNode(92, 108, 18, 500, "编辑部情报刊 · EDITORIAL INTELLIGENCE", "#e9edf3"),
    textNode(796, 82, 22, 700, issueLabel, "#ffffff"),
    `<rect x="64" y="168" width="${status.english.length > 8 ? 230 : 178}" height="46" rx="23" fill="${status.color}"/>`,
    textNode(86, 199, 20, 700, `${status.english} · ${status.chinese}`, "#ffffff"),
    textNode(64, 292, 62, 700, "编辑部情报", "#ffffff"),
    textNode(66, 336, 24, 500, singleLine(report.taskName, 24, 66, 760), "#eef2f7"),
    textNode(64, 420, 20, 500, `${finished.date} · ${finished.time} CST`, "#ffffff"),
    ...(options.visualMode === "generated"
      ? [textNode(768, 420, 18, 600, "AI VISUAL", "#ffffff")]
      : []),
  );
  if (options.visualMode === "fallback") {
    nodes.push(
      `<rect x="654" y="366" width="362" height="44" rx="22" fill="${ORANGE}"/>`,
      textNode(680, 395, 20, 700, "AI 主视觉暂不可用", "#ffffff"),
    );
  }

  nodes.push(
    `<rect x="48" y="512" width="984" height="238" rx="22" fill="#fffaf1" stroke="#d8d0c2" stroke-width="2"/>`,
    `<rect x="48" y="512" width="12" height="238" rx="6" fill="${ORANGE}"/>`,
    textNode(84, 558, 18, 700, "EXECUTIVE BRIEF / 今日结论", ORANGE),
    ...multiline({
      x: 84,
      y: 612,
      lines: fitTextLines(executiveText(report), 30, 900, 4),
      size: 30,
      lineHeight: 38,
      weight: 600,
      color: INK,
    }),
    textNode(48, 808, 22, 700, "TOP SIGNALS / 重点信号", NAVY),
    textNode(822, 808, 18, 600, `VERIFIED ${String(highlights.length).padStart(2, "0")}`, MUTED),
    `<line x1="48" y1="832" x2="1032" y2="832" stroke="#cfc7b8" stroke-width="2"/>`,
  );

  if (highlights.length === 0) {
    nodes.push(
      `<rect x="48" y="868" width="984" height="560" rx="20" fill="#ebe5da"/>`,
      textNode(82, 940, 26, 700, `${status.english} · 本次不生成技术信号`, status.color),
      ...multiline({
        x: 82,
        y: 1000,
        lines: fitTextLines(executiveText(report), 26, 900, 5),
        size: 26,
        lineHeight: 38,
        weight: 500,
        color: INK,
      }),
      textNode(82, 1372, 20, 500, "状态报告不会为填充版面而虚构情报。", MUTED),
    );
  } else {
    const itemHeight = Math.min(220, Math.floor(820 / highlights.length));
    highlights.forEach((highlight, index) => {
      const top = 852 + index * itemHeight;
      const number = String(index + 1).padStart(2, "0");
      nodes.push(
        textNode(48, top + 52, 38, 700, number, ORANGE),
        `<line x1="48" y1="${top + itemHeight - 8}" x2="1032" y2="${top + itemHeight - 8}" stroke="#d8d0c2" stroke-width="1"/>`,
        textNode(138, top + 38, 27, 700, singleLine(highlight.title, 27, 138, 1018), INK),
        ...multiline({
          x: 138,
          y: top + 76,
          lines: fitTextLines(highlight.whyItMatters, 21, 866, itemHeight >= 200 ? 3 : 2),
          size: 21,
          lineHeight: 29,
          weight: 400,
          color: "#344054",
        }),
        textNode(
          138,
          top + itemHeight - 24,
          18,
          600,
          `${isStatusReceipt ? "证据" : "来源"} ${highlight.sourceCount} · 置信度 ${CONFIDENCE[highlight.confidence]} · ${IMPACT[highlight.impact]}`,
          MUTED,
        ),
      );
    });
    if (highlights.length < 3) {
      nodes.push(
        `<rect x="48" y="${852 + highlights.length * itemHeight + 12}" width="984" height="112" rx="18" fill="#efe0ce"/>`,
        textNode(80, 852 + highlights.length * itemHeight + 58, 22, 700, `LOW SIGNAL · 仅核验 ${highlights.length} 项`, ORANGE),
        textNode(80, 852 + highlights.length * itemHeight + 90, 18, 500, "保留实际信号数，不为凑满版面而补写未核验内容。", INK),
      );
    }
  }

  nodes.push(
    `<rect x="48" y="1710" width="984" height="374" rx="24" fill="${NAVY}"/>`,
    `<rect x="48" y="1710" width="984" height="10" rx="5" fill="${ORANGE}"/>`,
    textNode(84, 1768, 20, 700, "NEXT ACTIONS / 下一步行动", "#f8fafc"),
  );
  if (actions.length === 0) {
    nodes.push(
      textNode(84, 1848, 28, 600, "本次状态报告不生成行动建议", "#ffffff"),
      textNode(84, 1892, 20, 400, "请根据运行状态和值守流程处理，不执行未核验的技术操作。", "#cbd5e1"),
    );
  } else {
    actions.forEach((action, index) => {
      const y = 1824 + index * 82;
      nodes.push(
        `<circle cx="103" cy="${y - 8}" r="24" fill="${ORANGE}"/>`,
        textNode(90, y, 18, 700, String(index + 1).padStart(2, "0"), "#ffffff"),
        ...multiline({
          x: 148,
          y: y - 2,
          lines: fitTextLines(action, 23, 826, 2),
          size: 23,
          lineHeight: 29,
          weight: 500,
          color: "#ffffff",
        }),
      );
    });
  }

  const selectedCount = highlights.length;
  nodes.push(
    textNode(48, 2140, 20, 700, "CODEX AUDIT / 执行与交付审计", NAVY),
    `<line x1="48" y1="2162" x2="1032" y2="2162" stroke="#cfc7b8" stroke-width="2"/>`,
    textNode(48, 2204, 18, 600, `${isStatusReceipt ? "审计证据" : "候选"} ${auditNumber(audit?.candidateCount)}`, MUTED),
    textNode(218, 2204, 18, 600, `${isStatusReceipt ? "确认项" : "入选"} ${auditNumber(selectedCount)}`, MUTED),
    textNode(388, 2204, 18, 600, `${isStatusReceipt ? "检查域" : "来源覆盖"} ${auditNumber(audit?.sourceCategoryCount)}`, MUTED),
    textNode(620, 2204, 18, 600, `耗时 ${report.durationMs} ms`, MUTED),
    textNode(48, 2244, 18, 700, isStatusReceipt ? "状态回执：已生成" : bodyConfirmed(report) ? "日报正文：确认成功" : "日报正文：本次未确认", isStatusReceipt || bodyConfirmed(report) ? "#2f6f55" : MUTED),
    textNode(360, 2244, 18, 700, options.visualMode === "generated" ? "报告图：已生成" : "报告图：固定背景", options.visualMode === "generated" ? "#2f6f55" : ORANGE),
    textNode(48, 2288, 17, 600, isStatusReceipt ? "01 识别  →  02 取证  →  03 审计  →  04 回执合成" : "01 收集  →  02 核验  →  03 编排  →  04 图像合成", INK),
    `<line x1="48" y1="2320" x2="1032" y2="2320" stroke="#cfc7b8" stroke-width="1"/>`,
    textNode(48, 2362, 17, 600, `RUN ${report.runId.slice(0, 8).toUpperCase()} · ${escapeText(options.visualMode.toUpperCase())} · EDITORIAL-V1`, MUTED),
    textNode(908, 2362, 17, 700, "PAGE 01 / 01", NAVY),
    "</svg>",
  );
  return nodes.join("\n");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function regularFileIdentity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(SAFE_RENDER_ERROR);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function removeNewRegularFile(path: string, identity: FileIdentity): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === identity.dev &&
      metadata.ino === identity.ino
    ) {
      unlinkSync(path);
    }
  } catch {
    // Rollback is limited to the file created by this invocation.
  }
}

function sameHash(bytes: Uint8Array, expected: string): boolean {
  return createHash("sha256").update(bytes).digest("hex") === expected;
}

export function renderEditorialReportCard(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly visual: PreparedReportVisual;
}): EditorialCardArtifact {
  try {
    const report = RunReportSchema.parse(options.report);
    if (report.issueLabel === undefined || report.issueNumber === undefined) {
      throw new Error(SAFE_RENDER_ERROR);
    }
    const hero = readProjectBytes(
      options.projectRoot,
      options.visual.heroPath,
      MAXIMUM_HERO_BYTES,
    );
    if (
      hero === null ||
      !sameHash(hero, options.visual.heroSha256) ||
      options.visual.styleVersion !== "editorial-v1"
    ) {
      throw new Error(SAFE_RENDER_ERROR);
    }
    validHero(hero, options.visual.mode);

    const finished = shanghaiParts(report.finishedAt);
    const outputDirectory = join(
      options.projectRoot,
      "output",
      "run-reports",
      finished.date,
    );
    const pngPath = join(outputDirectory, `${report.runId}.png`);
    const jsonPath = join(outputDirectory, `${report.runId}.json`);
    const json = stableReportJson(report);
    const jsonExists = pathExists(jsonPath);
    const pngExists = pathExists(pngPath);
    if (jsonExists || pngExists) {
      if (!jsonExists || !pngExists) {
        throw new Error(SAFE_RENDER_ERROR);
      }
      const existingJson = readProjectBytes(
        options.projectRoot,
        jsonPath,
        MAXIMUM_JSON_BYTES,
      );
      const existingPng = readProjectBytes(
        options.projectRoot,
        pngPath,
        MAXIMUM_PNG_BYTES,
      );
      if (
        existingJson === null ||
        existingPng === null ||
        !existingJson.equals(Buffer.from(json, "utf8")) ||
        !isValidPng(existingPng, {
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          maximumBytes: MAXIMUM_PNG_BYTES,
        })
      ) {
        throw new Error(SAFE_RENDER_ERROR);
      }
      return {
        pngPath,
        jsonPath,
        issueLabel: report.issueLabel,
        visualMode: options.visual.mode,
      };
    }

    const svg = buildEditorialCardSvg({
      report,
      heroPng: hero,
      visualMode: options.visual.mode,
    });
    const png = Buffer.from(
      new Resvg(svg, {
        fitTo: { mode: "width", value: CARD_WIDTH },
        font: {
          loadSystemFonts: true,
          defaultFontFamily: "PingFang SC",
        },
      })
        .render()
        .asPng(),
    );
    if (
      !isValidPng(png, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        maximumBytes: MAXIMUM_PNG_BYTES,
      })
    ) {
      throw new Error(SAFE_RENDER_ERROR);
    }

    writeProjectTextAtomic(options.projectRoot, jsonPath, json);
    const jsonIdentity = regularFileIdentity(jsonPath);
    try {
      writeProjectBytesAtomic(options.projectRoot, pngPath, png);
    } catch {
      removeNewRegularFile(jsonPath, jsonIdentity);
      throw new Error(SAFE_RENDER_ERROR);
    }
    return {
      pngPath,
      jsonPath,
      issueLabel: report.issueLabel,
      visualMode: options.visual.mode,
    };
  } catch {
    throw new Error(SAFE_RENDER_ERROR);
  }
}
