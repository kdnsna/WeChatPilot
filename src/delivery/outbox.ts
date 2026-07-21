import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { z } from "zod";

import {
  readPrivateProjectText,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  resolveProjectPath,
} from "../lib/paths.js";
import {
  DeliveryEnvelopeSchema,
  nextRetryAt,
  type DeliveryDisposition,
} from "./common.js";
import type { RunReport } from "../observer/run-report.js";
import { RunReportSchema } from "../observer/run-report.js";
import {
  deliverRunReport,
  runDeliveryDisposition,
  type DeliverRunReportOptions,
  type DeliverRunReportResult,
} from "./run-report-delivery.js";

const MAX_ITEM_BYTES = 128 * 1_024;
const DEFAULT_HISTORY_LIMIT = 3;

const OutboxItemSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("run-report"),
    envelope: DeliveryEnvelopeSchema,
    report: RunReportSchema,
    imagePath: z.string().min(1).max(4_096).optional(),
    lastErrorClass: z.string().min(1).max(128).optional(),
  })
  .strict();

export type OutboxItem = z.infer<typeof OutboxItemSchema>;

export interface ProcessOutboxOptions {
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly historyLimit?: number;
  readonly deliver?: (
    options: DeliverRunReportOptions,
  ) => Promise<DeliverRunReportResult>;
  readonly prepare?: (item: OutboxItem) => Promise<{
    readonly report: RunReport;
    readonly imagePath?: string;
  }>;
  readonly createSenders?: (item: OutboxItem) => Promise<{
    readonly sendText: DeliverRunReportOptions["sendText"];
    readonly sendImage: DeliverRunReportOptions["sendImage"];
  }>;
  readonly sendText?: DeliverRunReportOptions["sendText"];
  readonly sendImage?: DeliverRunReportOptions["sendImage"];
}

export interface ProcessOutboxResult {
  readonly considered: number;
  readonly attempted: number;
  readonly sent: number;
  readonly deferred: number;
  readonly manualReview: number;
  readonly failed: number;
}

function outboxDirectory(projectRoot: string): string {
  return resolveProjectPath(projectRoot, ".state", "delivery", "outbox");
}

function itemPath(projectRoot: string, id: string): string {
  return resolveProjectPath(
    projectRoot,
    ".state",
    "delivery",
    "outbox",
    `${id}.json`,
  );
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function enqueueRunReportOutbox(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly imagePath?: string;
  readonly priority?: number;
  readonly now?: () => Date;
}): OutboxItem {
  const report = RunReportSchema.parse(options.report);
  const now = (options.now ?? (() => new Date()))();
  const id = report.runId;
  const existing = readItem(options.projectRoot, id);
  if (existing !== null) {
    const payloadSha256 = stableHash(report);
    if (existing.envelope.payloadSha256 === payloadSha256) {
      return existing;
    }
    if (
      existing.envelope.disposition === "missing" &&
      existing.envelope.attempt === 0
    ) {
      const updated: OutboxItem = {
        ...existing,
        envelope: {
          ...existing.envelope,
          payloadSha256,
        },
        report,
        ...(options.imagePath === undefined ? {} : { imagePath: options.imagePath }),
      };
      writeItem(options.projectRoot, updated);
      return updated;
    }
    return existing;
  }
  const item: OutboxItem = {
    version: 1,
    kind: "run-report",
    envelope: {
      version: 1,
      id,
      channel: "run-report-text",
      payloadSha256: stableHash(report),
      createdAt: now.toISOString(),
      priority: options.priority ?? (report.status === "success" ? 100 : 50),
      attempt: 0,
      disposition: "missing",
    },
    report,
    ...(options.imagePath === undefined ? {} : { imagePath: options.imagePath }),
  };
  writeItem(options.projectRoot, item);
  return item;
}

function readItem(projectRoot: string, id: string): OutboxItem | null {
  const raw = readPrivateProjectText(
    projectRoot,
    itemPath(projectRoot, id),
    MAX_ITEM_BYTES,
  );
  if (raw === null) return null;
  return OutboxItemSchema.parse(JSON.parse(raw) as unknown);
}

function writeItem(projectRoot: string, item: OutboxItem): void {
  writeProjectTextAtomic(
    projectRoot,
    itemPath(projectRoot, item.envelope.id),
    `${JSON.stringify(item, null, 2)}\n`,
  );
}

function listItemIds(projectRoot: string): string[] {
  try {
    const directory = outboxDirectory(projectRoot);
    assertNoSymlinkComponents(projectRoot, directory);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function due(item: OutboxItem, now: Date): boolean {
  if (
    item.envelope.disposition === "sent" ||
    item.envelope.disposition === "manual-review" ||
    item.envelope.disposition === "blocked" ||
    item.envelope.disposition === "indeterminate"
  ) {
    return false;
  }
  if (item.envelope.nextAttemptAt === undefined) return true;
  return Date.parse(item.envelope.nextAttemptAt) <= now.getTime();
}

export function inspectOutbox(projectRoot: string): {
  readonly pending: number;
  readonly manualReview: number;
  readonly blocked: number;
  readonly total: number;
} {
  let pending = 0;
  let manualReview = 0;
  let blocked = 0;
  let total = 0;
  for (const id of listItemIds(projectRoot)) {
    try {
      const item = readItem(projectRoot, id);
      if (item === null) continue;
      total += 1;
      if (
        item.envelope.disposition === "missing" ||
        item.envelope.disposition === "retryable"
      ) {
        pending += 1;
      } else if (
        item.envelope.disposition === "manual-review" ||
        item.envelope.disposition === "indeterminate"
      ) {
        manualReview += 1;
      } else if (item.envelope.disposition === "blocked") {
        blocked += 1;
      }
    } catch {
      total += 1;
      manualReview += 1;
    }
  }
  return { pending, manualReview, blocked, total };
}

export async function processRunReportOutbox(
  options: ProcessOutboxOptions,
): Promise<ProcessOutboxResult> {
  const now = options.now ?? (() => new Date());
  const current = now();
  const limit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const deliver = options.deliver ?? deliverRunReport;
  const ids = listItemIds(options.projectRoot);
  const items = ids
    .map((id) => {
      try {
        return readItem(options.projectRoot, id);
      } catch {
        return null;
      }
    })
    .filter((item): item is OutboxItem => item !== null)
    .sort((left, right) => {
      if (left.envelope.priority !== right.envelope.priority) {
        return left.envelope.priority - right.envelope.priority;
      }
      return left.envelope.createdAt.localeCompare(right.envelope.createdAt);
    });

  let considered = 0;
  let attempted = 0;
  let sent = 0;
  let deferred = 0;
  let manualReview = 0;
  let failed = 0;

  for (const item of items) {
    considered += 1;
    if (!due(item, current)) {
      if (
        item.envelope.disposition === "manual-review" ||
        item.envelope.disposition === "indeterminate"
      ) {
        manualReview += 1;
      } else if (item.envelope.disposition !== "sent") {
        deferred += 1;
      }
      continue;
    }
    if (attempted >= limit) {
      deferred += 1;
      continue;
    }
    attempted += 1;
    try {
      const disposition = runDeliveryDisposition({
        projectRoot: options.projectRoot,
        report: item.report,
      });
      if (disposition === "sent") {
        writeItem(options.projectRoot, {
          ...item,
          envelope: { ...item.envelope, disposition: "sent" },
        });
        sent += 1;
        continue;
      }
      if (disposition === "indeterminate" || disposition === "blocked") {
        writeItem(options.projectRoot, {
          ...item,
          envelope: {
            ...item.envelope,
            disposition:
              disposition === "indeterminate" ? "manual-review" : "blocked",
          },
        });
        if (disposition === "indeterminate") manualReview += 1;
        else failed += 1;
        continue;
      }

      const prepared =
        options.prepare === undefined
          ? {
              report: item.report,
              ...(item.imagePath === undefined
                ? {}
                : { imagePath: item.imagePath }),
            }
          : await options.prepare(item);

      let sendText = options.sendText;
      let sendImage = options.sendImage;
      if (options.createSenders !== undefined) {
        const senders = await options.createSenders({
          ...item,
          report: prepared.report,
          ...(prepared.imagePath === undefined
            ? {}
            : { imagePath: prepared.imagePath }),
        });
        sendText = senders.sendText;
        sendImage = senders.sendImage;
      }
      if (sendText === undefined || sendImage === undefined) {
        deferred += 1;
        continue;
      }

      await deliver({
        projectRoot: options.projectRoot,
        report: prepared.report,
        sendText,
        sendImage,
        ...(prepared.imagePath === undefined
          ? {}
          : { imagePath: prepared.imagePath }),
        now,
      });
      writeItem(options.projectRoot, {
        ...item,
        report: prepared.report,
        ...(prepared.imagePath === undefined
          ? {}
          : { imagePath: prepared.imagePath }),
        envelope: {
          ...item.envelope,
          attempt: item.envelope.attempt + 1,
          disposition: "sent",
        },
      });
      sent += 1;
    } catch (error) {
      const className =
        error instanceof Error ? error.name : "UnknownDeliveryError";
      const disposition: DeliveryDisposition =
        className === "RunReportDeliveryBusyError"
          ? "retryable"
          : className === "RunReportAlreadySentError"
            ? "sent"
            : className === "RunReportRetryLimitError" ||
                className === "RunReportDeliveryBlockedError"
              ? "blocked"
              : className === "RunReportDeliveryIndeterminateError"
                ? "manual-review"
                : className === "WechatDeliveryRejectedError"
                  ? "retryable"
                  : className === "WechatLoginExpiredError"
                    ? "blocked"
                    : "retryable";
      const attempt = item.envelope.attempt + 1;
      writeItem(options.projectRoot, {
        ...item,
        lastErrorClass: className.slice(0, 128),
        envelope: {
          ...item.envelope,
          attempt,
          disposition,
          ...(disposition === "retryable"
            ? { nextAttemptAt: nextRetryAt(current, attempt) }
            : {}),
        },
      });
      if (disposition === "sent") sent += 1;
      else if (disposition === "manual-review") manualReview += 1;
      else if (disposition === "blocked") failed += 1;
      else deferred += 1;
    }
  }

  return { considered, attempted, sent, deferred, manualReview, failed };
}

export function outboxItemPathForTests(projectRoot: string, id: string): string {
  return itemPath(projectRoot, id);
}
