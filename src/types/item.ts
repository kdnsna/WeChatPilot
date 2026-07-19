import { z } from "zod";

export const Category = {
  COMMUNITY: "community",
  NEWS: "news",
  GITHUB: "github",
  DEEP_READING: "deep-reading",
} as const;

export const ITEM_CATEGORIES = [
  Category.COMMUNITY,
  Category.NEWS,
  Category.GITHUB,
  Category.DEEP_READING,
] as const;

export const CategorySchema = z.enum(ITEM_CATEGORIES);
export const ItemCategorySchema = CategorySchema;

export type Category = z.infer<typeof CategorySchema>;
export type ItemCategory = Category;

const MAX_SAFE_METRIC = Number.MAX_SAFE_INTEGER;
const RAW_METRIC_KEY_LIMIT = 128;
const RAW_METRIC_STRING_LIMIT = 2_048;
const RAW_METRIC_ENTRY_LIMIT = 64;

export const RawMetricValueSchema = z.union([
  z.string().max(RAW_METRIC_STRING_LIMIT),
  z.number().finite().min(-MAX_SAFE_METRIC).max(MAX_SAFE_METRIC),
  z.boolean(),
  z.null(),
]);

const webUrlSchema = z
  .string()
  .max(4_096)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS");

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nullableCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const rawMetricsSchema = z
  .record(z.string().min(1).max(RAW_METRIC_KEY_LIMIT), RawMetricValueSchema)
  .refine(
    (metrics) => Object.keys(metrics).length <= RAW_METRIC_ENTRY_LIMIT,
    `rawMetrics must contain at most ${RAW_METRIC_ENTRY_LIMIT} entries`,
  );

export const NormalizedItemSchema = z
  .object({
    source: z.string().min(1).max(128),
    category: CategorySchema,
    title: z.string().min(1).max(512),
    url: webUrlSchema,
    author: z.string().max(256).nullable(),
    publishedAt: isoDateTimeSchema.nullable(),
    comments: nullableCountSchema,
    score: nullableCountSchema,
    stars: nullableCountSchema,
    summary: z.string().max(4_096).nullable(),
    rawMetrics: rawMetricsSchema,
    collectedAt: isoDateTimeSchema,
  })
  .strict();

export type RawMetricValue = z.infer<typeof RawMetricValueSchema>;
export type NormalizedItem = z.infer<typeof NormalizedItemSchema>;
