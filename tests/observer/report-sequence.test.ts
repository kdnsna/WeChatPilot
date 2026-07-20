import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assignReportIssue } from "../../src/observer/report-sequence.js";

const roots: string[] = [];
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-sequence-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("editorial report sequence", () => {
  it("assigns one stable number per run", async () => {
    const root = project();
    const first = await assignReportIssue({ projectRoot: root, runId: RUN_A });
    const repeated = await assignReportIssue({ projectRoot: root, runId: RUN_A });
    const second = await assignReportIssue({ projectRoot: root, runId: RUN_B });

    expect(first).toEqual({ number: 1, label: "WP-000001" });
    expect(repeated).toEqual(first);
    expect(second).toEqual({ number: 2, label: "WP-000002" });
    expect(
      statSync(join(root, ".state", "observer", "report-sequence.json")).mode &
        0o777,
    ).toBe(0o600);
    expect(statSync(join(root, ".state", "observer")).mode & 0o777).toBe(0o700);
  });

  it("serializes concurrent assignments without duplicates", async () => {
    const root = project();
    const [sameA, sameB, other] = await Promise.all([
      assignReportIssue({ projectRoot: root, runId: RUN_A }),
      assignReportIssue({ projectRoot: root, runId: RUN_A }),
      assignReportIssue({ projectRoot: root, runId: RUN_B }),
    ]);
    expect(sameA).toEqual(sameB);
    expect(new Set([sameA.number, other.number])).toEqual(new Set([1, 2]));
  });
});
