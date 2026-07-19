import { ZodError } from "zod";

import { HttpError } from "../lib/http.js";
import type { SourceStatus } from "../types/collector.js";

export function rethrowIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new HttpError({ kind: "aborted", retryable: false });
  }
}

export function classifyCollectorError(
  error: unknown,
  signal?: AbortSignal | undefined,
): SourceStatus {
  rethrowIfAborted(signal);
  if (error instanceof ZodError) {
    return "invalid";
  }
  if (!(error instanceof HttpError)) {
    return "error";
  }

  switch (error.kind) {
    case "unauthorized":
      return "unauthorized";
    case "blocked":
      return "blocked";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "invalid_response":
    case "response_too_large":
      return "invalid";
    default:
      return "error";
  }
}
