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

function findHomePrefix(value: string): number | null {
  const macosIndex = value.indexOf("/Users/");
  const linuxIndex = value.indexOf("/home/");
  if (macosIndex < 0) {
    return linuxIndex < 0 ? null : linuxIndex;
  }
  if (linuxIndex < 0) {
    return macosIndex;
  }
  return Math.min(macosIndex, linuxIndex);
}

function redactionStartIndex(value: string, pathIndex: number): number {
  const precedingCharacter = value[pathIndex - 1];
  return precedingCharacter === "'" || precedingCharacter === '"'
    ? pathIndex - 1
    : pathIndex;
}

function redactHomePaths(value: string): string {
  const prefixIndex = findHomePrefix(value);
  if (prefixIndex === null) {
    return value;
  }

  // POSIX filenames make path boundaries in free text impossible to prove.
  // Controls are already removed, so fail closed through the entire field.
  const replacementIndex = redactionStartIndex(value, prefixIndex);
  return `${value.slice(0, replacementIndex)}[LOCAL_PATH]`;
}

function redactProjectRoot(value: string, projectRoot: string): string {
  if (projectRoot.length === 0) {
    return value;
  }
  if (!projectRoot.startsWith("/Users/") && !projectRoot.startsWith("/home/")) {
    return value.replaceAll(projectRoot, "[LOCAL_PATH]");
  }

  const projectRootIndex = value.indexOf(projectRoot);
  if (projectRootIndex < 0) {
    return value;
  }
  return `${value.slice(0, redactionStartIndex(value, projectRootIndex))}[LOCAL_PATH]`;
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

  const controlsRemoved = redacted
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_CONTROL_CHARACTERS, "");
  const closureRedacted = redactSecrets(controlsRemoved);
  if (typeof closureRedacted !== "string") {
    return null;
  }
  const sanitized = redactHomePaths(
    redactProjectRoot(closureRedacted, options.projectRoot),
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
