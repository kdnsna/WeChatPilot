import { describe, expect, it, vi } from "vitest";

import {
  runObserverCli,
  type ObserverCliDependencies,
} from "../../src/cli/observer.js";
import type { RunReport } from "../../src/observer/run-report.js";

const ROOT = "/private/tmp/wechat-observer-cli";
const RUN_ID = "018f514c-1a2b-7abc-8def-1234567890ac";

function report(): RunReport {
  return {
    version: 1,
    runId: RUN_ID,
    taskId: "daily-tech-digest",
    taskName: "每日科技情报",
    projectLabel: "WeChatPilot",
    status: "success",
    startedAt: "2026-07-20T00:00:00.000Z",
    finishedAt: "2026-07-20T00:00:01.000Z",
    durationMs: 1_000,
    summary: ["任务完成"],
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

function io() {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

describe("observer CLI", () => {
  it("accepts only the fixed absolute-root job form and emits one minimal JSON line", async () => {
    const streams = io();
    const dependencies: ObserverCliDependencies = {
      run: vi.fn(async () => report()),
    };

    await expect(
      runObserverCli(
        ["--project-root", ROOT, "--job", "daily-tech-digest"],
        streams,
        dependencies,
      ),
    ).resolves.toBe(0);

    expect(streams.stderr).not.toHaveBeenCalled();
    expect(streams.stdout).toHaveBeenCalledOnce();
    expect(streams.stdout).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: true, status: "success", runId: "018f514c" })}\n`,
    );
  });

  it("accepts only the project-local runtime manifest path", async () => {
    const streams = io();
    const dependencies: ObserverCliDependencies = { run: vi.fn(async () => report()) };
    await expect(runObserverCli([
      "--project-root", ROOT, "--job", "daily-tech-digest",
      "--runtime-manifest", `${ROOT}/.state/runtime.json`,
    ], streams, dependencies)).resolves.toBe(0);
  });

  it.each([
    { arguments_: [] },
    { arguments_: ["--project-root", ROOT] },
    { arguments_: ["--project-root", ROOT, "--job", "other"] },
    {
      arguments_: [
        "--project-root",
        ROOT,
        "--job",
        "daily-tech-digest",
        "--command",
        "id",
      ],
    },
    {
      arguments_: [
        "--project-root",
        ROOT,
        "--job",
        "daily-tech-digest",
        "--cwd",
        ROOT,
      ],
    },
    {
      arguments_: [
        "--project-root",
        ROOT,
        "--job",
        "daily-tech-digest",
        "--recipient",
        "user",
      ],
    },
    {
      arguments_: [
        "--project-root",
        ROOT,
        "--job",
        "daily-tech-digest",
        "--extra",
      ],
    },
  ])("rejects unsupported arguments: $arguments_", async ({ arguments_ }) => {
    const streams = io();
    const dependencies: ObserverCliDependencies = {
      run: vi.fn(async () => report()),
    };
    await expect(
      runObserverCli(arguments_, streams, dependencies),
    ).resolves.toBe(1);
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(streams.stdout).not.toHaveBeenCalled();
    expect(streams.stderr).toHaveBeenCalledWith(
      `${JSON.stringify({ error: "ObserverCliUsageError", message: "inspect project logs" })}\n`,
    );
  });

  it("returns nonzero without exposing paths, tokens, user IDs, commands, or raw exceptions", async () => {
    const streams = io();
    const dependencies: ObserverCliDependencies = {
      run: vi.fn(async () => {
        throw new Error(
          `path=${ROOT} token=secret user_id=owner command=rm raw exception`,
        );
      }),
    };

    await expect(
      runObserverCli(
        ["--project-root", ROOT, "--job", "daily-tech-digest"],
        streams,
        dependencies,
      ),
    ).resolves.toBe(1);

    expect(streams.stdout).not.toHaveBeenCalled();
    const output = streams.stderr.mock.calls[0]![0] as string;
    expect(output).toBe(
      `${JSON.stringify({ error: "ObserverJobError", message: "inspect project logs" })}\n`,
    );
    expect(output).not.toContain(ROOT);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("owner");
    expect(output).not.toContain("rm");
    expect(output).not.toContain("raw exception");
  });
});
