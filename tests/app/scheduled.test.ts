import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
} from "../../src/delivery/wechat.js";
import { deliverDailyDigest } from "../../src/delivery/digest-delivery.js";
import { validEditorial } from "../helpers/editorial.js";

const editorialUrls = ["https://one.test/a", "https://two.test/b"];

const historyItems = [
  {
    title: "Selected source",
    url: "https://example.test/selected",
    source: "hacker-news",
  },
] as const;

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-scheduled-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scheduled digest job", () => {
  it("does not run before 08:00 in Asia/Shanghai when launched at login", async () => {
    const { runScheduledDigest } = await import("../../src/app/scheduled.js");
    const generateDigest = vi.fn();

    await expect(
      runScheduledDigest({
        projectRoot: project(),
        now: new Date("2026-07-18T23:59:00.000Z"),
        dependencies: {
          generateDigest,
          prepareSender: vi.fn(),
          deliverDigest: vi.fn(),
          sleep: vi.fn(),
          loadHistory: () => historyItems,
        },
      }),
    ).resolves.toEqual({ status: "not-due", date: "2026-07-19" });
    expect(generateDigest).not.toHaveBeenCalled();
  });

  it("uses one initial attempt plus at most two retries before sending", async () => {
    const module = await import("../../src/app/scheduled.js").catch(() => ({}));
    const runScheduledDigest = (
      module as {
        runScheduledDigest?: (options: unknown) => Promise<unknown>;
      }
    ).runScheduledDigest;
    expect(runScheduledDigest).toBeTypeOf("function");
    if (runScheduledDigest === undefined) {
      return;
    }
    const generateDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("collection unavailable"))
      .mockRejectedValueOnce(new Error("codex unavailable"))
      .mockResolvedValue({
        status: "generated",
        output: {
          date: "2026-07-19",
          digest: "《科技与灵感日报》\n" + "正文".repeat(1_200),
          sourceUrls: editorialUrls,
          editorial: validEditorial(editorialUrls),
        },
        candidateCount: 42,
        sourceCategoryCount: 4,
      });
    const preparedSender = vi.fn(async () => ({
      status: "sent" as const,
      chunks: 2,
    }));
    const prepareSender = vi.fn(async () => preparedSender);
    const deliverDigest = vi.fn(async () => ({
      status: "sent" as const,
      chunks: 2,
      attempt: 1,
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      runScheduledDigest({
        projectRoot: project(),
        now: new Date("2026-07-19T00:00:00.000Z"),
        dependencies: {
          generateDigest,
          prepareSender,
          deliverDigest,
          sleep,
          loadHistory: () => historyItems,
        },
      }),
    ).resolves.toEqual({
      status: "sent",
      date: "2026-07-19",
      chunks: 2,
      jobAttempt: 3,
      deliveryAttempt: 1,
      editorial: expect.objectContaining({
        kind: "digest",
        highlights: [expect.objectContaining({ sourceCount: 2 })],
      }),
    });
    expect(generateDigest).toHaveBeenCalledTimes(3);
    expect(prepareSender).toHaveBeenCalledTimes(1);
    expect(deliverDigest).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries only an explicit WeChat rejection and reuses the generated digest", async () => {
    const { runScheduledDigest } = await import("../../src/app/scheduled.js");
    const generateDigest = vi.fn(async () => ({
      status: "generated" as const,
      output: {
        date: "2026-07-19",
        digest: "《科技与灵感日报》\n" + "正文".repeat(1_200),
      },
    }));
    const preparedSender = vi.fn(async () => ({
      status: "sent" as const,
      chunks: 2,
    }));
    const prepareSender = vi.fn(async () => preparedSender);
    const deliverDigest = vi
      .fn()
      .mockRejectedValueOnce(new WechatDeliveryRejectedError())
      .mockRejectedValueOnce(new WechatDeliveryRejectedError())
      .mockResolvedValue({ status: "sent", chunks: 2, attempt: 3 });
    const sleep = vi.fn(async () => undefined);

    await expect(
      runScheduledDigest({
        projectRoot: project(),
        now: new Date("2026-07-19T00:00:00.000Z"),
        dependencies: {
          generateDigest,
          prepareSender,
          deliverDigest,
          sleep,
          loadHistory: () => historyItems,
        },
      }),
    ).resolves.toMatchObject({
      status: "sent",
      jobAttempt: 3,
      deliveryAttempt: 3,
      editorial: { kind: "status" },
    });
    expect(generateDigest).toHaveBeenCalledOnce();
    expect(prepareSender).toHaveBeenCalledOnce();
    expect(deliverDigest).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("never retries an indeterminate WeChat result that could duplicate a message", async () => {
    const { runScheduledDigest } = await import("../../src/app/scheduled.js");
    const generateDigest = vi.fn(async () => ({
      status: "generated" as const,
      output: {
        date: "2026-07-19",
        digest: "《科技与灵感日报》\n" + "正文".repeat(1_200),
      },
    }));
    const deliverDigest = vi.fn(async () => {
      throw new WechatDeliveryIndeterminateError();
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      runScheduledDigest({
        projectRoot: project(),
        now: new Date("2026-07-19T00:00:00.000Z"),
        dependencies: {
          generateDigest,
          prepareSender: vi.fn(async () => vi.fn()),
          deliverDigest,
          sleep,
          loadHistory: () => historyItems,
        },
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryIndeterminateError);
    expect(generateDigest).toHaveBeenCalledOnce();
    expect(deliverDigest).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("records the selected source history only after remote send confirmation", async () => {
    const { runScheduledDigest } = await import("../../src/app/scheduled.js");
    const confirmedAt = new Date("2026-07-19T00:00:00.000Z");
    const recordHistory = vi.fn();
    const deliverDigest = vi.fn(
      async (options: Parameters<typeof deliverDailyDigest>[0]) => {
        await options.onConfirmedSend?.(confirmedAt);
        return { status: "sent" as const, chunks: 1, attempt: 1 };
      },
    );

    await runScheduledDigest({
      projectRoot: project(),
      now: new Date("2026-07-19T00:00:00.000Z"),
      dependencies: {
        generateDigest: vi.fn(async () => ({
          status: "generated" as const,
          output: {
            date: "2026-07-19",
            digest: "《科技与灵感日报》\n" + "正文".repeat(1_200),
          },
        })),
        prepareSender: vi.fn(async () => vi.fn()),
        deliverDigest,
        sleep: vi.fn(async () => undefined),
        loadHistory: () => historyItems,
        recordHistory,
      },
    });

    expect(recordHistory).toHaveBeenCalledWith(
      expect.any(String),
      historyItems,
      confirmedAt,
    );
  });
});
