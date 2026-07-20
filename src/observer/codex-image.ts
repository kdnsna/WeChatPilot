import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  CodexExecutionError,
  executeCodex,
  type CodexInvocation,
} from "../digest/codex.js";
import { pngDimensions } from "../lib/png.js";
import { writeProjectBytesAtomic } from "../lib/project-file.js";
import { shanghaiDateKey } from "../lib/time.js";
import { sanitizeReportText } from "./report-policy.js";
import type { ReportIssue } from "./report-sequence.js";
import { RunReportSchema, type RunReport } from "./run-report.js";
import {
  buildEditorialImageInvocation,
  type EditorialConfig,
} from "./editorial-config.js";

const MAXIMUM_BRIEF_BYTES = 2_048;
const MAXIMUM_EVENT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_GENERATED_IMAGE_BYTES = 20 * 1_024 * 1_024;
const MINIMUM_HERO_DIMENSION = 768;
const PROMPT_MAXIMUM_BYTES = 64 * 1_024;
const STYLE_VERSION = "editorial-v1";

export type CodexImageFailureKind =
  | "aborted"
  | "artifact"
  | "event"
  | "failed"
  | "output-limit"
  | "spawn"
  | "timeout";

export class CodexImageError extends Error {
  override readonly name = "CodexImageError";

  constructor(readonly kind: CodexImageFailureKind) {
    super(`Codex image generation failed: ${kind}`);
  }
}

export interface GeneratedHeroArtifact {
  readonly pngPath: string;
  readonly sha256: string;
  readonly promptSha256: string;
}

export interface CodexImageDependencies {
  readonly executeJsonl?: (
    invocation: CodexInvocation,
    prompt: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly generatedImagesRoot?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function parseCompletedMessage(text: string): { readonly imagePath: string } {
  try {
    const result = JSON.parse(text) as unknown;
    if (
      !isObject(result) ||
      !exactKeys(result, ["status", "imagePath"]) ||
      result.status !== "generated" ||
      typeof result.imagePath !== "string" ||
      result.imagePath.length < 1 ||
      result.imagePath.length > 1_024
    ) {
      throw new TypeError("invalid result");
    }
    return { imagePath: result.imagePath };
  } catch {
    throw new CodexImageError("event");
  }
}

export function parseCodexImageEvents(
  jsonl: string,
): { readonly imagePath: string } {
  if (Buffer.byteLength(jsonl) > MAXIMUM_EVENT_BYTES) {
    throw new CodexImageError("output-limit");
  }
  let finalMessage: string | undefined;
  let turnCompleted = false;
  for (const line of jsonl.split(/\r?\n/gu)) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new CodexImageError("event");
    }
    if (!isObject(event) || typeof event.type !== "string") {
      throw new CodexImageError("event");
    }
    if (turnCompleted) {
      throw new CodexImageError("event");
    }
    if (event.type === "thread.started" || event.type === "turn.started") {
      continue;
    }
    if (event.type === "turn.completed") {
      turnCompleted = true;
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      throw new CodexImageError("event");
    }
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    ) {
      throw new CodexImageError("event");
    }
    if (!isObject(event.item)) {
      throw new CodexImageError("event");
    }
    if (event.item.type !== "reasoning" && event.item.type !== "agent_message") {
      throw new CodexImageError("event");
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      if (typeof event.item.text !== "string") {
        throw new CodexImageError("event");
      }
      finalMessage = event.item.text;
    }
  }
  if (finalMessage === undefined || !turnCompleted) {
    throw new CodexImageError("event");
  }
  return parseCompletedMessage(finalMessage);
}

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;
const PATH_TOKEN = /(?:^|\s)(?:\.{0,2}[\\/]|~[\\/])\S*/gu;
const INSTRUCTION_WORDS =
  /\b(?:ignore|instructions?|prompt|system|execute|run|tools?)\b|(?:忽略|指令|提示词|系统提示|执行|调用工具)/giu;
const INSTRUCTION_PUNCTUATION = /[\\/;:{}[\]()<>="'`|]/gu;

function topicLabel(value: string): string | null {
  const inert = value
    .replace(URL, " ")
    .replace(PATH_TOKEN, " ")
    .replace(INSTRUCTION_WORDS, " ")
    .replace(INSTRUCTION_PUNCTUATION, " ");
  const sanitized = sanitizeReportText(inert, {
    projectRoot: "",
    maximumCharacters: 64,
  });
  if (sanitized === null) {
    return null;
  }
  const compact = sanitized.replace(/\s+/gu, " ").trim();
  return compact === "" ? null : compact;
}

function validIssue(issue: ReportIssue): boolean {
  return (
    Number.isInteger(issue.number) &&
    issue.number > 0 &&
    issue.number <= 999_999 &&
    issue.label === `WP-${String(issue.number).padStart(6, "0")}`
  );
}

export function buildVisualBrief(
  reportInput: RunReport,
  issue: ReportIssue,
): string {
  let report: RunReport;
  try {
    report = RunReportSchema.parse(reportInput);
  } catch {
    throw new CodexImageError("failed");
  }
  if (
    !validIssue(issue) ||
    report.issueNumber !== issue.number ||
    report.issueLabel !== issue.label
  ) {
    throw new CodexImageError("failed");
  }
  const topics = (report.editorial?.highlights ?? [])
    .slice(0, 5)
    .flatMap((highlight) => {
      const label = topicLabel(highlight.title);
      return label === null ? [] : [label];
    });
  const brief = JSON.stringify({
    styleVersion: STYLE_VERSION,
    status: report.status,
    issueClass: "daily-report",
    topics,
  });
  if (Buffer.byteLength(brief) > MAXIMUM_BRIEF_BYTES) {
    throw new CodexImageError("failed");
  }
  return brief;
}

function buildPrompt(projectRoot: string, visualBrief: string): string {
  const path = join(projectRoot, "prompts", "editorial-hero.md");
  let template: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > PROMPT_MAXIMUM_BYTES) {
      throw new RangeError("prompt too large");
    }
    template = bytes.toString("utf8");
  } catch {
    throw new CodexImageError("failed");
  }
  const marker = "{{VISUAL_BRIEF}}";
  if (template.split(marker).length !== 2) {
    throw new CodexImageError("failed");
  }
  return template.replace(marker, visualBrief);
}

async function executeJsonl(
  invocation: CodexInvocation,
  prompt: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<string> {
  try {
    return await executeCodex(invocation, prompt, {
      timeoutMs: options.timeoutMs,
      maximumOutputBytes: MAXIMUM_EVENT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (!(error instanceof CodexExecutionError)) {
      throw new CodexImageError("failed");
    }
    const kinds: Record<string, CodexImageFailureKind> = {
      aborted: "aborted",
      failed: "failed",
      output_limit: "output-limit",
      spawn: "spawn",
      timeout: "timeout",
    };
    throw new CodexImageError(kinds[error.kind] ?? "failed");
  }
}

function generatedImagesRoot(): string {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome !== undefined && codexHome !== "") {
    return join(codexHome, "generated_images");
  }
  return join(homedir(), ".codex", "generated_images");
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function strictDescendant(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function readGeneratedPng(rootInput: string, imagePath: string): Buffer {
  let descriptor: number | undefined;
  try {
    if (
      !isAbsolute(rootInput) ||
      !isAbsolute(imagePath) ||
      normalize(imagePath) !== imagePath ||
      extname(imagePath).toLowerCase() !== ".png"
    ) {
      throw new TypeError("unsafe path");
    }
    const root = resolve(rootInput);
    const candidate = resolve(imagePath);
    if (!strictDescendant(root, candidate)) {
      throw new TypeError("outside root");
    }
    const realRoot = realpathSync(root);
    const pathMetadata = lstatSync(candidate);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
      throw new TypeError("not a regular file");
    }
    const realCandidate = realpathSync(candidate);
    if (!strictDescendant(realRoot, realCandidate)) {
      throw new TypeError("resolved outside root");
    }
    if (pathMetadata.size > MAXIMUM_GENERATED_IMAGE_BYTES) {
      throw new RangeError("image too large");
    }
    descriptor = openSync(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      !sameFile(before, pathMetadata) ||
      before.size !== pathMetadata.size ||
      before.size > MAXIMUM_GENERATED_IMAGE_BYTES
    ) {
      throw new TypeError("file identity mismatch");
    }

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) {
        throw new TypeError("file changed");
      }
      offset += count;
    }

    const after = fstatSync(descriptor);
    const finalPath = lstatSync(candidate);
    const finalRealCandidate = realpathSync(candidate);
    if (
      !sameFile(before, after) ||
      !sameFile(before, finalPath) ||
      !after.isFile() ||
      finalPath.isSymbolicLink() ||
      !finalPath.isFile() ||
      before.size !== after.size ||
      before.size !== finalPath.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== finalPath.mtimeMs ||
      before.ctimeMs !== finalPath.ctimeMs ||
      realCandidate !== finalRealCandidate ||
      !strictDescendant(realRoot, finalRealCandidate)
    ) {
      throw new TypeError("file changed");
    }
    const dimensions = pngDimensions(bytes);
    if (
      dimensions === null ||
      dimensions.width < MINIMUM_HERO_DIMENSION ||
      dimensions.height < MINIMUM_HERO_DIMENSION
    ) {
      throw new TypeError("invalid image");
    }
    return bytes;
  } catch {
    throw new CodexImageError("artifact");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function codexImagePromptSha256(
  projectRoot: string,
  report: RunReport,
  issue: ReportIssue,
): string {
  return sha256(
    buildPrompt(projectRoot, buildVisualBrief(report, issue)),
  );
}

export async function generateCodexHero(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly issue: ReportIssue;
  readonly config: EditorialConfig;
  readonly signal?: AbortSignal;
  readonly dependencies?: CodexImageDependencies;
}): Promise<GeneratedHeroArtifact> {
  if (!isAbsolute(options.projectRoot)) {
    throw new CodexImageError("failed");
  }
  let report: RunReport;
  try {
    report = RunReportSchema.parse(options.report);
  } catch {
    throw new CodexImageError("failed");
  }
  const visualBrief = buildVisualBrief(report, options.issue);
  const prompt = buildPrompt(options.projectRoot, visualBrief);
  let invocation: CodexInvocation;
  try {
    invocation = buildEditorialImageInvocation(
      options.config,
      options.projectRoot,
    );
  } catch {
    throw new CodexImageError("failed");
  }
  const run = options.dependencies?.executeJsonl ?? executeJsonl;
  let jsonl: string;
  try {
    jsonl = await run(invocation, prompt, {
      timeoutMs: options.config.generation.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof CodexImageError) {
      throw error;
    }
    throw new CodexImageError("failed");
  }
  const { imagePath } = parseCodexImageEvents(jsonl);
  let root: string;
  try {
    root = (options.dependencies?.generatedImagesRoot ?? generatedImagesRoot)();
  } catch {
    throw new CodexImageError("artifact");
  }
  const bytes = readGeneratedPng(root, imagePath);
  const pngPath = join(
    options.projectRoot,
    "output",
    "run-reports",
    shanghaiDateKey(report.finishedAt),
    `${report.runId}.hero.png`,
  );
  try {
    writeProjectBytesAtomic(options.projectRoot, pngPath, bytes);
  } catch {
    throw new CodexImageError("artifact");
  }
  return {
    pngPath,
    sha256: sha256(bytes),
    promptSha256: sha256(prompt),
  };
}
