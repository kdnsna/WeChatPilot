import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-scheduled-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scheduled CLI", () => {
  it("reports a safe success summary and always releases the run lock", async () => {
    const module = await import("../../src/cli/scheduled.js").catch(() => ({}));
    const runScheduledCli = (
      module as {
        runScheduledCli?: (...args: readonly unknown[]) => Promise<number>;
      }
    ).runScheduledCli;
    expect(runScheduledCli).toBeTypeOf("function");
    if (runScheduledCli === undefined) {
      return;
    }
    const stdout = vi.fn();
    const stderr = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      runScheduledCli(
        ["--project-root", project()],
        { stdout, stderr },
        {
          acquireLock: vi.fn(async () => ({ release })),
          run: vi.fn(async () => ({
            status: "sent" as const,
            date: "2026-07-19",
            chunks: 2,
            jobAttempt: 1,
            deliveryAttempt: 1,
          })),
        },
      ),
    ).resolves.toBe(0);
    expect(release).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toEqual({
      ok: true,
      status: "sent",
      date: "2026-07-19",
      chunks: 2,
      jobAttempt: 1,
      deliveryAttempt: 1,
    });
  });

  it("does not expose a thrown secret and still releases the run lock", async () => {
    const { runScheduledCli } = await import("../../src/cli/scheduled.js");
    const stdout = vi.fn();
    const stderr = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      runScheduledCli(
        ["--project-root", project()],
        { stdout, stderr },
        {
          acquireLock: vi.fn(async () => ({ release })),
          run: vi.fn(async () => {
            throw new Error("bot_token=must-not-leak");
          }),
        },
      ),
    ).resolves.toBe(1);
    expect(release).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
    const output = stderr.mock.calls[0]![0] as string;
    expect(output).not.toContain("must-not-leak");
    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: "Error",
      message: "scheduled digest failed; inspect the project logs",
    });
  });
});
