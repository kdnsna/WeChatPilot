import { z } from "zod";

export const DeliveryDispositionSchema = z.enum([
  "missing",
  "retryable",
  "sent",
  "indeterminate",
  "blocked",
  "manual-review",
]);

export type DeliveryDisposition = z.infer<typeof DeliveryDispositionSchema>;

export const DeliveryChannelSchema = z.enum([
  "digest-text",
  "run-report-text",
  "run-report-image",
]);

export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;

export const DeliveryEnvelopeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    channel: DeliveryChannelSchema,
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime(),
    priority: z.number().int().min(0).max(1_000),
    attempt: z.number().int().min(0).max(32),
    nextAttemptAt: z.string().datetime().optional(),
    disposition: DeliveryDispositionSchema,
  })
  .strict();

export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelopeSchema>;

export interface DeliveryAdapterResult {
  readonly status: "sent";
  readonly chunks?: number;
}

export interface DeliveryAdapter {
  readonly channel: DeliveryChannel;
  send(options: {
    readonly projectRoot: string;
    readonly envelope: DeliveryEnvelope;
    readonly payload: unknown;
  }): Promise<DeliveryAdapterResult>;
}

export function classifyFixedSendError(error: unknown): DeliveryDisposition {
  const name = (error as { readonly name?: unknown } | null)?.name;
  if (name === "WechatDeliveryRejectedError") return "retryable";
  if (name === "WechatLoginExpiredError") return "blocked";
  if (name === "WechatMediaPreparationError") return "blocked";
  if (
    name === "WechatDeliveryIndeterminateError" ||
    name === "WechatPartialDeliveryError"
  ) {
    return "manual-review";
  }
  return "manual-review";
}

export function nextRetryAt(now: Date, attempt: number): string {
  const minutes = Math.min(240, 5 * 2 ** Math.max(0, attempt - 1));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}
