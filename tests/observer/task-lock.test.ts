import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ObserverTaskBusyError,
  acquireObserverTaskLock,
} from "../../src/observer/task-lock.js";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-task-lock-"));
  roots.push(root);
  return root;
}

function lockPath(root: string): string {
  return join(root, ".state", "locks", "observer-daily-tech-digest.lock");
}

function writeLock(root: string, pid = 11_111): void {
  const directory = join(root, ".state", "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(join(root, ".state"), 0o700);
  chmodSync(directory, 0o700);
  writeFileSync(
    lockPath(root),
    `${JSON.stringify({
      pid,
      nonce: "existing-owner",
      createdAt: "2026-07-20T00:00:00.000Z",
      taskId: "daily-tech-digest",
    })}\n`,
    { mode: 0o600 },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("observer task lock", () => {
  it("accepts only the audited task id and never derives a filename from input", async () => {
    const root = project();
    await expect(
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "../private-task" as "daily-tech-digest",
      }),
    ).rejects.toThrow("Invalid observer task lock");
    expect(() => readFileSync(join(root, ".state", "private-task.lock"))).toThrow();
  });

  it("blocks a second owner while the recorded process is live", async () => {
    const root = project();
    const first = await acquireObserverTaskLock({
      projectRoot: root,
      taskId: "daily-tech-digest",
      pid: 11_111,
      isProcessAlive: () => true,
    });

    await expect(
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "daily-tech-digest",
        pid: 22_222,
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(ObserverTaskBusyError);

    await first.release();
  });

  it("reclaims a dead owner's lock and allows only one concurrent winner", async () => {
    const root = project();
    writeLock(root);

    const settled = await Promise.allSettled([
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "daily-tech-digest",
        pid: 22_222,
        isProcessAlive: (pid) => pid !== 11_111,
      }),
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "daily-tech-digest",
        pid: 33_333,
        isProcessAlive: (pid) => pid !== 11_111,
      }),
    ]);

    const winners = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(winners).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    await winners[0]!.release();
  });

  it("recovers a zero-byte crash residue with at most one concurrent winner", async () => {
    const root = project();
    const directory = join(root, ".state", "locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".state"), 0o700);
    chmodSync(directory, 0o700);
    writeFileSync(lockPath(root), "", { mode: 0o600 });

    const settled = await Promise.allSettled([
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "daily-tech-digest",
        pid: 22_222,
        isProcessAlive: (pid) => pid === 22_222 || pid === 33_333,
      }),
      acquireObserverTaskLock({
        projectRoot: root,
        taskId: "daily-tech-digest",
        pid: 33_333,
        isProcessAlive: (pid) => pid === 22_222 || pid === 33_333,
      }),
    ]);

    const winners = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(winners).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    await winners[0]!.release();
  });

  it("leaves neither canonical nor owner temp files after write or fsync failure", async () => {
    for (const failure of ["write", "fsync"] as const) {
      const root = project();
      await expect(
        acquireObserverTaskLock({
          projectRoot: root,
          taskId: "daily-tech-digest",
          dependencies: {
            ...(failure === "write"
              ? { writeFile: () => { throw new Error("private write failure"); } }
              : { fsync: () => { throw new Error("private fsync failure"); } }),
          },
        }),
      ).rejects.toThrow("Invalid observer task lock");

      expect(readdirSync(join(root, ".state", "locks"))).toEqual([]);
    }
  });

  it("never removes a replacement lock during release", async () => {
    const root = project();
    const lock = await acquireObserverTaskLock({
      projectRoot: root,
      taskId: "daily-tech-digest",
      pid: 11_111,
    });
    const replacement = `${lockPath(root)}.replacement`;
    writeFileSync(replacement, "replacement\n", { mode: 0o600 });
    renameSync(replacement, lockPath(root));

    await lock.release();

    expect(readFileSync(lockPath(root), "utf8")).toBe("replacement\n");
  });

  it("fails closed without opening a fifo, symlink, or wrong-mode lock", async () => {
    for (const kind of ["fifo", "symlink", "mode"] as const) {
      const root = project();
      const directory = join(root, ".state", "locks");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(join(root, ".state"), 0o700);
      chmodSync(directory, 0o700);
      if (kind === "fifo") {
        execFileSync("mkfifo", [lockPath(root)]);
        chmodSync(lockPath(root), 0o600);
      } else if (kind === "symlink") {
        const outside = join(root, "outside-lock");
        writeFileSync(outside, "private\n", { mode: 0o600 });
        symlinkSync(outside, lockPath(root));
      } else {
        writeLock(root);
        chmodSync(lockPath(root), 0o644);
      }

      await expect(
        Promise.race([
          acquireObserverTaskLock({
            projectRoot: root,
            taskId: "daily-tech-digest",
            isProcessAlive: () => false,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("lock read blocked")), 250),
          ),
        ]),
      ).rejects.toBeInstanceOf(ObserverTaskBusyError);
    }
  });
});
