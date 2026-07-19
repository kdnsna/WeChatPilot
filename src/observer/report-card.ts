import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import {
  readProjectBytes,
  writeProjectBytesAtomic,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import { isValidPng } from "../lib/png.js";
import { RunReportSchema, type RunReport } from "./run-report.js";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1440;
const CONTENT_RIGHT = 1016;
const TEXT_EDGE_PADDING = 20;
const METRIC_LABEL_RIGHT = 438;
const MAXIMUM_PNG_BYTES = 5 * 1_024 * 1_024;
const MAXIMUM_JSON_BYTES = 256 * 1_024;
const SAFE_RENDER_ERROR = "Unable to render report card";

const STATUS_PRESENTATION: Record<
  RunReport["status"],
  { readonly label: string; readonly color: string }
> = {
  success: { label: "SUCCESS", color: "#15803d" },
  failed: { label: "FAILED", color: "#b91c1c" },
  "timed-out": { label: "TIMED OUT", color: "#b91c1c" },
  cancelled: { label: "CANCELLED", color: "#c2410c" },
  interrupted: { label: "INTERRUPTED", color: "#c2410c" },
  skipped: { label: "SKIPPED", color: "#64748b" },
};

export interface ReportCardArtifact {
  readonly pngPath: string;
  readonly jsonPath: string;
}

function escapeText(value: string): string {
  const xmlSafe = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint === 0x09 ||
          codePoint === 0x0a ||
          codePoint === 0x0d ||
          (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x1_0000 && codePoint <= 0x10_ffff)) &&
        !(codePoint >= 0x7f && codePoint <= 0x9f) &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join("");

  return xmlSafe
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("=", "&#61;")
    .replaceAll(":", "&#58;");
}

type FontSize = 24 | 28 | 32 | 40 | 56;

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function estimatedCodePointWidth(character: string, fontSize: FontSize): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (isEmojiCodePoint(codePoint)) {
    // Color-emoji fallback fonts can add substantial shaping advance.
    return fontSize * 2;
  }
  if (codePoint > 0x7f) {
    return fontSize * 1.1;
  }
  if (character === " ") {
    return fontSize * 0.4;
  }
  if (/[ilI1|.,:;'!`]/u.test(character)) {
    return fontSize * 0.45;
  }
  if (/[MW@#%&]/u.test(character)) {
    return fontSize;
  }
  return fontSize * 0.75;
}

function estimatedTextWidth(value: string, fontSize: FontSize): number {
  let width = 0;
  let sawEmoji = false;
  for (const character of value) {
    const emoji = isEmojiCodePoint(character.codePointAt(0) ?? 0);
    if (emoji && !sawEmoji) {
      width += fontSize * 4;
      sawEmoji = true;
    }
    width += estimatedCodePointWidth(character, fontSize);
  }
  return width;
}

function prefixWithinPixelBudget(
  characters: readonly string[],
  fontSize: FontSize,
  maximumPixelWidth: number,
): readonly string[] {
  let width = 0;
  let end = 0;
  let sawEmoji = false;
  while (end < characters.length) {
    const character = characters[end] ?? "";
    const emoji = isEmojiCodePoint(character.codePointAt(0) ?? 0);
    const fallbackAdvance = emoji && !sawEmoji ? fontSize * 4 : 0;
    const nextWidth =
      width +
      fallbackAdvance +
      estimatedCodePointWidth(character, fontSize);
    if (nextWidth > maximumPixelWidth) {
      break;
    }
    width = nextWidth;
    sawEmoji ||= emoji;
    end += 1;
  }
  return characters.slice(0, end);
}

function fitTextLines(
  value: string,
  fontSize: FontSize,
  maximumPixelWidth: number,
  maximumLines: number,
): readonly string[] {
  const characters = [...value];
  const lines: string[] = [];
  let offset = 0;
  while (offset < characters.length && lines.length < maximumLines) {
    const remaining = characters.slice(offset);
    if (estimatedTextWidth(remaining.join(""), fontSize) <= maximumPixelWidth) {
      lines.push(remaining.join(""));
      offset = characters.length;
      break;
    }

    const lastLine = lines.length === maximumLines - 1;
    const ellipsisWidth = lastLine
      ? estimatedCodePointWidth("…", fontSize)
      : 0;
    const prefix = prefixWithinPixelBudget(
      remaining,
      fontSize,
      maximumPixelWidth - ellipsisWidth,
    );
    if (prefix.length === 0) {
      lines.push(lastLine ? "…" : remaining[0] ?? "");
      offset += 1;
    } else {
      lines.push(`${prefix.join("")}${lastLine ? "…" : ""}`);
      offset += prefix.length;
    }
    if (lastLine) {
      break;
    }
  }
  return lines.length === 0 ? [""] : lines;
}

function singleLine(
  value: string,
  fontSize: FontSize,
  x: number,
  right = CONTENT_RIGHT,
): string {
  return (
    fitTextLines(
      value,
      fontSize,
      right - x - TEXT_EDGE_PADDING,
      1,
    )[0] ?? ""
  );
}

function textNode(
  x: number,
  y: number,
  size: FontSize,
  weight: 400 | 500 | 600 | 700,
  value: string,
  color = "#0f172a",
): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeText(value)}</text>`;
}

function shanghaiParts(instant: string): {
  readonly date: string;
  readonly time: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(SAFE_RENDER_ERROR);
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableReportJson(report: RunReport): string {
  return `${JSON.stringify(stableValue(report), null, 2)}\n`;
}

function omittedItemText(count: number, noun: "summary item" | "metric"): string {
  return `${count} more ${noun}${count === 1 ? "" : "s"} omitted`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

function regularFileIdentity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    throw new Error(SAFE_RENDER_ERROR);
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function removeNewRegularFile(path: string, identity: FileIdentity): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isFile() &&
      metadata.dev === identity.device &&
      metadata.ino === identity.inode
    ) {
      unlinkSync(path);
    }
  } catch {
    // Rollback is limited to the regular JSON file created by this invocation.
  }
}

export function buildReportCardSvg(report: RunReport): string {
  const status = STATUS_PRESENTATION[report.status] ?? STATUS_PRESENTATION.failed;
  const finished = shanghaiParts(report.finishedAt);
  const nodes: string[] = [];

  nodes.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="PingFang SC">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#f1f5f9"/>`,
    '<rect x="64" y="64" width="952" height="1312" rx="32" fill="#ffffff"/>',
    '<rect x="64" y="64" width="16" height="1312" rx="8" fill="#0f172a"/>',
    textNode(
      112,
      142,
      32,
      600,
      singleLine(report.projectLabel, 32, 112),
      "#475569",
    ),
    textNode(112, 220, 56, 700, singleLine(report.taskName, 56, 112)),
    `<rect x="112" y="266" width="300" height="64" rx="32" fill="${status.color}"/>`,
    textNode(144, 310, 28, 700, status.label, "#ffffff"),
    textNode(
      696,
      294,
      24,
      500,
      singleLine(`${finished.date} ${finished.time}`, 24, 696),
      "#475569",
    ),
    '<line x1="112" y1="374" x2="968" y2="374" stroke="#cbd5e1" stroke-width="2"/>',
    textNode(112, 432, 28, 700, "SUMMARY", "#475569"),
  );

  let summaryY = 484;
  const displayedSummary = report.summary.slice(0, 3);
  const summaryLines = displayedSummary.flatMap((item) =>
    fitTextLines(
      item,
      32,
      CONTENT_RIGHT -
        132 -
        TEXT_EDGE_PADDING -
        estimatedTextWidth("• ", 32),
      2,
    ),
  );
  for (const line of summaryLines) {
    nodes.push(textNode(132, summaryY, 32, 500, `• ${line}`));
    summaryY += 36;
  }
  const omittedSummaryItems = report.summary.length - displayedSummary.length;
  if (omittedSummaryItems > 0) {
    nodes.push(
      textNode(
        132,
        704,
        24,
        500,
        singleLine(
          omittedItemText(omittedSummaryItems, "summary item"),
          24,
          132,
        ),
        "#64748b",
      ),
    );
  }

  nodes.push(
    '<line x1="112" y1="744" x2="968" y2="744" stroke="#e2e8f0" stroke-width="2"/>',
    textNode(112, 786, 28, 700, "METRICS", "#475569"),
  );
  let metricY = 832;
  const displayedMetrics = report.metrics.slice(0, 6);
  for (const metric of displayedMetrics) {
    const label = singleLine(metric.label, 24, 136, METRIC_LABEL_RIGHT);
    const value = singleLine(metric.value, 28, 450);
    nodes.push(
      `<rect x="112" y="${metricY - 34}" width="856" height="44" rx="12" fill="#f8fafc"/>`,
      textNode(136, metricY, 24, 600, label, "#475569"),
      textNode(450, metricY, 28, 600, value),
    );
    metricY += 54;
  }
  const omittedMetrics = report.metrics.length - displayedMetrics.length;
  if (omittedMetrics > 0) {
    nodes.push(
      textNode(
        136,
        1150,
        24,
        500,
        singleLine(omittedItemText(omittedMetrics, "metric"), 24, 136),
        "#64748b",
      ),
    );
  }

  if (report.failure !== null) {
    nodes.push(
      textNode(112, 1188, 28, 700, "DETAIL", status.color),
      textNode(
        112,
        1230,
        24,
        500,
        singleLine(report.failure, 24, 112),
        "#334155",
      ),
    );
  }

  nodes.push(
    '<line x1="112" y1="1272" x2="968" y2="1272" stroke="#e2e8f0" stroke-width="2"/>',
    textNode(
      112,
      1312,
      24,
      500,
      singleLine(`Run ${report.runId}`, 24, 112),
      "#64748b",
    ),
    textNode(
      112,
      1348,
      24,
      500,
      singleLine(
        `Duration ${report.durationMs} ms · Artifacts ${report.artifacts.length}`,
        24,
        112,
      ),
      "#64748b",
    ),
    "</svg>",
  );

  return nodes.join("\n");
}

export function renderReportCard({
  projectRoot,
  report,
}: {
  readonly projectRoot: string;
  readonly report: RunReport;
}): ReportCardArtifact {
  try {
    const parsed = RunReportSchema.parse(report);
    const finished = shanghaiParts(parsed.finishedAt);
    const outputDirectory = join(
      projectRoot,
      "output",
      "run-reports",
      finished.date,
    );
    const pngPath = join(outputDirectory, `${parsed.runId}.png`);
    const jsonPath = join(outputDirectory, `${parsed.runId}.json`);
    const jsonExists = pathExists(jsonPath);
    const pngExists = pathExists(pngPath);
    if (jsonExists || pngExists) {
      if (!jsonExists || !pngExists) {
        throw new Error(SAFE_RENDER_ERROR);
      }
      const json = readProjectBytes(
        projectRoot,
        jsonPath,
        MAXIMUM_JSON_BYTES,
      );
      const png = readProjectBytes(
        projectRoot,
        pngPath,
        MAXIMUM_PNG_BYTES,
      );
      if (
        json === null ||
        png === null ||
        !json.equals(Buffer.from(stableReportJson(parsed), "utf8")) ||
        !isValidPng(png, {
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          maximumBytes: MAXIMUM_PNG_BYTES,
        })
      ) {
        throw new Error(SAFE_RENDER_ERROR);
      }
      return { pngPath, jsonPath };
    }
    const svg = buildReportCardSvg(parsed);
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: CARD_WIDTH },
      font: {
        loadSystemFonts: true,
        defaultFontFamily: "PingFang SC",
      },
    })
      .render()
      .asPng();

    if (!isValidPng(png, {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      maximumBytes: MAXIMUM_PNG_BYTES,
    })) {
      throw new Error(SAFE_RENDER_ERROR);
    }

    const json = stableReportJson(parsed);
    writeProjectTextAtomic(projectRoot, jsonPath, json);
    const jsonIdentity = regularFileIdentity(jsonPath);
    try {
      writeProjectBytesAtomic(projectRoot, pngPath, png);
      return { pngPath, jsonPath };
    } catch {
      removeNewRegularFile(jsonPath, jsonIdentity);
      throw new Error(SAFE_RENDER_ERROR);
    }
  } catch {
    throw new Error(SAFE_RENDER_ERROR);
  }
}
