import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ObserverJob } from "../../src/observer/config.js";
import type { RunReport } from "../../src/observer/run-report.js";
import {
  finishRunRecord,
  inspectRunState,
  listFinalRunReports,
  recoverInterruptedRuns,
  startRunRecord as startRunRecordRaw,
  updateRunChildPid as updateRunChildPidRaw,
  type StartRunRecordOptions,
  type UpdateRunChildPidOptions,
} from "../../src/observer/run-state.js";

const job: ObserverJob = {
  id: "daily-tech-digest",
  name: "每日科技情报",
  projectLabel: "WeChatPilot",
  executable: "/opt/homebrew/opt/node@22/bin/node",
  entrypoint: "dist/src/cli/scheduled.js",
  arguments: ["--project-root", "{projectRoot}"],
  workingDirectory: ".",
  timeoutMs: 1_200_000,
  resultAdapter: "scheduled-digest-json-v1",
  allowedArtifactRoot: "output",
  notify: "always",
};

const ids = {
  first: "11111111-1111-4111-8111-111111111111",
  main: "22222222-2222-4222-8222-222222222222",
  third: "33333333-3333-4333-8333-333333333333",
  fourth: "44444444-4444-4444-8444-444444444444",
  fifth: "55555555-5555-4555-8555-555555555555",
  sixth: "66666666-6666-4666-8666-666666666666",
  seventh: "77777777-7777-4777-8777-777777777777",
} as const;

const roots: string[] = [];

function identity(pid: number): string {
  return pid.toString(16).padStart(64, "0");
}

function startRunRecord(options: StartRunRecordOptions) {
  return startRunRecordRaw({ ...options, processIdentity: identity });
}

function updateRunChildPid(options: UpdateRunChildPidOptions) {
  return updateRunChildPidRaw({ ...options, processIdentity: identity });
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "wechatpilot-run-state-"));
  roots.push(directory);
  return directory;
}

function runsDirectory(projectRoot: string): string {
  return join(projectRoot, ".state", "observer", "runs");
}

function runPath(projectRoot: string, runId: string): string {
  return join(runsDirectory(projectRoot), `${runId}.json`);
}

function ensureRunsDirectory(projectRoot: string): void {
  const state = join(projectRoot, ".state");
  const observer = join(state, "observer");
  const runs = join(observer, "runs");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  for (const directory of [state, observer, runs]) {
    chmodSync(directory, 0o700);
  }
}

function writeRecord(
  projectRoot: string,
  fileName: string,
  value: unknown,
  mode = 0o600,
): string {
  ensureRunsDirectory(projectRoot);
  const path = join(runsDirectory(projectRoot), fileName);
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

function runningRecord(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: "running",
    runId,
    taskId: job.id,
    taskName: job.name,
    projectLabel: job.projectLabel,
    runnerPid: 1234,
    startedAt: "2026-07-19T01:00:00.000Z",
    ...overrides,
  };
}

function report(
  runId: string,
  startedAt = "2026-07-19T01:00:00.000Z",
  finishedAt = "2026-07-19T01:05:00.000Z",
): RunReport {
  return {
    version: 1,
    runId,
    taskId: job.id,
    taskName: job.name,
    projectLabel: job.projectLabel,
    status: "interrupted",
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    summary: ["任务已中断"],
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

function expectSafeFailure(operation: () => unknown): void {
  const privateMarker = "PRIVATE_RUN_STATE_SENTINEL";
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.getOwnPropertyNames(thrown as Error).map((name) => [
        name,
        String((thrown as unknown as Record<string, unknown>)[name]),
      ]),
    ),
  );
  expect(serialized).not.toContain(privateMarker);
  expect(serialized).not.toContain("wechatpilot-run-state-");
  expect((thrown as Error).message).toBe("Invalid observer run state");
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("observer run-state journal", () => {
  it("treats a clean checkout state directory as uninitialized observer state", () => {
    const projectRoot = root();
    const state = join(projectRoot, ".state");
    mkdirSync(state, { mode: 0o755 });
    chmodSync(state, 0o755);
    writeFileSync(join(state, ".gitkeep"), "", "utf8");

    expect(inspectRunState(projectRoot)).toEqual({
      recoveryPending: 0,
      invalidRecords: 0,
    });
    expect(listFinalRunReports(projectRoot)).toEqual([]);
    expect(
      recoverInterruptedRuns({ projectRoot, isProcessAlive: () => false }),
    ).toEqual({ recovered: [], activeTaskIds: [], invalidRecords: 0 });
    expect(statSync(state).mode & 0o777).toBe(0o755);
  });

  it("still rejects unsafe permissions once observer runs state exists", () => {
    const projectRoot = root();
    ensureRunsDirectory(projectRoot);
    chmodSync(join(projectRoot, ".state"), 0o755);

    expectSafeFailure(() => inspectRunState(projectRoot));
    expectSafeFailure(() => listFinalRunReports(projectRoot));
  });

  it("journals, updates, and recovers an interrupted run exactly once", () => {
    const projectRoot = root();
    const running = startRunRecord({
      projectRoot,
      runId: ids.main,
      job,
      runnerPid: 1234,
      startedAt: new Date("2026-07-19T01:00:00.000Z"),
    });

    expect(running.status).toBe("running");
    expect(running.runnerIdentity).toBe(identity(1234));
    expect(readdirSync(runsDirectory(projectRoot))).toEqual([`${ids.main}.json`]);
    expect(statSync(join(projectRoot, ".state")).mode & 0o777).toBe(0o700);
    expect(statSync(join(projectRoot, ".state", "observer")).mode & 0o777).toBe(0o700);
    expect(statSync(runsDirectory(projectRoot)).mode & 0o777).toBe(0o700);
    expect(statSync(runPath(projectRoot, ids.main)).mode & 0o777).toBe(0o600);

    expect(
      updateRunChildPid({
        projectRoot,
        runId: running.runId,
        childPid: 5678,
      }).childIdentity,
    ).toBe(identity(5678));
    expect(
      updateRunChildPid({
        projectRoot,
        runId: running.runId,
        childPid: 5678,
      }).childPid,
    ).toBe(5678);

    const first = recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T01:05:00.000Z"),
      isProcessAlive: () => false,
    });
    expect(first).toEqual({
      recovered: [
        {
          runId: ids.main,
          taskId: "daily-tech-digest",
          taskName: "每日科技情报",
          projectLabel: "WeChatPilot",
          status: "interrupted",
          startedAt: "2026-07-19T01:00:00.000Z",
          finishedAt: "2026-07-19T01:05:00.000Z",
        },
      ],
      activeTaskIds: [],
      invalidRecords: 0,
    });
    expect(JSON.parse(readFileSync(runPath(projectRoot, ids.main), "utf8"))).toEqual({
      version: 1,
      status: "recovery-pending",
      runId: ids.main,
      taskId: job.id,
      taskName: job.name,
      projectLabel: job.projectLabel,
      startedAt: "2026-07-19T01:00:00.000Z",
      finishedAt: "2026-07-19T01:05:00.000Z",
    });

    expect(
      recoverInterruptedRuns({
        projectRoot,
        now: () => new Date("2026-07-19T01:10:00.000Z"),
        isProcessAlive: () => false,
      }),
    ).toEqual({ recovered: [], activeTaskIds: [], invalidRecords: 0 });
  });

  it("stores only a SHA-256 identity for the current production runner", () => {
    const projectRoot = root();
    const running = startRunRecordRaw({
      projectRoot,
      runId: ids.main,
      job,
      runnerPid: process.pid,
      startedAt: new Date("2026-07-19T01:00:00.000Z"),
    });
    const persisted = JSON.parse(
      readFileSync(runPath(projectRoot, ids.main), "utf8"),
    ) as Record<string, unknown>;

    expect(running.runnerIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.runnerIdentity).toBe(running.runnerIdentity);
    expect(persisted).not.toHaveProperty("command");
    expect(JSON.stringify(persisted)).not.toContain(process.argv.join(" "));
  });

  it("keeps a task active when either runner or child is alive and de-duplicates ids", () => {
    const projectRoot = root();
    for (const [runId, runnerPid, childPid] of [
      [ids.first, 101, undefined],
      [ids.main, 201, 202],
      [ids.third, 301, 302],
    ] as const) {
      startRunRecord({
        projectRoot,
        runId,
        job,
        runnerPid,
        startedAt: new Date("2026-07-19T01:00:00.000Z"),
      });
      if (childPid !== undefined) {
        updateRunChildPid({ projectRoot, runId, childPid });
      }
    }

    const result = recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T01:05:00.000Z"),
      isProcessAlive: (pid) => pid === 101 || pid === 202 || pid === 302,
    });

    expect(result).toEqual({
      recovered: [],
      activeTaskIds: ["daily-tech-digest"],
      invalidRecords: 0,
    });
  });

  it("uses process identity to distinguish active processes from reused pids", () => {
    const projectRoot = root();
    for (const [runId, runnerPid, childPid] of [
      [ids.first, 101, 102],
      [ids.main, 201, 202],
      [ids.third, 301, 302],
    ] as const) {
      startRunRecord({
        projectRoot,
        runId,
        job,
        runnerPid,
        startedAt: new Date("2026-07-19T01:00:00.000Z"),
      });
      updateRunChildPid({ projectRoot, runId, childPid });
    }

    const result = recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T01:05:00.000Z"),
      isProcessAlive: (pid) => pid !== 301,
      processIdentity: (pid) => {
        if (pid === 102) return identity(pid);
        if (pid === 101 || pid === 201 || pid === 202 || pid === 302) {
          return "f".repeat(64);
        }
        return identity(pid);
      },
    });

    expect(result.activeTaskIds).toEqual([job.id]);
    expect(result.recovered.map(({ runId }) => runId)).toEqual([ids.main, ids.third]);
    const finalRecovery = recoverInterruptedRuns({
      projectRoot,
      isProcessAlive: () => false,
      processIdentity: identity,
    });
    expect(finalRecovery.recovered.map(({ runId }) => runId)).toEqual([ids.first]);
    expect(
      recoverInterruptedRuns({
        projectRoot,
        isProcessAlive: () => false,
        processIdentity: identity,
      }).recovered,
    ).toEqual([]);
  });

  it("keeps legacy records and identity probe failures conservatively active", () => {
    const projectRoot = root();
    writeRecord(projectRoot, `${ids.first}.json`, runningRecord(ids.first));
    writeRecord(
      projectRoot,
      `${ids.main}.json`,
      runningRecord(ids.main, { runnerIdentity: identity(1234) }),
    );

    const result = recoverInterruptedRuns({
      projectRoot,
      isProcessAlive: () => true,
      processIdentity: () => {
        throw new Error("PRIVATE_RAW_COMMAND_SENTINEL");
      },
    });

    expect(result).toEqual({
      recovered: [],
      activeTaskIds: [job.id],
      invalidRecords: 0,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RAW_COMMAND_SENTINEL");
  });

  it("rejects non-hash identities without persisting or exposing raw process data", () => {
    const projectRoot = root();
    expectSafeFailure(() =>
      startRunRecordRaw({
        projectRoot,
        runId: ids.main,
        job,
        runnerPid: 1234,
        startedAt: new Date("2026-07-19T01:00:00.000Z"),
        processIdentity: () => "PRIVATE_RUN_STATE_SENTINEL",
      }),
    );
    expect(readdirSync(projectRoot)).toEqual([]);
  });

  it("counts unsafe and invalid records without following, rewriting, or exposing them", () => {
    const projectRoot = root();
    const outside = root();
    ensureRunsDirectory(projectRoot);

    const symlinkTarget = join(outside, "PRIVATE_RUN_STATE_SENTINEL.json");
    writeFileSync(symlinkTarget, JSON.stringify(runningRecord(ids.first)), {
      mode: 0o600,
    });
    symlinkSync(symlinkTarget, runPath(projectRoot, ids.first));
    writeRecord(
      projectRoot,
      `${ids.main}.json`,
      runningRecord(ids.main),
      0o640,
    );
    const malformed = writeRecord(projectRoot, `${ids.third}.json`, "placeholder");
    writeFileSync(malformed, "{PRIVATE_RUN_STATE_SENTINEL", { mode: 0o600 });
    const oversized = writeRecord(projectRoot, `${ids.fourth}.json`, "placeholder");
    writeFileSync(oversized, Buffer.alloc(1_000_000, 0x61), { mode: 0o600 });
    writeRecord(
      projectRoot,
      `${ids.fifth}.json`,
      runningRecord(ids.fifth, { taskId: "PRIVATE_RUN_STATE_SENTINEL" }),
    );
    writeRecord(
      projectRoot,
      "not-a-private-sentinel-uuid.json",
      runningRecord(ids.sixth),
    );
    writeRecord(
      projectRoot,
      `${ids.seventh}.json`,
      runningRecord(ids.seventh, { childIdentity: identity(5678) }),
    );

    const result = recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T01:05:00.000Z"),
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ recovered: [], activeTaskIds: [], invalidRecords: 7 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RUN_STATE_SENTINEL");
    expect(readFileSync(symlinkTarget, "utf8")).toContain("running");
    expect(statSync(runPath(projectRoot, ids.main)).mode & 0o777).toBe(0o640);
    expect(readFileSync(malformed, "utf8")).toBe("{PRIVATE_RUN_STATE_SENTINEL");
    expect(statSync(oversized).size).toBe(1_000_000);
  });

  it("strictly parses a private running record before updating only its child pid", () => {
    const projectRoot = root();
    startRunRecord({
      projectRoot,
      runId: ids.main,
      job,
      runnerPid: 1234,
      startedAt: new Date("2026-07-19T01:00:00.000Z"),
    });
    writeRecord(
      projectRoot,
      `${ids.main}.json`,
      runningRecord(ids.main, { command: "PRIVATE_RUN_STATE_SENTINEL" }),
    );

    expectSafeFailure(() =>
      updateRunChildPid({ projectRoot, runId: ids.main, childPid: 5678 }),
    );
    expect(readFileSync(runPath(projectRoot, ids.main), "utf8")).toContain(
      "PRIVATE_RUN_STATE_SENTINEL",
    );
    expectSafeFailure(() =>
      updateRunChildPid({
        projectRoot,
        runId: "PRIVATE_RUN_STATE_SENTINEL",
        childPid: 5678,
      }),
    );
  });

  it("finishes only a matching running or recovery-pending authority", () => {
    const projectRoot = root();
    startRunRecord({
      projectRoot,
      runId: ids.main,
      job,
      runnerPid: 1234,
      startedAt: new Date("2026-07-19T01:00:00.000Z"),
    });
    const final = report(ids.main);
    finishRunRecord(projectRoot, final);
    expect(listFinalRunReports(projectRoot)).toEqual([final]);
    expectSafeFailure(() => finishRunRecord(projectRoot, final));

    startRunRecord({
      projectRoot,
      runId: ids.third,
      job,
      runnerPid: 3333,
      startedAt: new Date("2026-07-19T02:00:00.000Z"),
    });
    recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T02:05:00.000Z"),
      isProcessAlive: () => false,
    });
    const recoveredFinal = report(
      ids.third,
      "2026-07-19T02:00:00.000Z",
      "2026-07-19T02:05:00.000Z",
    );
    expectSafeFailure(() =>
      finishRunRecord(projectRoot, {
        ...recoveredFinal,
        status: "success",
      }),
    );
    expect(JSON.parse(readFileSync(runPath(projectRoot, ids.third), "utf8")).status).toBe(
      "recovery-pending",
    );
    finishRunRecord(projectRoot, recoveredFinal);
    expect(listFinalRunReports(projectRoot)).toEqual([final, recoveredFinal]);

    startRunRecord({
      projectRoot,
      runId: ids.fourth,
      job,
      runnerPid: 4444,
      startedAt: new Date("2026-07-19T03:00:00.000Z"),
    });
    expectSafeFailure(() =>
      finishRunRecord(projectRoot, {
        ...report(
          ids.fourth,
          "2026-07-19T03:00:00.000Z",
          "2026-07-19T03:05:00.000Z",
        ),
        taskName: "PRIVATE_RUN_STATE_SENTINEL",
      }),
    );
    expect(JSON.parse(readFileSync(runPath(projectRoot, ids.fourth), "utf8")).status).toBe(
      "running",
    );
  });

  it("lists only private final reports in stable order and inspects without details", () => {
    const projectRoot = root();
    const later = report(
      ids.main,
      "2026-07-19T02:00:00.000Z",
      "2026-07-19T02:05:00.000Z",
    );
    const earlier = report(
      ids.first,
      "2026-07-19T01:00:00.000Z",
      "2026-07-19T01:05:00.000Z",
    );
    for (const final of [later, earlier]) {
      startRunRecord({
        projectRoot,
        runId: final.runId,
        job,
        runnerPid: 1234,
        startedAt: new Date(final.startedAt),
      });
      finishRunRecord(projectRoot, final);
    }
    startRunRecord({
      projectRoot,
      runId: ids.third,
      job,
      runnerPid: 3333,
      startedAt: new Date("2026-07-19T03:00:00.000Z"),
    });
    startRunRecord({
      projectRoot,
      runId: ids.fourth,
      job,
      runnerPid: 4444,
      startedAt: new Date("2026-07-19T04:00:00.000Z"),
    });
    recoverInterruptedRuns({
      projectRoot,
      now: () => new Date("2026-07-19T04:05:00.000Z"),
      isProcessAlive: (pid) => pid === 3333,
    });
    writeRecord(projectRoot, `${ids.fifth}.json`, { invalid: true });

    expect(listFinalRunReports(projectRoot)).toEqual([earlier, later]);
    expect(inspectRunState(projectRoot)).toEqual({
      recoveryPending: 1,
      invalidRecords: 1,
    });
  });
});
