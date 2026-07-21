import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runObserverJob,
  type ObserverDependencies,
} from "../../src/app/observer.js";
import {
  deliverRunReport,
  runDeliveryDisposition,
} from "../../src/delivery/run-report-delivery.js";
import { WechatDeliveryRejectedError } from "../../src/delivery/wechat.js";
import type { ObserverConfig, ObserverJob } from "../../src/observer/config.js";
import type { EditorialConfig } from "../../src/observer/editorial-config.js";
import { ObserverTaskBusyError } from "../../src/observer/task-lock.js";
import type { PreparedReportVisual } from "../../src/observer/report-visual.js";
import type {
  RunAuthority,
  RunReport,
} from "../../src/observer/run-report.js";
import {
  listFinalRunReports,
  recoverInterruptedRuns,
  startRunRecord,
  updateRunChildPid,
} from "../../src/observer/run-state.js";
import { renderReportCard } from "../../src/observer/report-card.js";
import { validEditorialPayload } from "../helpers/editorial.js";

const ROOT = "/private/tmp/wechat-observer-test";
const RECOVERED_ID = "018f514c-1a2b-7abc-8def-1234567890ab";
const CURRENT_ID = "018f514c-1a2b-7abc-8def-1234567890ac";
const roots: string[] = [];

function processIdentity(pid: number): string {
  return pid.toString(16).padStart(64, "0");
}

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wechat-observer-app-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const job: ObserverJob = {
  id: "daily-tech-digest",
  name: "每日科技情报",
  projectLabel: "WeChatPilot",
  executable: "/path/to/node",
  entrypoint: "dist/src/cli/scheduled.js",
  arguments: ["--project-root", "{projectRoot}"],
  workingDirectory: ".",
  timeoutMs: 1_200_000,
  resultAdapter: "scheduled-digest-json-v1",
  allowedArtifactRoot: "output",
  notify: "always",
};

const config: ObserverConfig = { version: 1, jobs: [job] };
const editorialConfig = {
  mode: "editorial",
  generation: { timeoutMs: 180_000, maximumAttempts: 3 },
  style: { version: "editorial-v1", heroHeight: 480 },
} as EditorialConfig;

function authority(
  runId: string,
  status: RunAuthority["status"] = "success",
): RunAuthority {
  return {
    runId,
    taskId: job.id,
    taskName: job.name,
    projectLabel: job.projectLabel,
    status,
    startedAt: "2026-07-20T00:00:00.000Z",
    finishedAt: "2026-07-20T00:00:01.000Z",
  };
}

function report(
  runId: string,
  status: RunAuthority["status"] = "success",
  summary = "任务完成",
): RunReport {
  return {
    version: 1,
    ...authority(runId, status),
    durationMs: 1_000,
    summary: [summary],
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

function editorialReport(runId: string): RunReport {
  return {
    ...report(runId),
    editorial: validEditorialPayload(),
  };
}

function numberedEditorialReport(runId: string): RunReport {
  return {
    ...editorialReport(runId),
    issueNumber: 7,
    issueLabel: "WP-000007",
  };
}

const preparedVisual: PreparedReportVisual = {
  mode: "generated",
  attempts: 1,
  heroPath: `${ROOT}/output/${CURRENT_ID}.hero.png`,
  heroSha256: "a".repeat(64),
  styleVersion: "editorial-v1",
  promptSha256: "b".repeat(64),
};

function dependencies(
  overrides: Partial<ObserverDependencies> = {},
): ObserverDependencies {
  return {
    loadConfig: vi.fn(() => config),
    recover: vi.fn(() => ({
      recovered: [],
      activeTaskIds: [],
      invalidRecords: 0,
    })),
    listFinalReports: vi.fn(() => []),
    deliveryDisposition: vi.fn(() => "missing" as const),
    acquireTaskLock: vi.fn(async () => ({
      release: vi.fn(async () => undefined),
    })),
    runJob: vi.fn(async () => ({
      authority: authority(CURRENT_ID),
      draft: {
        version: 1 as const,
        summary: ["任务完成"],
        metrics: [],
        failure: null,
        artifacts: [],
      },
    })),
    normalize: vi.fn(({ authority: value }) => report(value.runId, value.status)),
    finishRecord: vi.fn(() => undefined),
    loadEditorial: vi.fn(() => editorialConfig),
    assignIssue: vi.fn(async () => ({ number: 7, label: "WP-000007" })),
    attachIssue: vi.fn((value) => ({
      ...value,
      issueNumber: 7,
      issueLabel: "WP-000007",
    })),
    replaceFinalRecord: vi.fn(() => undefined),
    prepareVisual: vi.fn(async () => preparedVisual),
    renderEditorial: vi.fn(({ report: value, visual }) => ({
      pngPath: `${ROOT}/output/${value.runId}.png`,
      jsonPath: `${ROOT}/output/${value.runId}.json`,
      issueLabel: value.issueLabel!,
      visualMode: visual.mode,
    })),
    render: vi.fn(({ report: value }) => ({
      pngPath: `${ROOT}/output/${value.runId}.png`,
      jsonPath: `${ROOT}/output/${value.runId}.json`,
    })),
    prepareText: vi.fn(
      async () => async () => ({ status: "sent" as const, chunks: 1 }),
    ),
    prepareImage: vi.fn(
      async () => async () => ({ status: "sent" as const }),
    ),
    deliver: vi.fn(async () => ({
      status: "sent" as const,
      textChunks: 1,
      image: "sent" as const,
      textAttempt: 1,
      imageAttempt: 1,
    })),
    createLogger: vi.fn(() => ({
      log: vi.fn(async () => undefined),
      debug: vi.fn(async () => undefined),
      info: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
      error: vi.fn(async () => undefined),
    })),
    ...overrides,
  };
}

describe("observer orchestration", () => {
  it("orders numbering, visual preparation, rendering, and delivery after finalization", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      normalize: vi.fn(() => editorialReport(CURRENT_ID)),
      finishRecord: vi.fn(() => calls.push("finish-record")),
      assignIssue: vi.fn(async () => {
        calls.push("assign-issue");
        return { number: 7, label: "WP-000007" };
      }),
      attachIssue: vi.fn((value, issue) => ({
        ...value,
        issueNumber: issue.number,
        issueLabel: issue.label,
      })),
      replaceFinalRecord: vi.fn(() => calls.push("persist-numbered-report")),
      prepareVisual: vi.fn(async () => {
        calls.push("prepare-visual");
        return preparedVisual;
      }),
      renderEditorial: vi.fn(({ report: value, visual }) => {
        calls.push("render-card");
        return {
          pngPath: `${ROOT}/output/${value.runId}.png`,
          jsonPath: `${ROOT}/output/${value.runId}.json`,
          issueLabel: value.issueLabel!,
          visualMode: visual.mode,
        };
      }),
      prepareText: vi.fn(async () => {
        calls.push("prepare-text");
        return async () => ({ status: "sent" as const, chunks: 1 });
      }),
      prepareImage: vi.fn(async () => {
        calls.push("prepare-image");
        return async () => ({ status: "sent" as const });
      }),
      deliver: vi.fn(async () => {
        calls.push("deliver");
        return {
          status: "sent" as const,
          textChunks: 1,
          image: "sent" as const,
          textAttempt: 1,
          imageAttempt: 1,
        };
      }),
    });

    const result = await runObserverJob({
      projectRoot: ROOT,
      jobId: job.id,
      dependencies: deps,
    });

    expect(result).toEqual(numberedEditorialReport(CURRENT_ID));
    expect(calls).toEqual([
      "finish-record",
      "assign-issue",
      "persist-numbered-report",
      "prepare-visual",
      "render-card",
      "prepare-text",
      "prepare-image",
      "deliver",
    ]);
  });

  it("assigns an issue but skips Image 2 in emergency legacy mode", async () => {
    const legacyConfig = { ...editorialConfig, mode: "legacy" as const };
    const deps = dependencies({
      normalize: vi.fn(() => editorialReport(CURRENT_ID)),
      loadEditorial: vi.fn(() => legacyConfig),
    });

    const result = await runObserverJob({
      projectRoot: ROOT,
      jobId: job.id,
      dependencies: deps,
    });

    expect(result).toEqual(numberedEditorialReport(CURRENT_ID));
    expect(deps.assignIssue).toHaveBeenCalledOnce();
    expect(deps.replaceFinalRecord).toHaveBeenCalledOnce();
    expect(deps.prepareVisual).not.toHaveBeenCalled();
    expect(deps.renderEditorial).not.toHaveBeenCalled();
    expect(deps.render).toHaveBeenCalledWith({
      projectRoot: ROOT,
      report: numberedEditorialReport(CURRENT_ID),
    });
  });

  it("runs recovery, the managed job, finalization, rendering, delivery, and one outer lock release in exact order", async () => {
    const calls: string[] = [];
    const release = vi.fn(async () => {
      calls.push("release-task-lock");
    });
    const recovered = authority(RECOVERED_ID, "interrupted");
    const current = authority(CURRENT_ID);
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        calls.push("load-config");
        return config;
      }),
      recover: vi.fn(() => {
        calls.push("recover");
        return { recovered: [recovered], activeTaskIds: [], invalidRecords: 0 };
      }),
      acquireTaskLock: vi.fn(async () => {
        calls.push("acquire-task-lock");
        return { release };
      }),
      runJob: vi.fn(async (options) => {
        calls.push("run-job");
        const innerLock = await options.dependencies?.acquireTaskLock?.({
          projectRoot: ROOT,
          taskId: job.id,
        });
        await innerLock?.release();
        return { authority: current, draft: null };
      }),
      normalize: vi.fn((options) => {
        if (options.authority.runId === CURRENT_ID) {
          calls.push("normalize");
        } else {
          expect(options.draft).toMatchObject({
            version: 1,
            summary: ["任务因主机或进程中断，已在恢复后补记"],
            metrics: [],
            failure: null,
            artifacts: [],
            editorial: {
              kind: "status",
              highlights: Array.from({ length: 5 }, () =>
                expect.objectContaining({
                  confidence: "high",
                  impact: "medium",
                }),
              ),
              actions: Array.from({ length: 3 }, () => expect.any(String)),
              audit: { scheduledDate: "2026-07-20" },
            },
          });
        }
        return report(
          options.authority.runId,
          options.authority.status,
          options.authority.runId === RECOVERED_ID
            ? "任务因主机或进程中断，已在恢复后补记"
            : "任务完成",
        );
      }),
      finishRecord: vi.fn((_projectRoot, value) => {
        if (value.runId === CURRENT_ID) {
          calls.push("finish-record");
        }
      }),
      render: vi.fn(({ report: value }) => {
        if (value.runId === CURRENT_ID) {
          calls.push("render");
        }
        return {
          pngPath: `${ROOT}/output/${value.runId}.png`,
          jsonPath: `${ROOT}/output/${value.runId}.json`,
        };
      }),
      prepareText: vi.fn(async ({ report: value }) => {
        if (value.runId === CURRENT_ID) {
          calls.push("prepare-text");
        }
        return async () => ({ status: "sent" as const, chunks: 1 });
      }),
      prepareImage: vi.fn(async ({ report: value }) => {
        if (value.runId === CURRENT_ID) {
          calls.push("prepare-image");
        }
        return async () => ({ status: "sent" as const });
      }),
      deliver: vi.fn(async ({ report: value }) => {
        calls.push(value.runId === RECOVERED_ID ? "deliver-recovered" : "deliver-current");
        return {
          status: "sent" as const,
          textChunks: 1,
          image: "sent" as const,
          textAttempt: 1,
          imageAttempt: 1,
        };
      }),
    });

    await expect(
      runObserverJob({
        projectRoot: ROOT,
        jobId: "daily-tech-digest",
        dependencies: deps,
      }),
    ).resolves.toEqual(report(CURRENT_ID));
    expect(calls).toEqual([
      "load-config",
      "recover",
      "deliver-recovered",
      "acquire-task-lock",
      "run-job",
      "normalize",
      "finish-record",
      "render",
      "prepare-text",
      "prepare-image",
      "deliver-current",
      "release-task-lock",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("skips recovered delivery when recovery and the final outbox are empty", async () => {
    const deps = dependencies();

    await runObserverJob({
      projectRoot: ROOT,
      jobId: job.id,
      dependencies: deps,
    });

    expect(deps.deliver).toHaveBeenCalledOnce();
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ report: expect.objectContaining({ runId: CURRENT_ID }) }),
    );
  });

  it("reconciles only missing and retryable final reports before starting a new run", async () => {
    const reports = [
      report("018f514c-1a2b-7abc-8def-1234567890b1"),
      report("018f514c-1a2b-7abc-8def-1234567890b2"),
      report("018f514c-1a2b-7abc-8def-1234567890b3"),
      report("018f514c-1a2b-7abc-8def-1234567890b4"),
      report("018f514c-1a2b-7abc-8def-1234567890b5"),
    ];
    const dispositions = [
      "missing",
      "retryable",
      "sent",
      "indeterminate",
      "blocked",
    ] as const;
    const calls: string[] = [];
    const deps = dependencies({
      listFinalReports: vi.fn(() => reports),
      deliveryDisposition: vi.fn(({ report: value }) =>
        dispositions[reports.findIndex((candidate) => candidate.runId === value.runId)]!,
      ),
      runJob: vi.fn(async () => {
        calls.push("run-job");
        return { authority: authority(CURRENT_ID), draft: null };
      }),
      deliver: vi.fn(async ({ report: value }) => {
        calls.push(value.runId);
        return {
          status: "sent" as const,
          textChunks: 1,
          image: "sent" as const,
          textAttempt: 1,
          imageAttempt: 1,
        };
      }),
    });

    await runObserverJob({ projectRoot: ROOT, jobId: job.id, dependencies: deps });

    expect(calls).toEqual([reports[0]!.runId, reports[1]!.runId, "run-job", CURRENT_ID]);
  });

  it("refuses a new run when the old runner is dead but its child is still alive", async () => {
    const root = projectRoot();
    startRunRecord({
      projectRoot: root,
      runId: RECOVERED_ID,
      job,
      runnerPid: 700_001,
      startedAt: new Date("2026-07-20T00:00:00.000Z"),
      processIdentity,
    });
    updateRunChildPid({
      projectRoot: root,
      runId: RECOVERED_ID,
      childPid: 700_002,
      processIdentity,
    });
    const deps = dependencies({
      recover: vi.fn((options) =>
        recoverInterruptedRuns({
          ...options,
          isProcessAlive: (pid) => pid === 700_002,
          processIdentity,
        }),
      ),
    });

    await expect(
      runObserverJob({ projectRoot: root, jobId: job.id, dependencies: deps }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);
    expect(deps.acquireTaskLock).not.toHaveBeenCalled();
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it("keeps delivery missing when rendering fails and logs only a stable code", async () => {
    const logger = {
      log: vi.fn(async () => undefined),
      debug: vi.fn(async () => undefined),
      info: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
      error: vi.fn(async () => undefined),
    };
    const deps = dependencies({
      render: vi.fn(() => {
        throw new Error("token=must-not-enter-log");
      }),
      createLogger: vi.fn(() => logger),
    });

    let thrown: unknown;
    try {
      await runObserverJob({ projectRoot: ROOT, jobId: job.id, dependencies: deps });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      message: "Unable to prepare observer report image",
    });
    expect(JSON.stringify(thrown)).not.toContain("must-not-enter-log");
    expect(logger.error).toHaveBeenCalledWith("OBSERVER_REPORT_RENDER_FAILED");
    expect(deps.prepareText).not.toHaveBeenCalled();
    expect(deps.prepareImage).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("reuses a numbered editorial visual for retryable outbox delivery", async () => {
    const value = numberedEditorialReport(RECOVERED_ID);
    const deps = dependencies({
      recover: vi.fn(() => ({
        recovered: [],
        activeTaskIds: [job.id],
        invalidRecords: 0,
      })),
      listFinalReports: vi.fn(() => [value]),
      deliveryDisposition: vi.fn(() => "retryable" as const),
    });

    await expect(
      runObserverJob({ projectRoot: ROOT, jobId: job.id, dependencies: deps }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);

    expect(deps.assignIssue).not.toHaveBeenCalled();
    expect(deps.replaceFinalRecord).not.toHaveBeenCalled();
    expect(deps.prepareVisual).toHaveBeenCalledOnce();
    expect(deps.renderEditorial).toHaveBeenCalledOnce();
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("does not regenerate, render, or send an indeterminate outbox report", async () => {
    const value = numberedEditorialReport(RECOVERED_ID);
    const deps = dependencies({
      recover: vi.fn(() => ({
        recovered: [],
        activeTaskIds: [job.id],
        invalidRecords: 0,
      })),
      listFinalReports: vi.fn(() => [value]),
      deliveryDisposition: vi.fn(() => "indeterminate" as const),
    });

    await expect(
      runObserverJob({ projectRoot: ROOT, jobId: job.id, dependencies: deps }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);

    expect(deps.assignIssue).not.toHaveBeenCalled();
    expect(deps.prepareVisual).not.toHaveBeenCalled();
    expect(deps.renderEditorial).not.toHaveBeenCalled();
    expect(deps.prepareText).not.toHaveBeenCalled();
    expect(deps.prepareImage).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("reuses the real card after an image rejection and reconciles without resending text", async () => {
    const root = projectRoot();
    const value = report(CURRENT_ID);
    const sendText = vi.fn(async () => ({ status: "sent" as const, chunks: 1 }));
    const sendImage = vi
      .fn<(_: string) => Promise<{ status: "sent" }>>()
      .mockRejectedValueOnce(new WechatDeliveryRejectedError())
      .mockResolvedValueOnce({ status: "sent" });
    const shared = {
      loadConfig: vi.fn(() => config),
      render: renderReportCard,
      prepareText: vi.fn(async () => sendText),
      prepareImage: vi.fn(async () => sendImage),
      deliver: deliverRunReport,
      deliveryDisposition: runDeliveryDisposition,
    };

    await expect(
      runObserverJob({
        projectRoot: root,
        jobId: job.id,
        dependencies: dependencies({
          ...shared,
          runJob: vi.fn(async () => ({ authority: authority(CURRENT_ID), draft: null })),
          normalize: vi.fn(() => value),
        }),
      }),
    ).rejects.toBeInstanceOf(WechatDeliveryRejectedError);

    await expect(
      runObserverJob({
        projectRoot: root,
        jobId: job.id,
        dependencies: dependencies({
          ...shared,
          recover: vi.fn(() => ({
            recovered: [],
            activeTaskIds: [job.id],
            invalidRecords: 0,
          })),
          listFinalReports: vi.fn(() => [value]),
        }),
      }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendImage).toHaveBeenCalledTimes(2);
    expect(runDeliveryDisposition({ projectRoot: root, report: value })).toBe("sent");
  });

  it("normalizes an invalid draft to the minimal report", async () => {
    const withNormalizer = dependencies({
      runJob: vi.fn(async () => ({
        authority: authority(CURRENT_ID),
        draft: { command: "unsafe", summary: [] } as never,
      })),
    });
    const { normalize: _normalize, ...deps } = withNormalizer;

    const result = await runObserverJob({
      projectRoot: ROOT,
      jobId: job.id,
      dependencies: deps,
    });

    expect(result.summary).toEqual(["任务已完成，未提供结构化业务摘要"]);
  });

  it("keeps the real final record and releases the outer lock when current delivery fails", async () => {
    const root = projectRoot();
    const release = vi.fn(async () => undefined);
    const withMockFinish = dependencies({
      acquireTaskLock: vi.fn(async () => ({ release })),
      runJob: vi.fn(async () => {
        startRunRecord({
          projectRoot: root,
          runId: CURRENT_ID,
          job,
          runnerPid: process.pid,
          startedAt: new Date("2026-07-20T00:00:00.000Z"),
          processIdentity,
        });
        return { authority: authority(CURRENT_ID), draft: null };
      }),
      deliver: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    });
    const { finishRecord: _finishRecord, ...deps } = withMockFinish;

    await expect(
      runObserverJob({ projectRoot: root, jobId: job.id, dependencies: deps }),
    ).rejects.toThrow("delivery failed");
    expect(listFinalRunReports(root)).toEqual([report(CURRENT_ID)]);
    expect(release).toHaveBeenCalledOnce();
  });
});
