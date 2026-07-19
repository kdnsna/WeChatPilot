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
const DOUBLE_QUOTED_HOME_PATH =
  /"\/(?:Users|home)\/[^\r\n]+?"(?=[^\u0000-\u007f]|[.!?,;:)\]}]|\s|$)/gu;
const SINGLE_QUOTED_HOME_PATH =
  /'\/(?:Users|home)\/[^\r\n]+?'(?=[^\u0000-\u007f]|[.!?,;:)\]}]|\s|$)/gu;
const UNQUOTED_HOME_PATH =
  /\/(?:Users|home)\/[^\r\n<>]+?(?=\s+\/(?:Users|home)\/|[。！？；，]|[.!?,;:](?=\s|$)|[\])}](?=\s|$)|$)/gu;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;

function redactHomePaths(value: string): string {
  return value
    .replace(DOUBLE_QUOTED_HOME_PATH, '"[LOCAL_PATH]"')
    .replace(SINGLE_QUOTED_HOME_PATH, "'[LOCAL_PATH]'")
    .replace(UNQUOTED_HOME_PATH, "[LOCAL_PATH]");
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
