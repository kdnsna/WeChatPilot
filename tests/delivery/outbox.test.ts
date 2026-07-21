import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enqueueRunReportOutbox,
  inspectOutbox,
  processRunReportOutbox,
} from "../../src/delivery/outbox.js";
import type { RunReport } from "../../src/observer/run-report.js";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-outbox-"));
  roots.push(root);
  mkdirSync(join(root, ".state", "delivery", "outbox"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, ".state"), 0o700);
  chmodSync(join(root, ".state", "delivery"), 0o700);
  chmodSync(join(root, ".state", "delivery", "outbox"), 0o700);
  return root;
}

function report(runId: string, status: RunReport["status"] = "success"): RunReport {
  return {
    version: 1,
    runId,
    taskId: "daily-tech-digest",
    taskName: "每日科技情报",
    projectLabel: "WeChatPilot",
    status,
    startedAt: "2026-07-20T00:00:00.000Z",
    finishedAt: "2026-07-20T00:00:01.000Z",
    durationMs: 1000,
    summary: ["ok"],
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("delivery outbox", () => {
  it("enqueues private outbox items and bounds historical processing", async () => {
    const root = project();
    const values = [
      report("018f514c-1a2b-7abc-8def-1234567890b1"),
      report("018f514c-1a2b-7abc-8def-1234567890b2"),
      report("018f514c-1a2b-7abc-8def-1234567890b3"),
      report("018f514c-1a2b-7abc-8def-1234567890b4"),
    ];
    for (const value of values) {
      const item = enqueueRunReportOutbox({ projectRoot: root, report: value, priority: 10 });
      chmodSync(join(root, ".state", "delivery", "outbox", `${item.envelope.id}.json`), 0o600);
    }

    const deliver = vi.fn(async () => ({
      status: "sent" as const,
      textChunks: 1,
      image: "not-generated" as const,
      textAttempt: 1,
      imageAttempt: 0,
    }));

    const result = await processRunReportOutbox({
      projectRoot: root,
      historyLimit: 2,
      deliver,
      sendText: async () => ({ status: "sent", chunks: 1 }),
      sendImage: async () => ({ status: "sent" }),
    });

    expect(result.attempted).toBe(2);
    expect(result.deferred).toBeGreaterThanOrEqual(2);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(inspectOutbox(root).total).toBe(4);
  });

  it("moves indeterminate outcomes into manual review without throwing to callers", async () => {
    const root = project();
    const value = report("018f514c-1a2b-7abc-8def-1234567890c1");
    const item = enqueueRunReportOutbox({ projectRoot: root, report: value });
    chmodSync(join(root, ".state", "delivery", "outbox", `${item.envelope.id}.json`), 0o600);

    const error = Object.assign(new Error("indeterminate"), {
      name: "RunReportDeliveryIndeterminateError",
    });
    const result = await processRunReportOutbox({
      projectRoot: root,
      historyLimit: 3,
      deliver: async () => {
        throw error;
      },
      sendText: async () => ({ status: "sent", chunks: 1 }),
      sendImage: async () => ({ status: "sent" }),
    });

    expect(result.manualReview).toBe(1);
    const stored = JSON.parse(
      readFileSync(join(root, ".state", "delivery", "outbox", `${item.envelope.id}.json`), "utf8"),
    ) as { envelope: { disposition: string } };
    expect(stored.envelope.disposition).toBe("manual-review");
  });

  it("replaces an unattempted payload with the canonical finalized report", () => {
    const root = project();
    const initial = report("018f514c-1a2b-7abc-8def-1234567890c2");
    const canonical: RunReport = {
      ...initial,
      issueNumber: 7,
      issueLabel: "WP-000007",
    };
    const initialItem = enqueueRunReportOutbox({ projectRoot: root, report: initial });

    const item = enqueueRunReportOutbox({ projectRoot: root, report: canonical });

    expect(item.report).toEqual(canonical);
    expect(item.envelope.payloadSha256).not.toBe(initialItem.envelope.payloadSha256);
  });
});
