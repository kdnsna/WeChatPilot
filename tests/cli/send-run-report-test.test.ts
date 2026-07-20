import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runSendRunReportTestCli,
  sendFixedRunReportTest,
} from "../../src/cli/send-run-report-test.js";
import {
  RunReportDeliveryBlockedError,
  RunReportDeliveryIndeterminateError,
} from "../../src/delivery/run-report-delivery.js";
import {
  WechatDeliveryIndeterminateError,
  WechatDeliveryRejectedError,
  WechatLoginExpiredError,
} from "../../src/delivery/wechat.js";
import type { RunReport } from "../../src/observer/run-report.js";
import {
  ObserverTaskBusyError,
  acquireObserverTaskLock,
} from "../../src/observer/task-lock.js";

const NOW = new Date("2026-07-20T01:00:00.000Z");
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechat-test-card-"));
  roots.push(root);
  return root;
}

function checkpointPath(root: string): string {
  return join(root, ".state", "observer", "test-card.json");
}

function artifact(root: string, report: RunReport) {
  const base = join(
    root,
    "output",
    "run-reports",
    "2026-07-20",
    report.runId,
  );
  return { pngPath: `${base}.png`, jsonPath: `${base}.json` };
}

function checkpoint(root: string): { report: RunReport; imagePath: string } {
  return JSON.parse(readFileSync(checkpointPath(root), "utf8")) as {
    report: RunReport;
    imagePath: string;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("fixed run-report test checkpoint", () => {
  it("builds five editorial signals, assigns a real issue, and uses the production visual path", async () => {
    const root = project();
    const calls: string[] = [];
    const issue = { number: 21, label: "WP-000021" };
    const deliver = vi.fn(async ({ report, imagePath }) => {
      calls.push("deliver");
      expect(report.issueLabel).toBe(issue.label);
      expect(report.editorial?.highlights).toHaveLength(5);
      expect(report.editorial?.actions).toHaveLength(3);
      expect(imagePath).toBe(
        join(root, "output", "run-reports", "2026-07-20", `${FIRST_ID}.png`),
      );
      return {
        status: "sent" as const,
        textChunks: 1,
        image: "sent" as const,
        textAttempt: 1,
        imageAttempt: 1,
      };
    });

    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId: () => FIRST_ID,
          assignIssue: vi.fn(async () => {
            calls.push("assign");
            return issue;
          }),
          loadEditorial: vi.fn(() => {
            calls.push("config");
            return { mode: "editorial" } as never;
          }),
          prepareVisual: vi.fn(async ({ report }) => {
            calls.push("visual");
            expect(report.issueLabel).toBe(issue.label);
            return {
              mode: "generated" as const,
              attempts: 1,
              heroPath: join(root, "output", "preview.hero.png"),
              heroSha256: "a".repeat(64),
              styleVersion: "editorial-v1" as const,
              promptSha256: "b".repeat(64),
            };
          }),
          renderEditorial: vi.fn(({ report }) => {
            calls.push("render");
            return {
              ...artifact(root, report),
              issueLabel: report.issueLabel!,
              visualMode: "generated" as const,
            };
          }),
          prepareText: async () => async () => ({ status: "sent", chunks: 1 }),
          prepareImage: async () => async () => ({ status: "sent" }),
          deliver,
        },
      }),
    ).resolves.toMatchObject({ status: "sent", image: "sent" });

    expect(calls).toEqual(["assign", "config", "visual", "render", "deliver"]);
  });

  it("rejects a concurrent first invocation before duplicate delivery", async () => {
    const root = project();
    let startFirst!: () => void;
    let finishFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const createRunId = vi.fn(() => FIRST_ID);
    const render = vi.fn(({ report }: { report: RunReport }) => artifact(root, report));
    const deliver = vi.fn(async () => {
      if (deliver.mock.calls.length === 1) {
        startFirst();
        await firstCanFinish;
      }
      return {
        status: "sent" as const,
        textChunks: 1,
        image: "sent" as const,
        textAttempt: 1,
        imageAttempt: 1,
      };
    });
    const dependencies = {
      now: () => NOW,
      createRunId,
      render,
      prepareText: async () => async () => ({ status: "sent" as const, chunks: 1 }),
      prepareImage: async () => async () => ({ status: "sent" as const }),
      deliver,
    };

    const first = sendFixedRunReportTest({ projectRoot: root, dependencies });
    await firstStarted;
    await expect(
      sendFixedRunReportTest({ projectRoot: root, dependencies }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);
    expect(createRunId).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    finishFirst();
    await expect(first).resolves.toMatchObject({ status: "sent" });
  });

  it("releases an injected lifecycle lock after failure", async () => {
    const root = project();
    const release = vi.fn(async () => undefined);
    const acquireTaskLock = vi.fn(async () => ({ release }));

    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId: () => FIRST_ID,
          render: ({ report }) => artifact(root, report),
          acquireTaskLock,
          prepareText: async () => {
            throw new Error("sender preparation failed");
          },
        },
      }),
    ).rejects.toThrow("sender preparation failed");
    expect(acquireTaskLock).toHaveBeenCalledWith({
      projectRoot: root,
      taskId: "codex-wechat-observer-test",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the real fixed lock after an exception", async () => {
    const root = project();
    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId: () => FIRST_ID,
          render: ({ report }) => artifact(root, report),
          prepareText: async () => {
            throw new Error("sender preparation failed");
          },
        },
      }),
    ).rejects.toThrow("sender preparation failed");

    const next = await acquireObserverTaskLock({
      projectRoot: root,
      taskId: "codex-wechat-observer-test",
    });
    await next.release();
  });

  it("uses a lock independent from the live daily observer job", async () => {
    const root = project();
    const daily = await acquireObserverTaskLock({
      projectRoot: root,
      taskId: "daily-tech-digest",
    });
    try {
      await expect(
        sendFixedRunReportTest({
          projectRoot: root,
          dependencies: {
            now: () => NOW,
            createRunId: () => FIRST_ID,
            render: ({ report }) => artifact(root, report),
            prepareText: async () => async () => ({ status: "sent", chunks: 1 }),
            prepareImage: async () => async () => ({ status: "sent" }),
          },
        }),
      ).resolves.toMatchObject({ status: "sent" });
    } finally {
      await daily.release();
    }
  });

  it("emits a stable safe CLI error when the test-card lock is busy", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(
      runSendRunReportTestCli([], { stdout, stderr }, {
        send: async () => {
          throw new ObserverTaskBusyError();
        },
      }),
    ).resolves.toBe(1);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      `${JSON.stringify({
        error: "ObserverTaskBusyError",
        message: "inspect project logs",
      })}\n`,
    );
  });

  it("retries an explicitly rejected report with the same run and image", async () => {
    const root = project();
    const createRunId = vi
      .fn<() => string>()
      .mockReturnValueOnce(FIRST_ID)
      .mockReturnValueOnce(SECOND_ID);
    const render = vi.fn(({ report }: { report: RunReport }) => artifact(root, report));
    const sendText = vi
      .fn<() => Promise<{ status: "sent"; chunks: number }>>()
      .mockRejectedValueOnce(new WechatDeliveryRejectedError())
      .mockResolvedValueOnce({ status: "sent", chunks: 1 });
    const sendImage = vi.fn(async () => ({ status: "sent" as const }));
    const dependencies = {
      now: () => NOW,
      createRunId,
      render,
      prepareText: async () => sendText,
      prepareImage: async () => sendImage,
    };

    await expect(
      sendFixedRunReportTest({ projectRoot: root, dependencies }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);
    const first = checkpoint(root);
    expect(first.report.runId).toBe(FIRST_ID);
    expect(first.imagePath).toBe(
      `output/run-reports/2026-07-20/${FIRST_ID}.png`,
    );
    expect(statSync(checkpointPath(root)).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(checkpointPath(root))).mode & 0o777).toBe(0o700);

    await expect(
      sendFixedRunReportTest({ projectRoot: root, dependencies }),
    ).resolves.toMatchObject({ status: "sent", image: "sent" });
    expect(checkpoint(root).report.runId).toBe(FIRST_ID);
    expect(createRunId).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("reuses the checkpoint after sender preparation fails", async () => {
    const root = project();
    const createRunId = vi.fn(() => FIRST_ID);
    const render = vi.fn(({ report }: { report: RunReport }) => artifact(root, report));
    const prepareText = vi
      .fn()
      .mockRejectedValueOnce(new Error("private sender preparation path"))
      .mockResolvedValueOnce(async () => ({ status: "sent", chunks: 1 }));

    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId,
          render,
          prepareText,
          prepareImage: async () => async () => ({ status: "sent" }),
        },
      }),
    ).rejects.toThrow();
    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId,
          render,
          prepareText,
          prepareImage: async () => async () => ({ status: "sent" }),
        },
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(createRunId).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
  });

  it.each([
    ["indeterminate", new WechatDeliveryIndeterminateError(), RunReportDeliveryIndeterminateError],
    ["blocked", new WechatLoginExpiredError(), RunReportDeliveryBlockedError],
  ])("does not prepare senders for an existing %s ledger", async (_name, failure, expected) => {
    const root = project();
    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId: () => FIRST_ID,
          render: ({ report }) => artifact(root, report),
          prepareText: async () => async () => {
            throw failure;
          },
          prepareImage: async () => async () => ({ status: "sent" }),
        },
      }),
    ).rejects.toBeInstanceOf(failure.constructor);

    const prepareText = vi.fn();
    const prepareImage = vi.fn();
    await expect(
      sendFixedRunReportTest({
        projectRoot: root,
        dependencies: {
          now: () => NOW,
          createRunId: () => SECOND_ID,
          render: ({ report }) => artifact(root, report),
          prepareText,
          prepareImage,
        },
      }),
    ).rejects.toBeInstanceOf(expected);
    expect(prepareText).not.toHaveBeenCalled();
    expect(prepareImage).not.toHaveBeenCalled();
    expect(checkpoint(root).report.runId).toBe(FIRST_ID);
  });

  it("creates a new checkpoint on the explicit run after a confirmed send", async () => {
    const root = project();
    const ids = [FIRST_ID, SECOND_ID];
    const createRunId = vi.fn(() => ids.shift()!);
    const rendered: string[] = [];
    const dependencies = {
      now: () => NOW,
      createRunId,
      render: ({ report }: { report: RunReport }) => {
        rendered.push(report.runId);
        return artifact(root, report);
      },
      prepareText: async () => async () => ({ status: "sent" as const, chunks: 1 }),
      prepareImage: async () => async () => ({ status: "sent" as const }),
    };

    await sendFixedRunReportTest({ projectRoot: root, dependencies });
    expect(checkpoint(root).report.runId).toBe(FIRST_ID);
    await sendFixedRunReportTest({ projectRoot: root, dependencies });
    expect(checkpoint(root).report.runId).toBe(SECOND_ID);
    expect(rendered).toEqual([FIRST_ID, SECOND_ID]);
  });

  it("rejects malformed and symlink checkpoints with a safe error", async () => {
    for (const kind of ["malformed", "symlink"] as const) {
      const root = project();
      const path = checkpointPath(root);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(join(root, ".state"), 0o700);
      chmodSync(dirname(path), 0o700);
      const secret = join(root, "PRIVATE_CHECKPOINT_SENTINEL");
      if (kind === "malformed") {
        writeFileSync(path, `{ "secret": "${secret}"`, { mode: 0o600 });
      } else {
        writeFileSync(secret, "PRIVATE_CHECKPOINT_SENTINEL", { mode: 0o600 });
        symlinkSync(secret, path);
      }
      const render = vi.fn();
      let thrown: unknown;
      try {
        await sendFixedRunReportTest({
          projectRoot: root,
          dependencies: {
            now: () => NOW,
            createRunId: () => FIRST_ID,
            render,
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Invalid test-card checkpoint");
      expect(JSON.stringify(thrown)).not.toContain(secret);
      expect(String((thrown as Error).stack)).not.toContain(secret);
      expect(render).not.toHaveBeenCalled();
    }
  });
});
