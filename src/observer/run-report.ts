import { z } from "zod";

import {
  RunStatusSchema,
  sanitizeReportText,
} from "./report-policy.js";

const RAW_TEXT_MAXIMUM = 16_384;
const SUMMARY_MAXIMUM = 20;
const METRIC_MAXIMUM = 20;
const ARTIFACT_MAXIMUM = 32;
const SUMMARY_CHARACTER_MAXIMUM = 512;
const METRIC_LABEL_CHARACTER_MAXIMUM = 128;
const METRIC_VALUE_CHARACTER_MAXIMUM = 512;
const FAILURE_CHARACTER_MAXIMUM = 1_024;
const ARTIFACT_CHARACTER_MAXIMUM = 1_024;

const RawTextSchema = z.string().max(RAW_TEXT_MAXIMUM);

function safeReportTextSchema(maximumCharacters: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => [...value].length <= maximumCharacters,
      `report text must contain at most ${maximumCharacters} characters`,
    )
    .refine(
      (value) =>
        sanitizeReportText(value, {
          projectRoot: "",
          maximumCharacters,
        }) === value,
      "report text must satisfy the safety policy",
    );
}

const SafeSummaryTextSchema = safeReportTextSchema(SUMMARY_CHARACTER_MAXIMUM);
const SafeMetricLabelSchema = safeReportTextSchema(
  METRIC_LABEL_CHARACTER_MAXIMUM,
);
const SafeMetricValueSchema = safeReportTextSchema(
  METRIC_VALUE_CHARACTER_MAXIMUM,
);
const SafeFailureSchema = safeReportTextSchema(FAILURE_CHARACTER_MAXIMUM);

export const ProjectRelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_CHARACTER_MAXIMUM)
  .refine((value) => !value.startsWith("/"), "artifact path must be relative")
  .refine((value) => !value.includes("\\"), "artifact path must use POSIX separators")
  .refine(
    (value) => !/^[a-z]:/iu.test(value),
    "artifact path must not use a drive prefix",
  )
  .refine(
    (value) =>
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "artifact path must not contain traversal segments",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),
    "artifact path must not contain control characters",
  )
  .refine(
    (value) =>
      sanitizeReportText(value, {
        projectRoot: "",
        maximumCharacters: ARTIFACT_CHARACTER_MAXIMUM,
      }) === value,
    "artifact path must satisfy the safety policy",
  );

const RunMetricDraftSchema = z
  .object({
    label: RawTextSchema,
    value: RawTextSchema,
  })
  .strict();

const RunMetricSchema = z
  .object({
    label: SafeMetricLabelSchema,
    value: SafeMetricValueSchema,
  })
  .strict();

export const RunReportDraftSchema = z
  .object({
    version: z.literal(1),
    summary: z.array(RawTextSchema).max(SUMMARY_MAXIMUM),
    metrics: z.array(RunMetricDraftSchema).max(METRIC_MAXIMUM),
    failure: RawTextSchema.nullable().default(null),
    artifacts: z
      .array(ProjectRelativeArtifactPathSchema)
      .max(ARTIFACT_MAXIMUM),
  })
  .strict();

const authorityShape = {
  runId: z.uuid(),
  taskId: z.string().min(1).max(128),
  taskName: z.string().min(1).max(256),
  projectLabel: z.string().min(1).max(128),
  status: RunStatusSchema,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
} as const;

export const RunAuthoritySchema = z
  .object(authorityShape)
  .strict()
  .refine(
    (authority) =>
      Date.parse(authority.finishedAt) >= Date.parse(authority.startedAt),
    "finishedAt must not precede startedAt",
  );

export const RunReportSchema = z
  .object({
    version: z.literal(1),
    ...authorityShape,
    durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    summary: z.array(SafeSummaryTextSchema).min(1).max(SUMMARY_MAXIMUM),
    metrics: z.array(RunMetricSchema).max(METRIC_MAXIMUM),
    failure: SafeFailureSchema.nullable(),
    artifacts: z
      .array(ProjectRelativeArtifactPathSchema)
      .max(ARTIFACT_MAXIMUM),
  })
  .strict()
  .superRefine((report, context) => {
    const expectedDuration =
      Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    if (expectedDuration < 0) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "finishedAt must not precede startedAt",
      });
    }
    if (report.durationMs !== expectedDuration) {
      context.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "durationMs must match the authority timestamps",
      });
    }
  });

export type RunReportDraft = z.infer<typeof RunReportDraftSchema>;
export type RunAuthority = z.infer<typeof RunAuthoritySchema>;
export type RunReport = z.infer<typeof RunReportSchema>;

export interface BuildRunReportOptions {
  readonly authority: RunAuthority;
  readonly projectRoot: string;
  readonly draft: unknown | null;
}

const MINIMAL_SUMMARY = "任务已完成，未提供结构化业务摘要";

function sanitizedText(
  value: string,
  projectRoot: string,
  maximumCharacters: number,
): string | null {
  return sanitizeReportText(value, { projectRoot, maximumCharacters });
}

export function buildRunReport(options: BuildRunReportOptions): RunReport {
  const authority = RunAuthoritySchema.parse(options.authority);
  const parsedDraft = RunReportDraftSchema.safeParse(options.draft);

  let summary: string[] = [MINIMAL_SUMMARY];
  let metrics: Array<{ label: string; value: string }> = [];
  let failure: string | null = null;
  let artifacts: string[] = [];

  if (parsedDraft.success) {
    const sanitizedSummary = parsedDraft.data.summary.flatMap((value) => {
      const sanitized = sanitizedText(
        value,
        options.projectRoot,
        SUMMARY_CHARACTER_MAXIMUM,
      );
      return sanitized === null ? [] : [sanitized];
    });
    if (sanitizedSummary.length > 0) {
      summary = sanitizedSummary;
    }

    metrics = parsedDraft.data.metrics.flatMap((metric) => {
      const label = sanitizedText(
        metric.label,
        options.projectRoot,
        METRIC_LABEL_CHARACTER_MAXIMUM,
      );
      const value = sanitizedText(
        metric.value,
        options.projectRoot,
        METRIC_VALUE_CHARACTER_MAXIMUM,
      );
      return label === null || value === null ? [] : [{ label, value }];
    });

    failure =
      parsedDraft.data.failure === null
        ? null
        : sanitizedText(
            parsedDraft.data.failure,
            options.projectRoot,
            FAILURE_CHARACTER_MAXIMUM,
          );

    artifacts = parsedDraft.data.artifacts.flatMap((artifact) => {
      const sanitized = sanitizedText(
        artifact,
        options.projectRoot,
        ARTIFACT_CHARACTER_MAXIMUM,
      );
      if (sanitized === null) {
        return [];
      }
      const parsed = ProjectRelativeArtifactPathSchema.safeParse(sanitized);
      return parsed.success ? [parsed.data] : [];
    });
  }

  return RunReportSchema.parse({
    version: 1,
    ...authority,
    durationMs: Date.parse(authority.finishedAt) - Date.parse(authority.startedAt),
    summary,
    metrics,
    failure,
    artifacts,
  });
}
