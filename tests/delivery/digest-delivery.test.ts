import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DailyDigestAlreadySentError,
  DailyDigestDeliveryBusyError,
  DailyDigestDeliveryIndeterminateError,
  DailyDigestRetryLimitError,
  deliverDailyDigest,
} from "../../src/delivery/digest-delivery.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatPartialDeliveryError,
} from "../../src/delivery/wechat.js";

const DATE = "2026-07-18";
const NOW = new Date("2026-07-18T13:30:00.000Z");
const DIGEST = "《科技与灵感日报》\n" + "正文".repeat(1_200);
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-delivery-ledger-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("daily digest delivery ledger", () => {
  it("atomically marks success and blocks every same-day duplicate", async () => {
    const root = project();
    const send = vi.fn(async () => ({ status: "sent" as const, chunks: 2 }));

    const result = await deliverDailyDigest({
      projectRoot: root,
      date: DATE,
      digest: DIGEST,
      send,
      now: () => NOW,
    });
    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: `${DIGEST}修订`,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestAlreadySentError);

    expect(result).toEqual({ status: "sent", chunks: 2, attempt: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const ledgerPath = join(root, ".state", "delivery", `${DATE}.json`);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(ledger).toMatchObject({ status: "sent", attempt: 1, chunks: 2 });
    expect(ledger.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it("records confirmed-send history before finalizing the sent ledger", async () => {
    const root = project();
    const ledgerPath = join(root, ".state", "delivery", `${DATE}.json`);
    const onConfirmedSend = vi.fn(async (sentAt: Date) => {
      const current = JSON.parse(readFileSync(ledgerPath, "utf8"));
      expect(current.status).toBe("sending");
      expect(sentAt).toEqual(NOW);
    });

    await deliverDailyDigest({
      projectRoot: root,
      date: DATE,
      digest: DIGEST,
      send: vi.fn(async () => ({ status: "sent" as const, chunks: 2 })),
      onConfirmedSend,
      now: () => NOW,
    });

    expect(onConfirmedSend).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).status).toBe("sent");
  });

  it("fails closed after a confirmed send when history persistence fails", async () => {
    const root = project();
    const send = vi.fn(async () => ({ status: "sent" as const, chunks: 2 }));

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        onConfirmedSend: async () => {
          throw new Error("history storage unavailable");
        },
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryIndeterminateError);
    expect(send).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        readFileSync(
          join(root, ".state", "delivery", `${DATE}.json`),
          "utf8",
        ),
      ).status,
    ).toBe("sending");
  });

  it("refuses a concurrent sender while the atomic lock is held", async () => {
    const root = project();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = vi.fn(async () => {
      entered?.();
      await gate;
      return { status: "sent" as const, chunks: 1 };
    });
    const first = deliverDailyDigest({
      projectRoot: root,
      date: DATE,
      digest: DIGEST,
      send,
      now: () => NOW,
    });
    await started;

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryBusyError);
    release?.();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("allows at most one initial attempt plus two definite-failure retries", async () => {
    const root = project();
    const send = vi.fn(async () => {
      throw new WechatDeliveryRejectedError();
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        deliverDailyDigest({
          projectRoot: root,
          date: DATE,
          digest: DIGEST,
          send,
          now: () => new Date(NOW.getTime() + attempt * 1_000),
        }),
      ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);
    }
    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestRetryLimitError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("fails closed on an unknown sender error instead of consuming a retry", async () => {
    const root = project();
    const send = vi.fn(async () => {
      throw new Error("unknown fixture failure");
    });

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toThrow("unknown fixture failure");
    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryIndeterminateError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves a lost-response state and never automatically resends it", async () => {
    const root = project();
    const send = vi.fn(async () => {
      throw new WechatDeliveryIndeterminateError();
    });

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryIndeterminateError);
    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryIndeterminateError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records confirmed chunks and expiry cause after a partial send", async () => {
    const root = project();
    const send = vi.fn(async () => {
      throw new WechatPartialDeliveryError(1, true);
    });

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WechatPartialDeliveryError);
    const ledger = JSON.parse(
      readFileSync(join(root, ".state", "delivery", `${DATE}.json`), "utf8"),
    );
    expect(ledger).toMatchObject({
      status: "indeterminate",
      confirmedChunks: 1,
      loginExpired: true,
    });
  });

  it("never marks a successful remote send as retryable when local finalization fails", async () => {
    const root = project();
    const send = vi.fn(async () => ({ status: "sent" as const, chunks: 2 }));
    let clockCalls = 0;
    const brokenAfterSendClock = (): Date => {
      clockCalls += 1;
      return clockCalls === 1 ? NOW : new Date(Number.NaN);
    };

    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: brokenAfterSendClock,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryIndeterminateError);
    await expect(
      deliverDailyDigest({
        projectRoot: root,
        date: DATE,
        digest: DIGEST,
        send,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(DailyDigestDeliveryIndeterminateError);
    expect(send).toHaveBeenCalledTimes(1);
    const ledger = JSON.parse(
      readFileSync(join(root, ".state", "delivery", `${DATE}.json`), "utf8"),
    );
    expect(ledger.status).toBe("sending");
  });
});
