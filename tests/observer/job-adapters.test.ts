import { describe, expect, it } from "vitest";

import { parseScheduledDigestResult } from "../../src/observer/job-adapters.js";

describe("parseScheduledDigestResult", () => {
  it("maps the exact sent result to a success draft", () => {
    expect(
      parseScheduledDigestResult(
        `${JSON.stringify({
          ok: true,
          status: "sent",
          date: "2026-07-20",
          chunks: 3,
          jobAttempt: 2,
          deliveryAttempt: 1,
        })}\n`,
      ),
    ).toEqual({
      status: "success",
      draft: {
        version: 1,
        summary: ["今日日报已生成并发送"],
        metrics: [
          { label: "日期", value: "2026-07-20" },
          { label: "消息分段", value: "3" },
          { label: "任务尝试", value: "2" },
          { label: "发送尝试", value: "1" },
        ],
        failure: null,
        artifacts: [],
      },
    });
  });

  it("maps not-due and already-sent to skipped with status-specific fields", () => {
    expect(
      parseScheduledDigestResult(
        JSON.stringify({ ok: true, status: "not-due", date: "2026-07-20" }),
      ),
    ).toMatchObject({
      status: "skipped",
      draft: {
        metrics: [{ label: "日期", value: "2026-07-20" }],
        artifacts: [],
      },
    });
    expect(
      parseScheduledDigestResult(
        JSON.stringify({
          ok: true,
          status: "already-sent",
          date: "2026-07-20",
          jobAttempt: 2,
        }),
      ),
    ).toMatchObject({
      status: "skipped",
      draft: {
        metrics: [
          { label: "日期", value: "2026-07-20" },
          { label: "任务尝试", value: "2" },
        ],
        artifacts: [],
      },
    });
  });

  it.each([
    "",
    "{}",
    '{"ok":false,"status":"sent","date":"2026-07-20","chunks":1,"jobAttempt":1,"deliveryAttempt":1}',
    '{"ok":true,"status":"sent","date":"2026-02-30","chunks":1,"jobAttempt":1,"deliveryAttempt":1}',
    '{"ok":true,"status":"sent","date":"2026-07-20","chunks":0,"jobAttempt":1,"deliveryAttempt":1}',
    '{"ok":true,"status":"sent","date":"2026-07-20","chunks":1,"jobAttempt":1}',
    '{"ok":true,"status":"not-due","date":"2026-07-20","jobAttempt":1}',
    '{"ok":true,"status":"already-sent","date":"2026-07-20"}',
    '{"ok":true,"status":"sent","date":"2026-07-20","chunks":1,"jobAttempt":1,"deliveryAttempt":1,"extra":"private"}',
    ' {"ok":true,"status":"not-due","date":"2026-07-20"}',
    '{"ok":true,"status":"not-due","date":"2026-07-20"}\n\n',
    '{"ok":true,"status":"not-due","date":"2026-07-20"}\n{"private":true}',
  ])("rejects malformed, unsafe, or non-exact stdout without echoing it: %j", (stdout) => {
    let thrown: unknown;
    try {
      parseScheduledDigestResult(stdout);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid scheduled digest result");
    expect("cause" in (thrown as Error)).toBe(false);
    expect((thrown as Error).stack).toBe(
      "Error: Invalid scheduled digest result",
    );
  });

  it("enforces the 64 KiB byte limit", () => {
    expect(() => parseScheduledDigestResult("x".repeat(64 * 1024 + 1))).toThrow(
      "Invalid scheduled digest result",
    );
  });
});
