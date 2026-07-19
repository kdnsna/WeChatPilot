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
const TRUSTED_ASCII_QUOTED_PATH_BOUNDARIES = new Set([
  ".",
  "!",
  "?",
  ",",
  ";",
  ":",
  ")",
  "]",
  "}",
]);

interface QuotedHomeOpening {
  readonly index: number;
  readonly quote: "'" | '"';
}

function findQuotedHomeOpening(
  line: string,
  startIndex: number,
): QuotedHomeOpening | null {
  for (let index = startIndex; index < line.length; index += 1) {
    const quote = line[index];
    if (quote !== "'" && quote !== '"') {
      continue;
    }
    if (
      line.startsWith("/Users/", index + 1) ||
      line.startsWith("/home/", index + 1)
    ) {
      return { index, quote };
    }
  }
  return null;
}

function isTrustedQuotedHomeClosingBoundary(
  line: string,
  closingIndex: number,
): boolean {
  const nextCharacter = line[closingIndex + 1];
  if (nextCharacter === undefined) {
    return true;
  }
  return (
    nextCharacter.charCodeAt(0) > 0x7f ||
    /\s/u.test(nextCharacter) ||
    TRUSTED_ASCII_QUOTED_PATH_BOUNDARIES.has(nextCharacter)
  );
}

function redactQuotedHomePathsInLine(line: string): string {
  let cursor = 0;
  let result = "";
  while (cursor < line.length) {
    const opening = findQuotedHomeOpening(line, cursor);
    if (opening === null) {
      return result + line.slice(cursor);
    }
    result += line.slice(cursor, opening.index);

    // POSIX names can contain unescaped quotes. Taking the line's last matching
    // quote fails closed: ambiguous text may be over-redacted, but no path tail leaks.
    const closingIndex = line.lastIndexOf(opening.quote);
    if (
      closingIndex <= opening.index ||
      !isTrustedQuotedHomeClosingBoundary(line, closingIndex)
    ) {
      return result + `${opening.quote}[LOCAL_PATH]`;
    }

    result += `${opening.quote}[LOCAL_PATH]${opening.quote}`;
    cursor = closingIndex + 1;
  }
  return result;
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

  const controlsRemoved = redacted
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_CONTROL_CHARACTERS, "");
  const closureRedacted = redactSecrets(controlsRemoved);
  if (typeof closureRedacted !== "string") {
    return null;
  }
  let sanitized = closureRedacted;

  if (options.projectRoot.length > 0) {
    sanitized = sanitized.replaceAll(options.projectRoot, "[LOCAL_PATH]");
  }

  sanitized = redactHomePaths(sanitized)
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
