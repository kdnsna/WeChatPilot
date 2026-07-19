import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunReportAlreadySentError,
  RunReportDeliveryBlockedError,
  RunReportDeliveryBusyError,
  RunReportDeliveryIndeterminateError,
  RunReportRetryLimitError,
  deliverRunReport,
  formatRunReportText,
  inspectRunDeliveryState,
  runDeliveryDisposition,
  runReportSha256,
} from "../../src/delivery/run-report-delivery.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatLoginExpiredError,
  WechatPartialDeliveryError,
} from "../../src/delivery/wechat.js";
import { WechatMediaPreparationError } from "../../src/delivery/wechat-media.js";
import type { RunReport } from "../../src/observer/run-report.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-20T01:00:00.000Z");
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-run-delivery-"));
  roots.push(root);
  return root;
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    runId: RUN_ID,
    taskId: "daily-observer",
    taskName: "Daily observer",
    projectLabel: "WeChatPilot",
    status: "success",
    startedAt: "2026-07-20T00:59:00.000Z",
    finishedAt: "2026-07-20T01:00:00.000Z",
    durationMs: 60_000,
    summary: ["今日任务已完成"],
    metrics: [{ label: "items", value: "12" }],
    failure: null,
    artifacts: [],
    ...overrides,
  };
}

function ledger(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(root, ".state", "delivery", "runs", `${RUN_ID}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("run report delivery ledger", () => {
  it("sends text before the optional image exactly once and blocks duplicates", async () => {
    const root = project();
    const events: string[] = [];
    const sendText = vi.fn(async (text: string) => {
      expect(ledger(root).status).toBe("text-sending");
      events.push(`text:${text.split("\n").length}`);
      return { status: "sent" as const, chunks: 2 };
    });
    const sendImage = vi.fn(async (imagePath: string) => {
      expect(ledger(root).status).toBe("image-sending");
      events.push(`image:${imagePath.endsWith("report.png")}`);
      return { status: "sent" as const };
    });

    const result = await deliverRunReport({
      projectRoot: root,
      report: report(),
      imagePath: join(root, "report.png"),
      sendText,
      sendImage,
      now: () => NOW,
    });

    expect(result).toEqual({
      status: "sent",
      textChunks: 2,
      image: "sent",
      textAttempt: 1,
      imageAttempt: 1,
    });
    expect(events).toEqual(["text:4", "image:true"]);
    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        imagePath: join(root, "report.png"),
        sendText,
        sendImage,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(RunReportAlreadySentError);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledOnce();
    expect(ledger(root)).toMatchObject({
      status: "sent",
      textChunks: 2,
      image: "sent",
      textAttempt: 1,
      imageAttempt: 1,
    });
    expect(statSync(join(root, ".state", "delivery", "runs")).mode & 0o777).toBe(
      0o700,
    );
    expect(statSync(join(root, ".state")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, ".state", "delivery")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, ".state", "locks")).mode & 0o777).toBe(0o700);
    expect(
      statSync(
        join(root, ".state", "delivery", "runs", `${RUN_ID}.json`),
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it("retries only an explicitly rejected image without resending text", async () => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi
      .fn<(_: string) => Promise<{ status: "sent" }>>()
      .mockRejectedValueOnce(new WechatDeliveryRejectedError())
      .mockResolvedValueOnce({ status: "sent" });

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        imagePath: join(root, "report.png"),
        sendText,
        sendImage,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);
    expect(ledger(root)).toMatchObject({
      status: "failed",
      failedPart: "image",
      failureKind: "rejected",
      textAttempt: 1,
      imageAttempt: 1,
      textChunks: 1,
    });
    expect(runDeliveryDisposition({ projectRoot: root, report: report() })).toBe(
      "retryable",
    );

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        imagePath: join(root, "report.png"),
        sendText,
        sendImage,
        now: () => new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toEqual({
      status: "sent",
      textChunks: 1,
      image: "sent",
      textAttempt: 1,
      imageAttempt: 2,
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledTimes(2);
  });

  it("blocks a rejected image retry when its required image path disappears", async () => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi.fn(async () => {
      throw new WechatDeliveryRejectedError();
    });
    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        imagePath: join(root, "report.png"),
        sendText,
        sendImage,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText,
        sendImage,
        now: () => new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toBeInstanceOf(WechatMediaPreparationError);
    expect(ledger(root)).toMatchObject({
      status: "failed",
      failedPart: "image",
      failureKind: "media-preparation",
      textAttempt: 1,
      imageAttempt: 1,
      textChunks: 1,
    });
    expect(runDeliveryDisposition({ projectRoot: root, report: report() })).toBe(
      "blocked",
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledOnce();
  });

  it("completes a text-only report with an explicit not-generated image result", async () => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi.fn(async () => ({ status: "sent" as const }));

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText,
        sendImage,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      status: "sent",
      textChunks: 1,
      image: "not-generated",
      textAttempt: 1,
      imageAttempt: 0,
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it.each([
    ["lost", new WechatDeliveryIndeterminateError()],
    ["partial", new WechatPartialDeliveryError(1)],
  ])("makes a %s text result indeterminate and never replays it", async (_label, error) => {
    const root = project();
    const sendText = vi.fn(async () => {
      throw error;
    });
    const options = {
      projectRoot: root,
      report: report(),
      sendText,
      sendImage: vi.fn(async () => ({ status: "sent" as const })),
      now: () => NOW,
    };

    await expect(deliverRunReport(options)).rejects.toBe(error);
    expect(ledger(root)).toMatchObject({
      status: "indeterminate",
      uncertainPart: "text",
      textAttempt: 1,
    });
    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      RunReportDeliveryIndeterminateError,
    );
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("makes a lost image result indeterminate without replaying either part", async () => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi.fn(async () => {
      throw new WechatDeliveryIndeterminateError();
    });
    const options = {
      projectRoot: root,
      report: report(),
      imagePath: join(root, "report.png"),
      sendText,
      sendImage,
      now: () => NOW,
    };

    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      WechatDeliveryIndeterminateError,
    );
    expect(ledger(root)).toMatchObject({
      status: "indeterminate",
      uncertainPart: "image",
      textChunks: 1,
    });
    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      RunReportDeliveryIndeterminateError,
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledOnce();
  });

  it("replaces an unknown dependency failure with a fixed content-free error", async () => {
    const root = project();
    const privateMarker = "PRIVATE_UPSTREAM_SENTINEL";
    let thrown: unknown;
    try {
      await deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText: async () => {
          throw new Error(privateMarker);
        },
        sendImage: async () => ({ status: "sent" }),
        now: () => NOW,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RunReportDeliveryIndeterminateError);
    expect(JSON.stringify(thrown)).not.toContain(privateMarker);
    expect((thrown as Error).message).not.toContain(root);
  });

  it.each([
    ["login-expired", new WechatLoginExpiredError()],
    ["media-preparation", new WechatMediaPreparationError()],
  ])("blocks an image after %s without automatic retry", async (failureKind, error) => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi.fn(async () => {
      throw error;
    });
    const options = {
      projectRoot: root,
      report: report(),
      imagePath: join(root, "report.png"),
      sendText,
      sendImage,
      now: () => NOW,
    };

    await expect(deliverRunReport(options)).rejects.toBe(error);
    expect(ledger(root)).toMatchObject({
      status: "failed",
      failedPart: "image",
      failureKind,
    });
    expect(runDeliveryDisposition({ projectRoot: root, report: report() })).toBe(
      "blocked",
    );
    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      RunReportDeliveryBlockedError,
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledOnce();
  });

  it("limits three explicit image rejections without resending text", async () => {
    const root = project();
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi.fn(async () => {
      throw new WechatDeliveryRejectedError();
    });
    const options = {
      projectRoot: root,
      report: report(),
      imagePath: join(root, "report.png"),
      sendText,
      sendImage,
      now: () => NOW,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
        WechatDeliveryRejectedError,
      );
    }
    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      RunReportRetryLimitError,
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledTimes(3);
    expect(ledger(root)).toMatchObject({ imageAttempt: 3 });
  });

  it("refuses a concurrent sender while the run-specific lock is live", async () => {
    const root = project();
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendText = vi.fn(async () => {
      enter?.();
      await gate;
      return { status: "sent" as const, chunks: 1 };
    });
    const options = {
      projectRoot: root,
      report: report(),
      sendText,
      sendImage: vi.fn(async () => ({ status: "sent" as const })),
      now: () => NOW,
    };
    const first = deliverRunReport(options);
    await entered;

    await expect(deliverRunReport(options)).rejects.toBeInstanceOf(
      RunReportDeliveryBusyError,
    );
    release?.();
    await first;
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does not remove a replacement lock during release", async () => {
    const root = project();
    const lock = join(
      root,
      ".state",
      "locks",
      `report-delivery-${RUN_ID}.lock`,
    );
    await deliverRunReport({
      projectRoot: root,
      report: report(),
      sendText: async () => {
        unlinkSync(lock);
        writeFileSync(lock, "replacement", { mode: 0o600 });
        return { status: "sent", chunks: 1 };
      },
      sendImage: async () => ({ status: "sent" }),
      now: () => NOW,
    });

    expect(readFileSync(lock, "utf8")).toBe("replacement");
  });

  it("recovers only a private, well-formed lock whose owner is no longer alive", async () => {
    const root = project();
    const locks = join(root, ".state", "locks");
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(locks, `report-delivery-${RUN_ID}.lock`),
      `${JSON.stringify({
        pid: 999_999,
        nonce: "22222222-2222-4222-8222-222222222222",
        createdAt: NOW.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const processAlive = vi.fn(() => false);

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText: async () => ({ status: "sent", chunks: 1 }),
        sendImage: async () => ({ status: "sent" }),
        now: () => NOW,
        isProcessAlive: processAlive,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(processAlive).toHaveBeenCalledWith(999_999);
  });

  it.each(["mode", "malformed", "hash", "symlink"])(
    "fails closed for an invalid %s ledger without rewriting it",
    async (kind) => {
      const root = project();
      const runs = join(root, ".state", "delivery", "runs");
      mkdirSync(runs, { recursive: true, mode: 0o700 });
      const path = join(runs, `${RUN_ID}.json`);
      const valid = {
        version: 1,
        status: "sent",
        runId: RUN_ID,
        reportSha256: runReportSha256(report()),
        startedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        sentAt: NOW.toISOString(),
        textAttempt: 1,
        imageAttempt: 0,
        textChunks: 1,
        image: "not-generated",
      };
      if (kind === "symlink") {
        const target = join(root, "outside-ledger.json");
        writeFileSync(target, JSON.stringify(valid), { mode: 0o600 });
        symlinkSync(target, path);
      } else {
        writeFileSync(
          path,
          kind === "malformed"
            ? "PRIVATE_MALFORMED_SENTINEL"
            : JSON.stringify(
                kind === "hash" ? { ...valid, reportSha256: "0".repeat(64) } : valid,
              ),
          { mode: kind === "mode" ? 0o644 : 0o600 },
        );
        if (kind === "mode") {
          chmodSync(path, 0o644);
        }
      }
      const before = kind === "symlink" ? "symlink" : readFileSync(path, "utf8");

      await expect(
        deliverRunReport({
          projectRoot: root,
          report: report(),
          sendText: vi.fn(async () => ({ status: "sent" as const, chunks: 1 })),
          sendImage: vi.fn(async () => ({ status: "sent" as const })),
          now: () => NOW,
        }),
      ).rejects.toBeInstanceOf(RunReportDeliveryIndeterminateError);
      expect(kind === "symlink" ? "symlink" : readFileSync(path, "utf8")).toBe(before);
    },
  );

  it("turns a recovered sending claim into indeterminate without replay", async () => {
    const root = project();
    const runs = join(root, ".state", "delivery", "runs");
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(runs, `${RUN_ID}.json`),
      JSON.stringify({
        version: 1,
        status: "text-sending",
        runId: RUN_ID,
        reportSha256: runReportSha256(report()),
        startedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        textAttempt: 1,
        imageAttempt: 0,
      }),
      { mode: 0o600 },
    );
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText,
        sendImage: vi.fn(async () => ({ status: "sent" as const })),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(RunReportDeliveryIndeterminateError);
    expect(sendText).not.toHaveBeenCalled();
    expect(ledger(root)).toMatchObject({ status: "indeterminate" });
  });

  it("formats exactly four safe lines from RunReport fields and inspects counts", () => {
    const root = project();
    const value = report({
      summary: Array.from({ length: 10 }, () => "甲".repeat(500)),
      failure: "raw upstream error must not be delivered",
      artifacts: ["output/run-reports/card.png"],
    });
    const text = formatRunReportText(value);

    expect(text.split("\n")).toHaveLength(4);
    expect([...text].length).toBeLessThanOrEqual(1_800);
    expect(text).not.toContain("raw upstream error");
    expect(text).not.toContain("output/run-reports");
    expect(inspectRunDeliveryState({ projectRoot: root, reports: [report()] })).toEqual({
      pending: 1,
      indeterminate: 0,
      invalid: 0,
    });
    expect(existsSync(join(root, ".state"))).toBe(false);
  });

  it("locally sanitizes untrusted authority fields into bounded single lines", () => {
    const secret = `sk-${"a".repeat(24)}`;
    const text = formatRunReportText(
      report({
        projectLabel: `Pilot\n项目\u202e https://private.test/?token=value`,
        taskName: `\u0000 ${secret}\t/Users/private/account/config`,
      }),
    );
    const lines = text.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => [...line].length <= 520)).toBe(true);
    expect(
      lines.every(
        (line) =>
          !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
            line,
          ),
      ),
    ).toBe(true);
    expect(text).not.toContain("/Users/private");
    expect(text).not.toContain("https://");
    expect(text).not.toContain(secret);

    const fallback = formatRunReportText(
      report({ projectLabel: "\n\t\u202e", taskName: "\u0000" }),
    );
    expect(fallback.split("\n")).toEqual([
      "运行报告｜未命名项目",
      "任务：未命名任务",
      "状态：成功｜耗时：60000 ms",
      "摘要：今日任务已完成",
    ]);
  });

  it("counts retryable work separately from indeterminate and invalid ledgers", async () => {
    const root = project();
    const missing = report({ runId: "33333333-3333-4333-8333-333333333333" });
    const uncertain = report({ runId: "44444444-4444-4444-8444-444444444444" });
    const invalid = report({ runId: "55555555-5555-4555-8555-555555555555" });
    await expect(
      deliverRunReport({
        projectRoot: root,
        report: uncertain,
        sendText: async () => {
          throw new WechatDeliveryIndeterminateError();
        },
        sendImage: async () => ({ status: "sent" }),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryIndeterminateError);
    writeFileSync(
      join(root, ".state", "delivery", "runs", `${invalid.runId}.json`),
      "malformed",
      { mode: 0o600 },
    );

    expect(
      inspectRunDeliveryState({
        projectRoot: root,
        reports: [missing, uncertain, invalid],
      }),
    ).toEqual({ pending: 1, indeterminate: 1, invalid: 1 });
  });
});
