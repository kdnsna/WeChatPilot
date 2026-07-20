import { describe, expect, it } from "vitest";

import {
  RunStatusSchema,
  sanitizeReportText,
} from "../../src/observer/report-policy.js";
import {
  RunReportDraftSchema,
  RunReportSchema,
  attachIssue,
  buildRunReport,
} from "../../src/observer/run-report.js";
import { validEditorialPayload } from "../helpers/editorial.js";

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

  it("redacts complete reconstructed tokens instead of leaving partial tails", () => {
    const probes = [
      `ghp_${"a".repeat(24)}\n${"b".repeat(12)}`,
      `github_pat_${"c".repeat(20)}\u0000${"d".repeat(12)}`,
      `sk-${"e".repeat(20)}\r${"f".repeat(12)}`,
      `sk-${"g".repeat(20)}\u202e${"h".repeat(12)}`,
    ] as const;

    for (const value of probes) {
      const result = sanitizeReportText(value, options);
      expect(result).toBe("[REDACTED]");
      expect(result === null ? null : sanitizeReportText(result, options)).toBe(
        result,
      );
    }
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
    ).toBe("[LOCAL_PATH]");
  });

  it("fails closed after an exact home project root and is idempotent", () => {
    const result = sanitizeReportText(
      "before /Users/example/private-project/output/private.txt after",
      options,
    );

    expect(result).toBe("before [LOCAL_PATH]");
    expect(result === null ? null : sanitizeReportText(result, options)).toBe(
      result,
    );
  });

  it("closes paths reconstructed by line-break deletion and is idempotent", () => {
    const probes = [
      {
        value: "before /Use\nrs/alice/private.txt after",
        expected: "before [LOCAL_PATH]",
      },
      {
        value: "/ho\nme/bob/private.txt after",
        expected: "[LOCAL_PATH]",
      },
      {
        value:
          "before /Use\nrs/example/private-project/output/private.txt after",
        expected: "before [LOCAL_PATH]",
      },
    ] as const;

    for (const { value, expected } of probes) {
      const result = sanitizeReportText(value, options);
      expect(result).toBe(expected);
      expect(result === null ? null : sanitizeReportText(result, options)).toBe(
        result,
      );
    }
  });

  it("atomically sanitizes controls and bidi that reconstruct sensitive text", () => {
    const probes = [
      {
        value: "failed /Users/al\nice/private.txt",
        expected: "failed [LOCAL_PATH]",
      },
      {
        value: "failed /Users/al\rice/private.txt",
        expected: "failed [LOCAL_PATH]",
      },
      {
        value: "failed /Us\u0000ers/alice/private.txt",
        expected: "failed [LOCAL_PATH]",
      },
      {
        value:
          "failed /Users/exa\nmple/private-project/output.txt",
        expected: "failed [LOCAL_PATH]",
      },
      {
        value: "open https://priv\nate.invalid/private-path",
        expected: "open [URL]",
      },
      {
        value: "open https://priv\u202eate.invalid/private-path",
        expected: "open [URL]",
      },
    ] as const;

    for (const { value, expected } of probes) {
      const result = sanitizeReportText(value, options);
      expect(result).toBe(expected);
      expect(result === null ? null : sanitizeReportText(result, options)).toBe(
        result,
      );
    }
  });

  it("fails closed for quoted paths and bounds unquoted paths", () => {
    expect(
      sanitizeReportText(
        '打开 "/Users/alice/Library/Application Support/Private/db.sqlite"，然后继续任务。',
        options,
      ),
    ).toBe("打开 [LOCAL_PATH]");
    expect(
      sanitizeReportText(
        "failed at /home/bob/My Project/private/db.sqlite. Retry later.",
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
  });

  it("redacts unquoted home paths containing legal quote characters", () => {
    expect(
      sanitizeReportText(
        "failed at /Users/alice/O'Brien/file.txt. Continue.",
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
    expect(
      sanitizeReportText(
        'failed at /home/bob/Team"Blue"/file.txt; keep status.',
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
  });

  it("fails closed for quoted paths containing same-kind inner quotes", () => {
    expect(
      sanitizeReportText(
        "failed at '/Users/alice/O'Brien/file.txt'. Continue.",
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
    expect(
      sanitizeReportText(
        'failed at "/home/bob/Team"Blue"/file.txt". Continue.',
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
  });

  it("fails closed when non-ASCII text follows a quoted home path", () => {
    expect(
      sanitizeReportText(
        '打开 "/Users/alice/My Project/file.txt"然后继续',
        options,
      ),
    ).toBe("打开 [LOCAL_PATH]");
  });

  it("fails closed when an internal quote precedes a non-ASCII path component", () => {
    expect(
      sanitizeReportText(
        'failed at "/Users/alice/Team"蓝色"/file.txt". Continue.',
        options,
      ),
    ).toBe("failed at [LOCAL_PATH]");
  });

  it("fails closed to line end when a quoted home path is unterminated", () => {
    const result = sanitizeReportText(
      'failed at "/Users/alice/Team"Blue/file.txt',
      options,
    );

    expect(result).toBe("failed at [LOCAL_PATH]");
    for (const fragment of ["alice", "Blue", "file.txt"]) {
      expect(result?.includes(fragment)).toBe(false);
    }
  });

  it("fails closed for unterminated quoted paths with ambiguous tails", () => {
    for (const value of [
      'failed at "/Users/alice/Team" Blue/file.txt',
      'failed at "/Users/alice/Team"蓝色/file.txt',
    ]) {
      const result = sanitizeReportText(value, options);
      expect(result).toBe("failed at [LOCAL_PATH]");
      for (const fragment of ["alice", "Blue", "蓝色", "file.txt"]) {
        expect(result?.includes(fragment)).toBe(false);
      }
    }
  });

  it("fails closed through the field after deleting a quoted path line break", () => {
    const result = sanitizeReportText(
      'first "/Users/alice/private/file.txt" hidden\n下一行保留',
      options,
    );

    expect(result).toBe("first [LOCAL_PATH]");
    expect(result?.includes("hidden")).toBe(false);
    expect(result?.includes("下一行保留")).toBe(false);
  });

  it("fails closed for angle-delimited and angle-bearing home paths", () => {
    expect(
      sanitizeReportText(
        "see </Users/alice/private/file.txt> now",
        options,
      ),
    ).toBe("see <[LOCAL_PATH]");
    expect(
      sanitizeReportText("/home/bob/Team<Blue>/file.txt", options),
    ).toBe("[LOCAL_PATH]");
  });

  it("fails closed through the field after deleting an unquoted path line break", () => {
    expect(
      sanitizeReportText(
        "first /Users/alice/private/file.txt hidden\n下一行保留",
        options,
      ),
    ).toBe("first [LOCAL_PATH]");
  });

  it("leaves ordinary text without a home prefix unchanged", () => {
    expect(sanitizeReportText("ordinary <value> remains", options)).toBe(
      "ordinary <value> remains",
    );
    expect(sanitizeReportText("ordinary\ntext", options)).toBe("ordinarytext");
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
  it("attaches one matching issue and refuses conflicting reassignment", () => {
    const report = buildRunReport({ authority, projectRoot: "/tmp/project", draft: null });
    const numbered = attachIssue(report, { number: 127, label: "WP-000127" });
    expect(numbered).toMatchObject({ issueNumber: 127, issueLabel: "WP-000127" });
    expect(attachIssue(numbered, { number: 127, label: "WP-000127" })).toEqual(numbered);
    expect(() =>
      attachIssue(numbered, { number: 128, label: "WP-000128" }),
    ).toThrow(/issue/i);
    expect(
      RunReportSchema.safeParse({ ...report, issueNumber: 1 }).success,
    ).toBe(false);
  });

  it("preserves a sanitized editorial payload and replaces an invalid one with status", () => {
    const trusted = validEditorialPayload(undefined, "2026-07-19");
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: ["完成"],
        metrics: [],
        failure: null,
        artifacts: [],
        editorial: trusted,
      },
    });
    expect(report.editorial).toEqual(trusted);

    const fallback = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: ["失败"],
        metrics: [],
        failure: null,
        artifacts: [],
        editorial: { private: "https://secret.test/value" },
      },
    });
    expect(fallback.editorial).toMatchObject({
      kind: "status",
      highlights: [],
      actions: [],
      audit: { scheduledDate: "2026-07-19" },
    });
    expect(JSON.stringify(fallback)).not.toContain("secret.test");
  });

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

  it("does not retain partial token tails in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          `ghp ghp_${"a".repeat(24)}\n${"b".repeat(12)}`,
          `github github_pat_${"c".repeat(20)}\u0000${"d".repeat(12)}`,
          `sk sk-${"e".repeat(20)}\r${"f".repeat(12)}`,
          `bidi sk-${"g".repeat(20)}\u202e${"h".repeat(12)}`,
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "ghp [REDACTED]",
      "github [REDACTED]",
      "sk [REDACTED]",
      "bidi [REDACTED]",
    ]);
    expect(RunReportSchema.parse(report)).toEqual(report);
    const serialized = JSON.stringify(report);
    for (const tail of [
      "b".repeat(12),
      "d".repeat(12),
      "f".repeat(12),
      "h".repeat(12),
    ]) {
      expect(serialized.includes(tail)).toBe(false);
    }
  });

  it("closes exact and reconstructed paths in a schema-valid built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: [
          "root /Users/example/private-project/output/private.txt after",
          "mac /Use\nrs/alice/private.txt after",
          "linux /ho\nme/bob/private.txt after",
          "split-root /Use\nrs/example/private-project/output/private.txt after",
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "root [LOCAL_PATH]",
      "mac [LOCAL_PATH]",
      "linux [LOCAL_PATH]",
      "split-root [LOCAL_PATH]",
    ]);
    expect(RunReportSchema.parse(report)).toEqual(report);
    const serialized = JSON.stringify(report);
    for (const fragment of ["output/private.txt", "alice", "bob"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("atomically closes reconstructed paths and URLs in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: [
          "home /Users/al\nice/private.txt",
          "root /Users/exa\nmple/private-project/output.txt",
          "url https://priv\nate.invalid/private-path",
          "cr /home/bo\rb/private.txt",
          "nul /Us\u0000ers/alice/private.txt",
          "bidi https://priv\u202eate.invalid/private-path",
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "home [LOCAL_PATH]",
      "root [LOCAL_PATH]",
      "url [URL]",
      "cr [LOCAL_PATH]",
      "nul [LOCAL_PATH]",
      "bidi [URL]",
    ]);
    expect(RunReportSchema.parse(report)).toEqual(report);
    const serialized = JSON.stringify(report);
    for (const fragment of ["ice/private.txt", "output.txt", "ate.invalid"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
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
      "mac [LOCAL_PATH]",
      "linux [LOCAL_PATH]",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "O'Brien", "bob", 'Team"Blue"']) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("does not retain angle-delimited or angle-bearing path tails", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          "angle see </Users/alice/private/file.txt> now",
          "internal /home/bob/Team<Blue>/file.txt",
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "angle see <[LOCAL_PATH]",
      "internal [LOCAL_PATH]",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "bob", "Blue", "file.txt"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("does not retain nested-quote path tails in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          "mac '/Users/alice/O'Brien/file.txt'. Continue.",
          'linux "/home/bob/Team"Blue"/file.txt". Continue.',
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "mac [LOCAL_PATH]",
      "linux [LOCAL_PATH]",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "Brien/file.txt", "bob", 'Blue"/file.txt']) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("fails closed when non-ASCII text follows a quoted path in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: ['打开 "/Users/alice/My Project/file.txt"然后继续'],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual(["打开 [LOCAL_PATH]"]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "My Project", "file.txt"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("does not retain a non-ASCII nested-quote path tail in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          'failed at "/Users/alice/Team"蓝色"/file.txt". Continue.',
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "failed at [LOCAL_PATH]",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "蓝色", "file.txt"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("does not retain an unterminated quoted path tail in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: ['failed at "/Users/alice/Team"Blue/file.txt'],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual(["failed at [LOCAL_PATH]"]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "Blue", "file.txt"]) {
      expect(serialized.includes(fragment)).toBe(false);
    }
  });

  it("does not retain ambiguous unterminated tails in a built report", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/opt/example/private-project",
      draft: {
        version: 1,
        summary: [
          'space "/Users/alice/Team" Blue/file.txt',
          'unicode "/Users/alice/Team"蓝色/file.txt',
        ],
        metrics: [],
        artifacts: [],
      },
    });

    expect(report.summary).toEqual([
      "space [LOCAL_PATH]",
      "unicode [LOCAL_PATH]",
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["alice", "Blue", "蓝色", "file.txt"]) {
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
