import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-scheduled-lock-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scheduled run lock", () => {
  it("allows only one live scheduled process at a time", async () => {
    const module = await import("../../src/app/scheduled-lock.js").catch(
      () => ({}),
    );
    const acquireScheduledRunLock = (
      module as {
        acquireScheduledRunLock?: (options: unknown) => Promise<{
          release: () => Promise<void>;
        }>;
      }
    ).acquireScheduledRunLock;
    const ScheduledRunBusyError = (
      module as { ScheduledRunBusyError?: new (...args: never[]) => Error }
    ).ScheduledRunBusyError;
    expect(acquireScheduledRunLock).toBeTypeOf("function");
    expect(ScheduledRunBusyError).toBeTypeOf("function");
    if (
      acquireScheduledRunLock === undefined ||
      ScheduledRunBusyError === undefined
    ) {
      return;
    }

    const root = project();
    const first = await acquireScheduledRunLock({
      projectRoot: root,
      pid: 11_111,
      isProcessAlive: () => true,
    });
    await expect(
      acquireScheduledRunLock({
        projectRoot: root,
        pid: 22_222,
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(ScheduledRunBusyError);

    await first.release();
    const second = await acquireScheduledRunLock({
      projectRoot: root,
      pid: 22_222,
      isProcessAlive: () => true,
    });
    await second.release();
  });

  it("recovers a private lock left by a process that is no longer alive", async () => {
    const { acquireScheduledRunLock } = await import(
      "../../src/app/scheduled-lock.js"
    );
    const root = project();
    const locksDirectory = join(root, ".state", "locks");
    mkdirSync(locksDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(locksDirectory, "scheduled.lock"),
      JSON.stringify({
        pid: 11_111,
        nonce: "stale-lock",
        createdAt: "2026-07-18T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    const lock = await acquireScheduledRunLock({
      projectRoot: root,
      pid: 22_222,
      isProcessAlive: () => false,
    });
    await lock.release();
  });
});
