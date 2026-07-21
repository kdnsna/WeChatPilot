import { describe, expect, it, vi } from "vitest";

import { runObserverJob } from "../../src/app/observer.js";
import type { ObserverJob } from "../../src/observer/config.js";

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

describe("observer outbox isolation", () => {
  it("continues the current job when historical outbox delivery fails", async () => {
    const currentId = "018f514c-1a2b-7abc-8def-1234567890ac";
    const historical = {
      version: 1 as const,
      runId: "018f514c-1a2b-7abc-8def-1234567890ab",
      taskId: job.id,
      taskName: job.name,
      projectLabel: job.projectLabel,
      status: "success" as const,
      startedAt: "2026-07-20T00:00:00.000Z",
      finishedAt: "2026-07-20T00:00:01.000Z",
      durationMs: 1000,
      summary: ["old"],
      metrics: [],
      failure: null,
      artifacts: [],
    };
    const enqueueOutbox = vi.fn(() => ({
      version: 1 as const,
      kind: "run-report" as const,
      envelope: {
        version: 1 as const,
        id: historical.runId,
        channel: "run-report-text" as const,
        payloadSha256: "a".repeat(64),
        createdAt: "2026-07-20T00:00:00.000Z",
        priority: 10,
        attempt: 0,
        disposition: "missing" as const,
      },
      report: historical,
    }));
    const processOutbox = vi.fn(async () => {
      throw new Error("historical delivery exploded");
    });
    const deliver = vi.fn(async () => ({
      status: "sent" as const,
      textChunks: 1,
      image: "sent" as const,
      textAttempt: 1,
      imageAttempt: 1,
    }));

    const result = await runObserverJob({
      projectRoot: "/tmp/wechatpilot-observer-outbox",
      jobId: job.id,
      dependencies: {
        loadConfig: () => ({ version: 1, jobs: [job] }),
        recover: () => ({ recovered: [], activeTaskIds: [], invalidRecords: 0 }),
        listFinalReports: () => [historical],
        deliveryDisposition: () => "retryable",
        enqueueOutbox,
        processOutbox,
        acquireTaskLock: async () => ({ release: async () => undefined }),
        runJob: async () => ({
          authority: {
            runId: currentId,
            taskId: job.id,
            taskName: job.name,
            projectLabel: job.projectLabel,
            status: "success",
            startedAt: "2026-07-20T00:00:02.000Z",
            finishedAt: "2026-07-20T00:00:03.000Z",
          },
          draft: {
            version: 1,
            summary: ["current"],
            metrics: [],
            failure: null,
            artifacts: [],
          },
        }),
        normalize: ({ authority }) => ({
          version: 1,
          ...authority,
          durationMs: 1000,
          summary: ["current"],
          metrics: [],
          failure: null,
          artifacts: [],
        }),
        finishRecord: () => undefined,
        loadEditorial: () => ({ mode: "legacy" }) as never,
        render: ({ report }) => ({
          pngPath: `/tmp/${report.runId}.png`,
          jsonPath: `/tmp/${report.runId}.json`,
        }),
        prepareText: async () => async () => ({ status: "sent", chunks: 1 }),
        prepareImage: async () => async () => ({ status: "sent" }),
        deliver,
      },
    });

    expect(result.runId).toBe(currentId);
    expect(enqueueOutbox).toHaveBeenCalled();
    expect(processOutbox).toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ report: expect.objectContaining({ runId: currentId }) }),
    );
  });
});
