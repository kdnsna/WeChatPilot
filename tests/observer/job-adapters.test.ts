import { describe, expect, it } from "vitest";

import { parseScheduledDigestResult } from "../../src/observer/job-adapters.js";
import { EditorialReportPayloadSchema } from "../../src/report/editorial.js";
import { validEditorialPayload } from "../helpers/editorial.js";

const editorial = validEditorialPayload();

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
          editorial,
        })}\n`,
      ),
    ).toEqual({
      statusOverride: "success",
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
        editorial,
      },
    });
  });

  it("maps not-due and already-sent to skipped with status-specific fields", () => {
    const notDue = parseScheduledDigestResult(
      JSON.stringify({ ok: true, status: "not-due", date: "2026-07-20" }),
    );
    expect(notDue).toMatchObject({
      statusOverride: "skipped",
      draft: {
        summary: ["尚未到每日发送时间，本次跳过"],
        editorial: {
          kind: "status",
          highlights: expect.any(Array),
          actions: expect.any(Array),
        },
      },
    });
    const notDueEditorial = EditorialReportPayloadSchema.parse(
      notDue.draft.editorial,
    );
    expect(notDueEditorial.highlights).toHaveLength(5);
    expect(notDueEditorial.actions).toHaveLength(3);
    const alreadySent = parseScheduledDigestResult(
      JSON.stringify({
        ok: true,
        status: "already-sent",
        date: "2026-07-20",
        jobAttempt: 2,
      }),
    );
    expect(alreadySent).toMatchObject({
      statusOverride: "skipped",
      draft: {
        summary: ["今日日报已发送，本次跳过"],
        editorial: {
          kind: "status",
          highlights: expect.any(Array),
          actions: expect.any(Array),
        },
      },
    });
    const alreadySentEditorial = EditorialReportPayloadSchema.parse(
      alreadySent.draft.editorial,
    );
    expect(alreadySentEditorial.highlights).toHaveLength(5);
    expect(alreadySentEditorial.actions).toHaveLength(3);
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
