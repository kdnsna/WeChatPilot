import { z } from "zod";

import { redactSecrets } from "../security/redact.js";

export const RunStatusSchema = z.enum([
  "success",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
  "skipped",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export interface SanitizeReportTextOptions {
  readonly projectRoot: string;
  readonly maximumCharacters: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROL_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/gu;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;

function findHomePrefix(line: string): number | null {
  const macosIndex = line.indexOf("/Users/");
  const linuxIndex = line.indexOf("/home/");
  if (macosIndex < 0) {
    return linuxIndex < 0 ? null : linuxIndex;
  }
  if (linuxIndex < 0) {
    return macosIndex;
  }
  return Math.min(macosIndex, linuxIndex);
}

function redactionStartIndex(line: string, pathIndex: number): number {
  const precedingCharacter = line[pathIndex - 1];
  return precedingCharacter === "'" || precedingCharacter === '"'
    ? pathIndex - 1
    : pathIndex;
}

function redactHomePathsInLine(line: string): string {
  const prefixIndex = findHomePrefix(line);
  if (prefixIndex === null) {
    return line;
  }

  // POSIX filenames make path boundaries in free text impossible to prove.
  // Fail closed from the first home prefix through this line.
  const replacementIndex = redactionStartIndex(line, prefixIndex);
  return `${line.slice(0, replacementIndex)}[LOCAL_PATH]`;
}

function redactHomePaths(value: string): string {
  return value
    .split(/(\r\n|\r|\n)/u)
    .map((line) => redactHomePathsInLine(line))
    .join("");
}

function redactProjectRootInLine(line: string, projectRoot: string): string {
  if (!projectRoot.startsWith("/Users/") && !projectRoot.startsWith("/home/")) {
    return line.replaceAll(projectRoot, "[LOCAL_PATH]");
  }

  const projectRootIndex = line.indexOf(projectRoot);
  if (projectRootIndex < 0) {
    return line;
  }
  return `${line.slice(0, redactionStartIndex(line, projectRootIndex))}[LOCAL_PATH]`;
}

function redactProjectRoot(value: string, projectRoot: string): string {
  if (projectRoot.length === 0) {
    return value;
  }
  return value
    .split(/(\r\n|\r|\n)/u)
    .map((line) => redactProjectRootInLine(line, projectRoot))
    .join("");
}

export function sanitizeReportText(
  value: string,
  options: SanitizeReportTextOptions,
): string | null {
  if (!Number.isInteger(options.maximumCharacters) || options.maximumCharacters < 1) {
    throw new RangeError("maximumCharacters must be a positive integer");
  }

  const redacted = redactSecrets(value);
  if (typeof redacted !== "string") {
    return null;
  }

  const sanitizedLines: string[] = [];
  for (const line of redacted.split(/\r\n|\r|\n/u)) {
    const controlsRemoved = line
      .replace(CONTROL_CHARACTERS, "")
      .replace(BIDI_CONTROL_CHARACTERS, "");
    const closureRedacted = redactSecrets(controlsRemoved);
    if (typeof closureRedacted !== "string") {
      return null;
    }

    const sanitizedLine = redactProjectRoot(
      closureRedacted,
      options.projectRoot,
    );
    sanitizedLines.push(
      redactHomePaths(sanitizedLine).replace(URL_TEXT, "[URL]"),
    );
  }

  const joinedClosureRedacted = redactSecrets(sanitizedLines.join(""));
  if (typeof joinedClosureRedacted !== "string") {
    return null;
  }
  const sanitized = redactHomePaths(
    redactProjectRoot(joinedClosureRedacted, options.projectRoot),
  )
    .replace(URL_TEXT, "[URL]")
    .replaceAll(/\s+/gu, " ")
    .trim();

  if (sanitized.length === 0) {
    return null;
  }

  const characters = [...sanitized];
  if (characters.length > options.maximumCharacters) {
    const prefix = characters
      .slice(0, options.maximumCharacters - 1)
      .join("")
      .trimEnd();
    return `${prefix}…`;
  }

  return sanitized;
}
