import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import {
  writeProjectBytesAtomic,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import { RunReportSchema, type RunReport } from "./run-report.js";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1440;
const MAXIMUM_PNG_BYTES = 5 * 1_024 * 1_024;
const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
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
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("=", "&#61;")
    .replaceAll(":", "&#58;");
}

function wrappedLines(
  value: string,
  maximumCharacters: number,
  maximumLines: number,
): readonly string[] {
  const characters = [...value];
  const lines: string[] = [];
  for (
    let offset = 0;
    offset < characters.length && lines.length < maximumLines;
    offset += maximumCharacters
  ) {
    const end = Math.min(offset + maximumCharacters, characters.length);
    let line = characters.slice(offset, end).join("");
    if (end < characters.length && lines.length === maximumLines - 1) {
      line = `${characters.slice(offset, Math.max(offset, end - 1)).join("")}…`;
    }
    lines.push(line);
  }
  return lines.length === 0 ? [""] : lines;
}

function textNode(
  x: number,
  y: number,
  size: 24 | 28 | 32 | 40 | 56,
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

function validPng(png: Uint8Array): boolean {
  if (png.byteLength > MAXIMUM_PNG_BYTES || png.byteLength < 24) {
    return false;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (png[index] !== PNG_SIGNATURE[index]) {
      return false;
    }
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return (
    view.getUint32(8) === 13 &&
    png[12] === 0x49 &&
    png[13] === 0x48 &&
    png[14] === 0x44 &&
    png[15] === 0x52 &&
    view.getUint32(16) === CARD_WIDTH &&
    view.getUint32(20) === CARD_HEIGHT
  );
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
    textNode(112, 142, 32, 600, report.projectLabel, "#475569"),
    textNode(112, 220, 56, 700, report.taskName),
    `<rect x="112" y="266" width="300" height="64" rx="32" fill="${status.color}"/>`,
    textNode(144, 310, 28, 700, status.label, "#ffffff"),
    textNode(696, 294, 24, 500, `${finished.date} ${finished.time}`, "#475569"),
    '<line x1="112" y1="374" x2="968" y2="374" stroke="#cbd5e1" stroke-width="2"/>',
    textNode(112, 432, 28, 700, "SUMMARY", "#475569"),
  );

  let summaryY = 484;
  const summaryLines = report.summary.flatMap((item) => wrappedLines(item, 35, 2));
  for (const line of summaryLines.slice(0, 8)) {
    nodes.push(textNode(132, summaryY, 32, 500, `• ${line}`));
    summaryY += 48;
  }

  const metricsTop = Math.max(704, summaryY + 24);
  nodes.push(
    `<line x1="112" y1="${metricsTop - 36}" x2="968" y2="${metricsTop - 36}" stroke="#e2e8f0" stroke-width="2"/>`,
    textNode(112, metricsTop, 28, 700, "METRICS", "#475569"),
  );
  let metricY = metricsTop + 58;
  for (const metric of report.metrics.slice(0, 6)) {
    const label = wrappedLines(metric.label, 12, 1)[0] ?? "";
    const value = wrappedLines(metric.value, 24, 1)[0] ?? "";
    nodes.push(
      `<rect x="112" y="${metricY - 38}" width="856" height="54" rx="12" fill="#f8fafc"/>`,
      textNode(136, metricY, 24, 600, label, "#475569"),
      textNode(450, metricY, 28, 600, value),
    );
    metricY += 66;
  }

  if (report.failure !== null) {
    const failureY = Math.min(1160, metricY + 28);
    nodes.push(
      textNode(112, failureY, 28, 700, "DETAIL", status.color),
      textNode(
        112,
        failureY + 48,
        24,
        500,
        wrappedLines(report.failure, 48, 1)[0] ?? "",
        "#334155",
      ),
    );
  }

  nodes.push(
    '<line x1="112" y1="1260" x2="968" y2="1260" stroke="#e2e8f0" stroke-width="2"/>',
    textNode(112, 1314, 24, 500, `Run ${report.runId}`, "#64748b"),
    textNode(
      112,
      1350,
      24,
      500,
      `Duration ${report.durationMs} ms · Artifacts ${report.artifacts.length}`,
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

    if (!validPng(png)) {
      throw new Error(SAFE_RENDER_ERROR);
    }

    const json = stableReportJson(parsed);
    writeProjectBytesAtomic(projectRoot, pngPath, png);
    writeProjectTextAtomic(projectRoot, jsonPath, json);
    return { pngPath, jsonPath };
  } catch {
    throw new Error(SAFE_RENDER_ERROR);
  }
}
