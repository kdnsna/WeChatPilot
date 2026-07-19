import { HttpError } from "../lib/http.js";
import { redactSecrets } from "../security/redact.js";
import {
  CollectorResultSchema,
  type Collector,
  type CollectorContext,
  type CollectorResult,
} from "../types/collector.js";
import type { NormalizedItem } from "../types/item.js";

export type SourceTier = "core" | "optional";

export interface RegisteredCollector {
  readonly tier: SourceTier;
  readonly collector: Collector;
}

export interface CollectorRunOptions {
  readonly minimumCoreSuccesses: number;
}

export interface CollectionRunResult {
  readonly results: readonly CollectorResult[];
  readonly items: readonly NormalizedItem[];
  readonly degraded: boolean;
  readonly coreSuccesses: number;
  readonly minimumCoreSuccesses: number;
}

export class CollectionRunError extends Error {
  override readonly name = "CollectionRunError";
  readonly coreSuccesses: number;
  readonly minimumCoreSuccesses: number;

  constructor(coreSuccesses: number, minimumCoreSuccesses: number) {
    super("Too few core data sources completed successfully");
    this.coreSuccesses = coreSuccesses;
    this.minimumCoreSuccesses = minimumCoreSuccesses;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      coreSuccesses: this.coreSuccesses,
      minimumCoreSuccesses: this.minimumCoreSuccesses,
    };
  }
}

function requireMinimum(value: number, coreCount: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > coreCount) {
    throw new RangeError(
      "minimumCoreSuccesses must be a positive integer no greater than the core source count",
    );
  }
  return value;
}

function syntheticFailure(
  sourceId: string,
  status: "error" | "invalid",
  fetchedAt: string,
): CollectorResult {
  return {
    sourceId,
    status,
    fetchedAt,
    items: [],
    warning: `${sourceId} collector failed safely`,
    rawEvidence: {
      failureCounts: { collector: 1 },
    },
  };
}

function abortedFailure(reason: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (reason instanceof HttpError && reason.kind === "aborted")
  );
}

function validatedCollectorResult(
  value: ReturnType<typeof CollectorResultSchema.parse>,
): CollectorResult {
  return {
    sourceId: value.sourceId,
    status: value.status,
    fetchedAt: value.fetchedAt,
    items: value.items,
    ...(value.lastSuccessfulAt === undefined
      ? {}
      : { lastSuccessfulAt: value.lastSuccessfulAt }),
    ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }),
    ...(value.warning === undefined ? {} : { warning: value.warning }),
    ...(value.rawEvidence === undefined
      ? {}
      : { rawEvidence: value.rawEvidence }),
  };
}

export async function runCollectors(
  registrations: readonly RegisteredCollector[],
  context: CollectorContext,
  options: CollectorRunOptions,
): Promise<CollectionRunResult> {
  const coreCount = registrations.filter(({ tier }) => tier === "core").length;
  const minimumCoreSuccesses = requireMinimum(
    options.minimumCoreSuccesses,
    coreCount,
  );
  const fetchedAt = context.now().toISOString();
  const settled = await Promise.allSettled(
    registrations.map(async ({ collector }) => await collector.collect(context)),
  );

  if (context.signal?.aborted === true) {
    throw new HttpError({ kind: "aborted", retryable: false });
  }

  const results: CollectorResult[] = [];
  for (const [index, outcome] of settled.entries()) {
    const registration = registrations[index];
    if (registration === undefined) {
      continue;
    }
    const sourceId = registration.collector.sourceId;
    if (outcome.status === "rejected") {
      if (abortedFailure(outcome.reason, context.signal)) {
        throw new HttpError({ kind: "aborted", retryable: false });
      }
      results.push(syntheticFailure(sourceId, "error", fetchedAt));
      continue;
    }

    const parsed = CollectorResultSchema.safeParse(redactSecrets(outcome.value));
    if (!parsed.success || parsed.data.sourceId !== sourceId) {
      results.push(syntheticFailure(sourceId, "invalid", fetchedAt));
      continue;
    }
    results.push(validatedCollectorResult(parsed.data));
  }

  let coreSuccesses = 0;
  for (const [index, result] of results.entries()) {
    if (registrations[index]?.tier === "core" && result.status === "ok") {
      coreSuccesses += 1;
    }
  }
  if (coreSuccesses < minimumCoreSuccesses) {
    throw new CollectionRunError(coreSuccesses, minimumCoreSuccesses);
  }

  return {
    results,
    items: results.flatMap((result) => [...result.items]),
    degraded: results.some((result) => result.status !== "ok"),
    coreSuccesses,
    minimumCoreSuccesses,
  };
}
