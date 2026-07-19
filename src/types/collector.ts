import { z } from "zod";

import type { HttpClient } from "../lib/http.js";
import { NormalizedItemSchema, type NormalizedItem } from "./item.js";

export const SOURCE_STATUSES = [
  "ok",
  "not_modified",
  "stale",
  "rate_limited",
  "unauthorized",
  "blocked",
  "timeout",
  "invalid",
  "error",
] as const;

export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const SourceHealthSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    status: SourceStatusSchema,
    fetchedAt: isoDateTimeSchema,
    lastSuccessfulAt: isoDateTimeSchema.optional(),
    retryAt: isoDateTimeSchema.optional(),
    warning: z.string().max(1_024).optional(),
  })
  .strict();

export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_JSON_DEPTH = 16;
const MAX_JSON_BYTES = 2 * 1_024 * 1_024;
const MAX_JSON_STRING_LENGTH = 16_384;
const MAX_JSON_ARRAY_LENGTH = 1_000;
const MAX_JSON_OBJECT_KEYS = 256;
const MAX_JSON_KEY_LENGTH = 128;

const jsonKeySchema = z.string().min(1).max(MAX_JSON_KEY_LENGTH);

const BaseJSONValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(MAX_JSON_STRING_LENGTH),
    z
      .number()
      .finite()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER),
    z.boolean(),
    z.null(),
    z.array(BaseJSONValueSchema).max(MAX_JSON_ARRAY_LENGTH),
    z
      .record(jsonKeySchema, BaseJSONValueSchema)
      .refine(
        (record) => Object.keys(record).length <= MAX_JSON_OBJECT_KEYS,
        `JSON objects must contain at most ${MAX_JSON_OBJECT_KEYS} keys`,
      ),
  ]),
);

function addEvidenceBoundaryIssues(
  value: JsonValue | Record<string, JsonValue>,
  context: z.core.$RefinementCtx,
): void {
  const stack: Array<{ readonly value: JsonValue; readonly depth: number }> = [
    { value, depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > MAX_JSON_DEPTH) {
      context.addIssue({
        code: "custom",
        message: `JSON evidence must not exceed depth ${MAX_JSON_DEPTH}`,
        input: current.value,
      });
      return;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    context.addIssue({
      code: "custom",
      message: `JSON evidence must not exceed ${MAX_JSON_BYTES} bytes`,
      input: value,
    });
  }
}

export const JSONValueSchema: z.ZodType<JsonValue> =
  BaseJSONValueSchema.superRefine(addEvidenceBoundaryIssues);

export const RawEvidenceSchema = z
  .record(jsonKeySchema, BaseJSONValueSchema)
  .refine(
    (record) => Object.keys(record).length <= MAX_JSON_OBJECT_KEYS,
    `Raw evidence must contain at most ${MAX_JSON_OBJECT_KEYS} keys`,
  )
  .superRefine(addEvidenceBoundaryIssues);
export type RawEvidence = Readonly<Record<string, JsonValue>>;

export function createCollectorResultSchema<
  ItemSchema extends z.ZodType<NormalizedItem>,
>(itemSchema: ItemSchema) {
  return SourceHealthSchema.extend({
    items: z.array(itemSchema).max(1_000),
    rawEvidence: RawEvidenceSchema.optional(),
  }).strict();
}

export const CollectorResultSchema = createCollectorResultSchema(
  NormalizedItemSchema,
);

export interface CollectorResult<T extends NormalizedItem = NormalizedItem>
  extends SourceHealth {
  readonly items: readonly T[];
  readonly rawEvidence?: RawEvidence;
}

export interface CollectorContext {
  readonly http: HttpClient;
  readonly now: () => Date;
  readonly signal?: AbortSignal | undefined;
}

export interface Collector<T extends NormalizedItem = NormalizedItem> {
  readonly sourceId: string;
  collect(context: CollectorContext): Promise<CollectorResult<T>>;
}
