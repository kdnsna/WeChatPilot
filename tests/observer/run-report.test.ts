import { describe, expect, it } from "vitest";

import {
  RunStatusSchema,
  sanitizeReportText,
} from "../../src/observer/report-policy.js";
import {
  RunReportDraftSchema,
  RunReportSchema,
  buildRunReport,
} from "../../src/observer/run-report.js";

const authority = {
  runId: "11111111-1111-4111-8111-111111111111",
  taskId: "daily-tech-digest",
  taskName: "每日科技情报",
  projectLabel: "WeChatPilot",
  status: "success" as const,
  startedAt: "2026-07-19T00:00:00.000Z",
  finishedAt: "2026-07-19T00:01:30.000Z",
};

describe("RunStatusSchema", () => {
  it("accepts exactly the supported terminal statuses", () => {
    const statuses = [
      "success",
      "failed",
      "timed-out",
      "cancelled",
      "interrupted",
      "skipped",
    ] as const;

    expect(statuses.map((status) => RunStatusSchema.parse(status))).toEqual(
      statuses,
    );
    expect(RunStatusSchema.safeParse("running").success).toBe(false);
    expect(RunStatusSchema.safeParse("SUCCESS").success).toBe(false);
  });
});

describe("RunReportDraftSchema", () => {
  const validDraft = {
    version: 1,
    summary: ["任务完成"],
    metrics: [{ label: "发送分片", value: "2" }],
    failure: null,
    artifacts: ["output/2026-07-19/digest.md"],
  } as const;

  it("accepts only the declared draft fields", () => {
    expect(RunReportDraftSchema.parse(validDraft)).toEqual(validDraft);
    expect(
      RunReportDraftSchema.safeParse({ ...validDraft, status: "success" }).success,
    ).toBe(false);
    expect(
      RunReportDraftSchema.safeParse({
        ...validDraft,
        metrics: [{ ...validDraft.metrics[0], command: "override" }],
      }).success,
    ).toBe(false);
  });

  it("accepts only project-relative artifact paths without traversal", () => {
    for (const artifact of [
      "/tmp/report.json",
      "../report.json",
      "output/../private/report.json",
      "output\\..\\private\\report.json",
    ]) {
      expect(
        RunReportDraftSchema.safeParse({
          ...validDraft,
          artifacts: [artifact],
        }).success,
      ).toBe(false);
    }
  });

  it("defaults an omitted failure to null without discarding a success summary", () => {
    const draft = {
      version: 1,
      summary: ["结构化业务摘要"],
      metrics: [{ label: "发送分片", value: "2" }],
      artifacts: ["output/2026-07-19/digest.md"],
    } as const;

    expect(RunReportDraftSchema.parse(draft)).toEqual({
      ...draft,
      failure: null,
    });
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft,
    });
    expect(report.summary).toEqual(draft.summary);
    expect(report.metrics).toEqual(draft.metrics);
    expect(report.failure).toBeNull();
  });
});

describe("sanitizeReportText", () => {
  const options = {
    projectRoot: "/Users/example/private-project",
    maximumCharacters: 500,
  } as const;

  it("redacts secrets before removing controls and normalizing the result", () => {
    expect(
      sanitizeReportText("  token=secret-value\u0000  retained  ", options),
    ).toBe("token=[REDACTED] retained");
  });

  it("closes secret-key bypasses created by removing control characters", () => {
    const privateMarker = ["PRIVATE", "VALUE", "SENTINEL"].join("_");
    const result = sanitizeReportText(
      `to\u0000ken=${privateMarker}`,
      options,
    );

    expect(result?.includes(privateMarker)).toBe(false);
    expect(result).toBe("token=[REDACTED]");
  });

  it("deletes C0, C1, and bidi controls while retaining ordinary spaces", () => {
    expect(
      sanitizeReportText(
        "left \u0000\u001f\u007f\u0085\u202e\u2066 right",
        options,
      ),
    ).toBe("left right");
  });

  it("replaces the exact project root and generic macOS and Linux home paths", () => {
    expect(
      sanitizeReportText(
        "/Users/example/private-project /Users/alice/work/file /home/bob/app/file",
        options,
      ),
    ).toBe("[LOCAL_PATH] [LOCAL_PATH] [LOCAL_PATH]");
  });

  it("redacts quoted and sentence-delimited home paths containing spaces", () => {
    expect(
      sanitizeReportText(
        '打开 "/Users/alice/Library/Application Support/Private/db.sqlite"，然后继续任务。',
        options,
      ),
    ).toBe('打开 "[LOCAL_PATH]"，然后继续任务。');
    expect(
      sanitizeReportText(
        "failed at /home/bob/My Project/private/db.sqlite. Retry later.",
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]. Retry later.");
  });

  it("redacts unquoted home paths containing legal quote characters", () => {
    expect(
      sanitizeReportText(
        "failed at /Users/alice/O'Brien/file.txt. Continue.",
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]. Continue.");
    expect(
      sanitizeReportText(
        'failed at /home/bob/Team"Blue"/file.txt; keep status.',
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]; keep status.");
  });

  it("replaces URL-shaped text after path handling", () => {
    expect(
      sanitizeReportText(
        "docs https://private.invalid/path and ftp://files.invalid/item",
        options,
      ),
    ).toBe("docs [URL] and [URL]");
  });

  it("truncates with an ellipsis within the requested maximum", () => {
    expect(
      sanitizeReportText("abcdef", {
        ...options,
        maximumCharacters: 5,
      }),
    ).toBe("abcd…");
  });

  it("counts Unicode code points without splitting a surrogate pair", () => {
    const result = sanitizeReportText("😀x", {
      ...options,
      maximumCharacters: 2,
    });

    expect(result).toBe("😀x");
    expect(result === null ? 0 : [...result].length).toBeLessThanOrEqual(2);
    expect(result === null ? false : /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/u.test(result)).toBe(false);
  });

  it("rejects a value that becomes empty", () => {
    expect(sanitizeReportText("\u0000\u202e  ", options)).toBeNull();
  });
});

describe("buildRunReport", () => {
  it("preserves trusted authority and emits a schema-valid sanitized report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: [
          "completed /Users/example/private-project token=secret-value",
        ],
        metrics: [
          { label: "result", value: "https://private.invalid/path" },
        ],
        failure: null,
        artifacts: ["output/2026-07-19/digest.md"],
      },
    });

    expect(report).toMatchObject(authority);
    expect(report.durationMs).toBe(90_000);
    expect(RunReportSchema.parse(report)).toEqual(report);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("https://");
  });

  it("uses the safe minimal summary and empty metrics for a null draft", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: null,
    });

    expect(report.summary).toEqual(["任务已完成，未提供结构化业务摘要"]);
    expect(report.metrics).toEqual([]);
  });

  it("does not let untrusted draft fields override authority", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: ["untrusted"],
        metrics: [],
        failure: null,
        artifacts: [],
        runId: "22222222-2222-4222-8222-222222222222",
        status: "failed",
      },
    });

    expect(report.runId).toBe(authority.runId);
    expect(report.status).toBe("success");
    expect(report.summary).toEqual(["任务已完成，未提供结构化业务摘要"]);
  });

  it("does not throw or leak when controls split a secret key in draft text", () => {
    const privateMarker = ["PRIVATE", "VALUE", "SENTINEL"].join("_");
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: [`to\u0000ken=${privateMarker}`],
        metrics: [],
        failure: null,
        artifacts: [],
      },
    });

    expect(JSON.stringify(report).includes(privateMarker)).toBe(false);
    expect(report.summary).toEqual(["token=[REDACTED]"]);
  });

  it("does not retain quote-bearing home path fragments in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          "mac /Users/alice/O'Brien/file.txt. Continue.",
          'linux /home/bob/Team"Blue"/file.txt; keep status.',
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "mac [LOCAL_PATH]. Continue.",
      "linux [LOCAL_PATH]; keep status.",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "O'Brien", "bob", 'Team"Blue"']) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("sanitizes failure information for failed reports", () => {
    const report = buildRunReport({
      authority: { ...authority, status: "failed" },
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: ["failed"],
        metrics: [],
        failure:
          "token=secret-value at /home/alice/private/app https://private.invalid",
        artifacts: [],
      },
    });

    const serialized = JSON.stringify(report.failure);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("/home/alice");
    expect(serialized).not.toContain("https://");
    expect(RunReportSchema.parse(report)).toEqual(report);
  });

  it("rejects final report text that has not passed the safety policy", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: null,
    });

    expect(
      RunReportSchema.safeParse({
        ...report,
        summary: ["token=secret-value"],
      }).success,
    ).toBe(false);
    expect(
      RunReportSchema.safeParse({
        ...report,
        metrics: [{ label: "result", value: "https://private.invalid/path" }],
      }).success,
    ).toBe(false);
    expect(
      RunReportSchema.safeParse({
        ...report,
        failure: "failed at /Users/alice/private/app",
      }).success,
    ).toBe(false);
    expect(
      RunReportSchema.safeParse({
        ...report,
        artifacts: ["output/token=secret-value.json"],
      }).success,
    ).toBe(false);
  });
});
