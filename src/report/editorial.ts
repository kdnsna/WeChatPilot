import { z } from "zod";

import { sanitizeReportText } from "../observer/report-policy.js";

function codePointLength(value: string): number {
  return [...value].length;
}

const boundedText = (minimum: number, maximum: number) =>
  z
    .string()
    .refine(
      (value) =>
        codePointLength(value) >= minimum && codePointLength(value) <= maximum,
    );

export const DigestEditorialSchema = z
  .object({
    executiveSummary: boundedText(80, 140),
    highlights: z
      .array(
        z
          .object({
            title: boundedText(8, 36),
            whyItMatters: boundedText(40, 100),
            sourceUrls: z
              .array(z.string().url())
              .min(1)
              .max(6)
              .refine((values) => new Set(values).size === values.length),
            impact: z.enum([
              "high",
              "medium-high",
              "medium",
              "exploratory",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    actions: z.array(boundedText(12, 80)).length(3),
  })
  .strict();

export const EditorialReportPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["digest", "status"]),
    executiveSummary: z.string().min(1).max(280),
    highlights: z
      .array(
        z
          .object({
            title: z.string().min(1).max(80),
            whyItMatters: z.string().min(1).max(240),
            sourceCount: z.number().int().min(1).max(6),
            confidence: z.enum(["high", "medium-high", "medium"]),
            impact: z.enum([
              "high",
              "medium-high",
              "medium",
              "exploratory",
            ]),
          })
          .strict(),
      )
      .max(5),
    actions: z.array(z.string().min(1).max(120)).max(3),
    audit: z
      .object({
        candidateCount: z.number().int().nonnegative().optional(),
        selectedCount: z.number().int().nonnegative().optional(),
        sourceCategoryCount: z.number().int().nonnegative().optional(),
        scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      })
      .strict(),
  })
  .strict();

export type DigestEditorial = z.infer<typeof DigestEditorialSchema>;
export type EditorialReportPayload = z.infer<
  typeof EditorialReportPayloadSchema
>;

export interface EditorialPayloadOptions {
  readonly allowedUrls: readonly string[];
  readonly candidateCount: number;
  readonly sourceCategoryCount: number;
  readonly scheduledDate: string;
}

function safeText(value: string, maximumCharacters: number): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/giu, "");
  const sanitized = sanitizeReportText(withoutUrls, {
    projectRoot: "",
    maximumCharacters,
  });
  if (sanitized === null) {
    throw new Error("Editorial text sanitization failed");
  }
  return sanitized;
}

function confidence(sourceCount: number): "high" | "medium-high" | "medium" {
  if (sourceCount >= 3) {
    return "high";
  }
  return sourceCount === 2 ? "medium-high" : "medium";
}

export function toEditorialReportPayload(
  input: DigestEditorial,
  options: EditorialPayloadOptions,
): EditorialReportPayload {
  const raw = DigestEditorialSchema.parse(input);
  const allowed = new Set(options.allowedUrls);
  if (
    raw.highlights.some((highlight) =>
      highlight.sourceUrls.some((url) => !allowed.has(url)),
    )
  ) {
    throw new Error("Editorial source verification failed");
  }

  return EditorialReportPayloadSchema.parse({
    version: 1,
    kind: "digest",
    executiveSummary: safeText(raw.executiveSummary, 280),
    highlights: raw.highlights.map((highlight) => ({
      title: safeText(highlight.title, 80),
      whyItMatters: safeText(highlight.whyItMatters, 240),
      sourceCount: highlight.sourceUrls.length,
      confidence: confidence(highlight.sourceUrls.length),
      impact: highlight.impact,
    })),
    actions: raw.actions.map((action) => safeText(action, 120)),
    audit: {
      candidateCount: options.candidateCount,
      selectedCount: raw.highlights.length,
      sourceCategoryCount: options.sourceCategoryCount,
      scheduledDate: options.scheduledDate,
    },
  });
}
