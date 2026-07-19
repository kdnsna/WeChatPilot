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
const UNQUOTED_HOME_PATH =
  /\/(?:Users|home)\/[^\r\n<>]+?(?=\s+\/(?:Users|home)\/|[。！？；，]|[.!?,;:](?=\s|$)|[\])}](?=\s|$)|$)/gu;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;

function findQuotedHomeOpening(line: string): number | null {
  for (let index = 0; index < line.length; index += 1) {
    const quote = line[index];
    if (quote !== "'" && quote !== '"') {
      continue;
    }
    if (
      line.startsWith("/Users/", index + 1) ||
      line.startsWith("/home/", index + 1)
    ) {
      return index;
    }
  }
  return null;
}

function redactQuotedHomePathsInLine(line: string): string {
  const openingIndex = findQuotedHomeOpening(line);
  if (openingIndex === null) {
    return line;
  }

  // Unescaped POSIX names make closing quotes indistinguishable from path data.
  // Fail closed through this line so an ambiguous path tail can never leak.
  return `${line.slice(0, openingIndex)}[LOCAL_PATH]`;
}

function redactQuotedHomePaths(value: string): string {
  return value
    .split(/(\r\n|\r|\n)/u)
    .map((line) => redactQuotedHomePathsInLine(line))
    .join("");
}

function redactHomePaths(value: string): string {
  return redactQuotedHomePaths(value).replace(
    UNQUOTED_HOME_PATH,
    "[LOCAL_PATH]",
  );
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

    let sanitizedLine = closureRedacted;
    if (options.projectRoot.length > 0) {
      sanitizedLine = sanitizedLine.replaceAll(
        options.projectRoot,
        "[LOCAL_PATH]",
      );
    }
    sanitizedLines.push(
      redactHomePaths(sanitizedLine).replace(URL_TEXT, "[URL]"),
    );
  }

  const joinedClosureRedacted = redactSecrets(sanitizedLines.join(""));
  if (typeof joinedClosureRedacted !== "string") {
    return null;
  }
  const sanitized = joinedClosureRedacted
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
