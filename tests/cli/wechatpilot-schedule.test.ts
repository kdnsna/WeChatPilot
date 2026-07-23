import { afterEach, describe, expect, it, vi } from "vitest";

import { runWechatPilot } from "../../src/cli/wechatpilot.js";

const originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

afterEach(() => {
  Intl.DateTimeFormat.prototype.resolvedOptions = originalResolved;
});

function mockHostTimezone(timeZone: string): void {
  Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions(
    this: Intl.DateTimeFormat,
  ) {
    return { ...originalResolved.call(this), timeZone };
  } as typeof originalResolved;
}

describe("wechatpilot schedule install contract", () => {
  it.each([
    ["--hour", "7"],
    ["--minute", "30"],
  ] as const)("rejects non-fixed schedule flag %s %s", async (flag, value) => {
    mockHostTimezone("Asia/Shanghai");
    await expect(
      runWechatPilot([
        "schedule",
        "install",
        "--project-root",
        process.cwd(),
        flag,
        value,
      ]),
    ).rejects.toThrow(/08:00 Asia\/Shanghai/i);
  });

  it("rejects a non-Shanghai host timezone", async () => {
    mockHostTimezone("UTC");
    await expect(
      runWechatPilot([
        "schedule",
        "install",
        "--project-root",
        process.cwd(),
        "--hour",
        "8",
        "--minute",
        "0",
      ]),
    ).rejects.toThrow(/Host system timezone must be Asia\/Shanghai/i);
  });

  it("rejects a non-Shanghai requested timezone", async () => {
    mockHostTimezone("Asia/Shanghai");
    await expect(
      runWechatPilot([
        "schedule",
        "install",
        "--project-root",
        process.cwd(),
        "--timezone",
        "UTC",
      ]),
    ).rejects.toThrow(/Asia\/Shanghai/i);
  });
});
