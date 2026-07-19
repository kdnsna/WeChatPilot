import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  mode: "none" as "none" | "fail" | "replace" | "guard-replace",
  paths: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: unknown[]) => {
      const descriptor = Reflect.apply(actual.openSync, actual, args) as number;
      const path = args[0];
      if (typeof path === "string") {
        fault.paths.set(descriptor, path);
      }
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      fault.paths.delete(descriptor);
      return actual.closeSync(descriptor);
    },
    unlinkSync: (path: import("node:fs").PathLike) => {
      if (
        fault.mode === "guard-replace" &&
        typeof path === "string" &&
        path.endsWith(".lock.acquire")
      ) {
        fault.mode = "none";
        actual.unlinkSync(path);
        actual.writeFileSync(path, "replacement", { mode: 0o600 });
        return;
      }
      return actual.unlinkSync(path);
    },
    fsyncSync: (descriptor: number) => {
      const path = fault.paths.get(descriptor);
      if (
        fault.mode !== "none" &&
        path?.includes("report-delivery-") === true &&
        path.endsWith(".lock")
      ) {
        const mode = fault.mode;
        fault.mode = "none";
        if (mode === "replace") {
          actual.unlinkSync(path);
          actual.writeFileSync(path, "replacement", { mode: 0o600 });
        }
        throw Object.assign(new Error("injected lock fsync failure"), {
          code: "EIO",
        });
      }
      return actual.fsyncSync(descriptor);
    },
  };
});

import {
  RunReportDeliveryBusyError,
  deliverRunReport,
} from "../../src/delivery/run-report-delivery.js";
import type { RunReport } from "../../src/observer/run-report.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-20T01:00:00.000Z");
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-lock-failure-"));
  roots.push(root);
  return root;
}

function report(): RunReport {
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
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

afterEach(() => {
  fault.mode = "none";
  fault.paths.clear();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("run report lock creation failures", () => {
  it("removes its incomplete lock after fsync failure so a later acquire succeeds", async () => {
    const root = project();
    const lock = join(
      root,
      ".state",
      "locks",
      `report-delivery-${RUN_ID}.lock`,
    );
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const options = {
      projectRoot: root,
      report: report(),
      sendText,
      sendImage: vi.fn(async () => ({ status: "sent" as const })),
      now: () => NOW,
    };
    fault.mode = "fail";

    await expect(deliverRunReport(options)).rejects.toMatchObject({ code: "EIO" });
    expect(existsSync(lock)).toBe(false);
    await expect(deliverRunReport(options)).resolves.toMatchObject({ status: "sent" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does not delete a replacement when cleaning up a failed lock create", async () => {
    const root = project();
    const lock = join(
      root,
      ".state",
      "locks",
      `report-delivery-${RUN_ID}.lock`,
    );
    fault.mode = "replace";

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText: vi.fn(async () => ({ status: "sent" as const, chunks: 1 })),
        sendImage: vi.fn(async () => ({ status: "sent" as const })),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(readFileSync(lock, "utf8")).toBe("replacement");
    expect(existsSync(`${lock}.acquire`)).toBe(false);
  });

  it("does not delete a fixed guard replacement after recovering a dead guard", async () => {
    const root = project();
    const locks = join(root, ".state", "locks");
    const lock = join(locks, `report-delivery-${RUN_ID}.lock`);
    const guard = `${lock}.acquire`;
    const nonce = "33333333-3333-4333-8333-333333333333";
    const owner = `${guard}.owner-${nonce}`;
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    const descriptor = openSync(owner, "wx", 0o600);
    const identity = fstatSync(descriptor);
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        pid: 999_999,
        nonce,
        createdAt: NOW.toISOString(),
        dev: identity.dev,
        ino: identity.ino,
      })}\n`,
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    linkSync(owner, guard);
    fault.mode = "guard-replace";

    await expect(
      deliverRunReport({
        projectRoot: root,
        report: report(),
        sendText: vi.fn(async () => ({ status: "sent" as const, chunks: 1 })),
        sendImage: vi.fn(async () => ({ status: "sent" as const })),
        now: () => NOW,
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(RunReportDeliveryBusyError);
    expect(readFileSync(guard, "utf8")).toBe("replacement");
  });
});
