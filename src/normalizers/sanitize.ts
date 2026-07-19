import { redactSecrets } from "../security/redact.js";
import {
  JSONValueSchema,
  RawEvidenceSchema,
  type JsonValue,
  type RawEvidence,
} from "../types/collector.js";

const INVALID_WEB_URL_MESSAGE =
  "Candidate URL must be a valid HTTP or HTTPS URL";

export function sanitizeCandidateString(value: string): string {
  const sanitized = redactSecrets(value);
  if (typeof sanitized !== "string") {
    throw new TypeError("Candidate text sanitization failed");
  }
  return sanitized;
}

export function sanitizeCandidateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sanitizeCandidateString(value));
  } catch {
    throw new TypeError(INVALID_WEB_URL_MESSAGE);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(INVALID_WEB_URL_MESSAGE);
  }
  return parsed.toString();
}

export function sanitizeEvidenceValue(value: unknown): JsonValue {
  return JSONValueSchema.parse(redactSecrets(value));
}

export function sanitizeRawEvidence(value: unknown): RawEvidence {
  return RawEvidenceSchema.parse(redactSecrets(value));
}
