import {
  DailyDigestAlreadySentError,
  deliverDailyDigest,
} from "../delivery/digest-delivery.js";
import {
  prepareWechatTextSender,
  WechatDeliveryRejectedError,
  type PreparedWechatTextSender,
} from "../delivery/wechat.js";
import { loadDigestHistoryManifest } from "../history/digest-manifest.js";
import {
  recordSentReferences,
  type SentHistoryReference,
} from "../history/store.js";
import { shanghaiDateKey } from "../lib/time.js";
import { runDailyDigest } from "./digest.js";

const MAX_JOB_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 120_000] as const;
const SHANGHAI_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hourCycle: "h23",
});

interface GeneratedDigest {
  readonly status: "generated";
  readonly output: {
    readonly date: string;
    readonly digest: string;
  };
}

interface ScheduledDependencies {
  readonly generateDigest: (options: {
    readonly projectRoot: string;
    readonly now: Date;
    readonly githubToken?: string;
    readonly signal?: AbortSignal;
  }) => Promise<GeneratedDigest>;
  readonly prepareSender: (options: {
    readonly projectRoot: string;
  }) => Promise<PreparedWechatTextSender>;
  readonly deliverDigest: typeof deliverDailyDigest;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly loadHistory?: (
    projectRoot: string,
    date: string,
    digest: string,
  ) => readonly SentHistoryReference[];
  readonly recordHistory?: (
    projectRoot: string,
    items: readonly SentHistoryReference[],
    sentAt: Date,
  ) => void;
}

const defaultDependencies: ScheduledDependencies = {
  generateDigest: async (options) => {
    const result = await runDailyDigest({
      projectRoot: options.projectRoot,
      now: options.now,
      ...(options.githubToken === undefined
        ? {}
        : { githubToken: options.githubToken }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.status !== "generated") {
      throw new Error("scheduled digest unexpectedly returned a dry run");
    }
    return result;
  },
  prepareSender: async ({ projectRoot }) =>
    await prepareWechatTextSender({ projectRoot }),
  deliverDigest: deliverDailyDigest,
  loadHistory: loadDigestHistoryManifest,
  recordHistory: recordSentReferences,
  sleep: async (milliseconds) =>
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

export interface RunScheduledDigestOptions {
  readonly projectRoot: string;
  readonly now?: Date;
  readonly githubToken?: string;
  readonly signal?: AbortSignal;
  readonly dependencies?: ScheduledDependencies;
}

export type ScheduledDigestResult =
  | {
      readonly status: "not-due";
      readonly date: string;
    }
  | {
      readonly status: "sent";
      readonly date: string;
      readonly chunks: number;
      readonly jobAttempt: number;
      readonly deliveryAttempt: number;
    }
  | {
      readonly status: "already-sent";
      readonly date: string;
      readonly jobAttempt: number;
    };

export async function runScheduledDigest(
  options: RunScheduledDigestOptions,
): Promise<ScheduledDigestResult> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("scheduled digest time is invalid");
  }
  const shanghaiHour = Number(
    SHANGHAI_HOUR.formatToParts(now).find((part) => part.type === "hour")
      ?.value,
  );
  if (!Number.isInteger(shanghaiHour)) {
    throw new Error("unable to determine scheduled digest hour");
  }
  if (shanghaiHour < 8) {
    return { status: "not-due", date: shanghaiDateKey(now) };
  }
  let generated: GeneratedDigest | undefined;
  let sender: PreparedWechatTextSender | undefined;
  let historyItems: readonly SentHistoryReference[] | undefined;
  for (let jobAttempt = 1; jobAttempt <= MAX_JOB_ATTEMPTS; jobAttempt += 1) {
    try {
      if (generated === undefined) {
        generated = await dependencies.generateDigest({
          projectRoot: options.projectRoot,
          now,
          ...(options.githubToken === undefined
            ? {}
            : { githubToken: options.githubToken }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      historyItems ??= (dependencies.loadHistory ?? loadDigestHistoryManifest)(
        options.projectRoot,
        generated.output.date,
        generated.output.digest,
      );
      sender ??= await dependencies.prepareSender({
        projectRoot: options.projectRoot,
      });
      const delivery = await dependencies.deliverDigest({
        projectRoot: options.projectRoot,
        date: generated.output.date,
        digest: generated.output.digest,
        send: sender,
        onConfirmedSend: (sentAt) =>
          (dependencies.recordHistory ?? recordSentReferences)(
            options.projectRoot,
            historyItems!,
            sentAt,
          ),
        now: () => now,
      });
      return {
        status: "sent",
        date: generated.output.date,
        chunks: delivery.chunks,
        jobAttempt,
        deliveryAttempt: delivery.attempt,
      };
    } catch (error) {
      if (error instanceof DailyDigestAlreadySentError && generated !== undefined) {
        return {
          status: "already-sent",
          date: generated.output.date,
          jobAttempt,
        };
      }
      const retryable =
        options.signal?.aborted !== true &&
        (generated === undefined || error instanceof WechatDeliveryRejectedError);
      if (!retryable || jobAttempt >= MAX_JOB_ATTEMPTS) {
        throw error;
      }
      await dependencies.sleep(RETRY_DELAYS_MS[jobAttempt - 1]!);
    }
  }
  throw new Error("scheduled digest attempt loop exhausted");
}
