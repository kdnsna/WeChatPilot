import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObserverJob } from "../../src/observer/config.js";
import {
  runManagedJob,
  type ManagedJobDependencies,
} from "../../src/observer/managed-job.js";

const job: ObserverJob = {
  id: "daily-tech-digest",
  name: "每日科技情报",
  projectLabel: "WeChatPilot",
  executable: "/opt/homebrew/opt/node@22/bin/node",
  entrypoint: "dist/src/cli/scheduled.js",
  arguments: ["--project-root", "{projectRoot}"],
  workingDirectory: ".",
  timeoutMs: 1_000,
  resultAdapter: "scheduled-digest-json-v1",
  allowedArtifactRoot: "output",
  notify: "always",
};

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-managed-job-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
}

function dependencies(
  spawn: NonNullable<ManagedJobDependencies["spawn"]>,
  overrides: Partial<ManagedJobDependencies> = {},
): ManagedJobDependencies {
  const startRunRecord = vi.fn(() => ({
    version: 1 as const,
    status: "running" as const,
    runId: "11111111-1111-4111-8111-111111111111",
    taskId: job.id,
    taskName: job.name,
    projectLabel: job.projectLabel,
    runnerPid: process.pid,
    startedAt: "2026-07-20T00:00:00.000Z",
  }));
  return {
    spawn,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    now: (() => {
      const values = [
        new Date("2026-07-20T00:00:00.000Z"),
        new Date("2026-07-20T00:00:01.000Z"),
      ];
      return () => values.shift() ?? new Date("2026-07-20T00:00:01.000Z");
    })(),
    startRunRecord,
    updateRunChildPid: vi.fn(),
    acquireTaskLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
    ...overrides,
  };
}

function complete(
  child: FakeChild,
  result: unknown,
  exitCode: number | null = 0,
): void {
  queueMicrotask(() => {
    child.emit("spawn");
    child.stdout.end(`${JSON.stringify(result)}\n`);
    child.stderr.end();
    child.emit("exit", exitCode, null);
    child.emit("close", exitCode, null);
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runManagedJob", () => {
  it("spawns only the audited executable and arguments with shell false", async () => {
    const root = project();
    const child = new FakeChild();
    const spawn = vi.fn((..._arguments: unknown[]) => {
      complete(child, {
        ok: true,
        status: "sent",
        date: "2026-07-20",
        chunks: 2,
        jobAttempt: 1,
        deliveryAttempt: 1,
      });
      return child;
    });
    const order: string[] = [];
    const deps = dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>, {
      startRunRecord: vi.fn((options) => {
        order.push("record");
        return {
          version: 1,
          status: "running",
          runId: options.runId,
          taskId: job.id,
          taskName: job.name,
          projectLabel: job.projectLabel,
          runnerPid: options.runnerPid,
          startedAt: options.startedAt.toISOString(),
        };
      }),
    });
    spawn.mockImplementationOnce((..._arguments: unknown[]) => {
      order.push("spawn");
      complete(child, {
        ok: true,
        status: "sent",
        date: "2026-07-20",
        chunks: 2,
        jobAttempt: 1,
        deliveryAttempt: 1,
      });
      return child;
    });

    const outcome = await runManagedJob({
      projectRoot: root,
      job,
      environment: {
        HOME: "/private/home",
        CODEX_HOME: "/private/codex",
        PATH: "/safe/bin",
        GITHUB_TOKEN: "github-token",
        PRIVATE_API_KEY: "must-not-pass",
      },
      dependencies: deps,
    });

    expect(order).toEqual(["record", "spawn"]);
    expect(spawn).toHaveBeenCalledWith(
      job.executable,
      [join(root, job.entrypoint), "--project-root", root],
      expect.objectContaining({
        cwd: root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: "/private/home",
          CODEX_HOME: "/private/codex",
          PATH: "/safe/bin",
          GITHUB_TOKEN: "github-token",
        },
      }),
    );
    expect(outcome.authority.status).toBe("success");
    expect(outcome.draft?.summary).toEqual(["今日日报已生成并发送"]);
    expect(deps.updateRunChildPid).toHaveBeenCalledWith({
      projectRoot: root,
      runId: "11111111-1111-4111-8111-111111111111",
      childPid: 4321,
    });
  });

  it("does not invent HOME or CODEX_HOME when the source omits them", async () => {
    const root = project();
    const child = new FakeChild();
    const spawn = vi.fn((..._arguments: unknown[]) => {
      complete(child, { ok: true, status: "not-due", date: "2026-07-20" });
      return child;
    });
    await runManagedJob({
      projectRoot: root,
      job,
      environment: { PATH: "/safe/bin" },
      dependencies: dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>),
    });
    const options = spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toEqual({ PATH: "/safe/bin" });
    expect("HOME" in options.env).toBe(false);
    expect("CODEX_HOME" in options.env).toBe(false);
  });

  it("rejects config overrides and path traversal before spawn", async () => {
    const root = project();
    const spawn = vi.fn();
    for (const override of [
      { executable: "/bin/sh" },
      { entrypoint: "../private.js" },
      { workingDirectory: "../private" },
      { arguments: ["-c", "private"] },
    ]) {
      await expect(
        runManagedJob({
          projectRoot: root,
          job: { ...job, ...override } as ObserverJob,
          dependencies: dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>),
        }),
      ).rejects.toThrow("Invalid managed observer job");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records an abort before spawn as cancelled without spawning", async () => {
    const root = project();
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();
    const deps = dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>);

    const outcome = await runManagedJob({
      projectRoot: root,
      job,
      signal: controller.signal,
      dependencies: deps,
    });

    expect(outcome.authority.status).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
    expect(deps.startRunRecord).toHaveBeenCalledOnce();
  });

  it("uses fixed failures for spawn errors and non-zero exits", async () => {
    const root = project();
    const spawnErrorChild = new FakeChild();
    const privateMarker = "PRIVATE_STDERR_SENTINEL";
    const spawnError = vi.fn(() => {
      queueMicrotask(() => spawnErrorChild.emit("error", new Error(privateMarker)));
      return spawnErrorChild;
    });
    const failedToSpawn = await runManagedJob({
      projectRoot: root,
      job,
      dependencies: dependencies(spawnError as NonNullable<ManagedJobDependencies["spawn"]>),
    });
    expect(failedToSpawn.authority.status).toBe("failed");
    expect(JSON.stringify(failedToSpawn)).not.toContain(privateMarker);

    const nonzeroChild = new FakeChild();
    const nonzeroSpawn = vi.fn(() => {
      queueMicrotask(() => {
        nonzeroChild.emit("spawn");
        nonzeroChild.stderr.end(privateMarker);
        nonzeroChild.stdout.end();
        nonzeroChild.emit("exit", 7, null);
        nonzeroChild.emit("close", 7, null);
      });
      return nonzeroChild;
    });
    const nonzero = await runManagedJob({
      projectRoot: root,
      job,
      dependencies: dependencies(nonzeroSpawn as NonNullable<ManagedJobDependencies["spawn"]>),
    });
    expect(nonzero.authority.status).toBe("failed");
    expect(JSON.stringify(nonzero)).not.toContain(privateMarker);
  });

  it("terminates oversized combined output and returns no raw output", async () => {
    const root = project();
    const child = new FakeChild();
    const privateMarker = "PRIVATE_OUTPUT_SENTINEL";
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.write(Buffer.alloc(700_000, "x"));
        child.stderr.write(Buffer.concat([
          Buffer.alloc(400_000, "y"),
          Buffer.from(privateMarker),
        ]));
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return child;
    });

    const outcome = await runManagedJob({
      projectRoot: root,
      job,
      dependencies: dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>),
    });

    expect(outcome.authority.status).toBe("failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(JSON.stringify(outcome)).not.toContain(privateMarker);
  });

  it("keeps the outcome and task lock pending after KILL until exit or close", async () => {
    vi.useFakeTimers();
    for (const reason of ["timeout", "abort"] as const) {
      const root = project();
      const child = new FakeChild();
      const spawn = vi.fn(() => child);
      const controller = new AbortController();
      const release = vi.fn(async () => undefined);
      const promise = runManagedJob({
        projectRoot: root,
        job,
        signal: controller.signal,
        dependencies: dependencies(
          spawn as NonNullable<ManagedJobDependencies["spawn"]>,
          { acquireTaskLock: vi.fn(async () => ({ release })) },
        ),
      });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      child.emit("spawn");
      if (reason === "timeout") {
        await vi.advanceTimersByTimeAsync(job.timeoutMs);
      } else {
        controller.abort();
      }
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(release).not.toHaveBeenCalled();

      if (reason === "timeout") {
        child.emit("exit", null, "SIGKILL");
      } else {
        child.emit("close", null, "SIGKILL");
      }
      await expect(promise).resolves.toMatchObject({
        authority: { status: reason === "timeout" ? "timed-out" : "cancelled" },
      });
      expect(settled).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      expect(child.listenerCount("spawn")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
    }
  });

  it("cleans terminal races so only the first terminal result wins", async () => {
    const root = project();
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const controller = new AbortController();
    const promise = runManagedJob({
      projectRoot: root,
      job,
      signal: controller.signal,
      dependencies: dependencies(spawn as NonNullable<ManagedJobDependencies["spawn"]>),
    });
    await Promise.resolve();
    await Promise.resolve();
    child.emit("spawn");
    child.stdout.end(
      `${JSON.stringify({ ok: true, status: "not-due", date: "2026-07-20" })}\n`,
    );
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    controller.abort();

    await expect(promise).resolves.toMatchObject({
      authority: { status: "skipped" },
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
