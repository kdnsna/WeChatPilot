import { z } from "zod";

import { type RunReportDraft, RunReportDraftSchema } from "./run-report.js";

const MAXIMUM_STDOUT_BYTES = 64 * 1024;
const SAFE_ERROR_MESSAGE = "Invalid scheduled digest result";

const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day
    );
  });

const SentResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("sent"),
    date: CalendarDateSchema,
    chunks: PositiveSafeIntegerSchema,
    jobAttempt: PositiveSafeIntegerSchema,
    deliveryAttempt: PositiveSafeIntegerSchema,
  })
  .strict();

const NotDueResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("not-due"),
    date: CalendarDateSchema,
  })
  .strict();

const AlreadySentResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("already-sent"),
    date: CalendarDateSchema,
    jobAttempt: PositiveSafeIntegerSchema,
  })
  .strict();

const ScheduledDigestResultSchema = z.discriminatedUnion("status", [
  SentResultSchema,
  NotDueResultSchema,
  AlreadySentResultSchema,
]);

export interface JobAdapterResult {
  readonly statusOverride: "success" | "skipped";
  readonly draft: RunReportDraft;
}

function safeError(): Error {
  const error = new Error(SAFE_ERROR_MESSAGE);
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function draft(
  summary: string,
  metrics: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): RunReportDraft {
  return RunReportDraftSchema.parse({
    version: 1,
    summary: [summary],
    metrics,
    failure: null,
    artifacts: [],
  });
}

export function parseScheduledDigestResult(stdout: string): JobAdapterResult {
  try {
    if (
      Buffer.byteLength(stdout, "utf8") > MAXIMUM_STDOUT_BYTES ||
      stdout.length === 0
    ) {
      throw safeError();
    }
    const document = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    if (
      document.length === 0 ||
      document[0] !== "{" ||
      document.at(-1) !== "}" ||
      document.includes("\n") ||
      document.includes("\r")
    ) {
      throw safeError();
    }
    const result = ScheduledDigestResultSchema.parse(
      JSON.parse(document) as unknown,
    );
    const dateMetric = { label: "日期", value: result.date } as const;

    if (result.status === "sent") {
      return {
        statusOverride: "success",
        draft: draft("今日日报已生成并发送", [
          dateMetric,
          { label: "消息分段", value: String(result.chunks) },
          { label: "任务尝试", value: String(result.jobAttempt) },
          { label: "发送尝试", value: String(result.deliveryAttempt) },
        ]),
      };
    }
    if (result.status === "already-sent") {
      return {
        statusOverride: "skipped",
        draft: draft("今日日报已发送，本次跳过", [
          dateMetric,
          { label: "任务尝试", value: String(result.jobAttempt) },
        ]),
      };
    }
    return {
      statusOverride: "skipped",
      draft: draft("尚未到每日发送时间，本次跳过", [dateMetric]),
    };
  } catch {
    throw safeError();
  }
}
