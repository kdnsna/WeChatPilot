import { describe, expect, it } from "vitest";

import {
  buildStatusEditorialReport,
  DigestEditorialSchema,
  EditorialReportPayloadSchema,
  toEditorialReportPayload,
} from "../../src/report/editorial.js";

const SUMMARY =
  "今天最重要的变化是模型能力、开发工具和本地自动化继续融合，经过候选来源交叉核验后形成五项高价值信号，并给出三项可以在本周直接验证、持续跟踪和交给 Codex 安全执行的具体建议。";

function validEditorial() {
  return {
    executiveSummary: SUMMARY,
    highlights: [
      {
        title: "Codex 本地自动化能力增强",
        whyItMatters:
          "新的任务能力减少人工值守时间，并让固定流程拥有更清晰的验证、失败降级和中断恢复边界。",
        sourceUrls: ["https://one.test/a", "https://two.test/b"],
        impact: "high" as const,
      },
    ],
    actions: [
      "用固定测试数据验证新的任务入口和输出结构",
      "连续记录一周运行耗时、失败率和恢复数据",
      "评估下一项适合交给 Codex 的安全自动化流程",
    ],
  };
}

describe("editorial report payload", () => {
  it.each([
    "not-due",
    "already-sent",
    "failed",
    "interrupted",
  ] as const)("builds a detailed, evidence-only %s status receipt", (reason) => {
    const receipt = buildStatusEditorialReport({
      reason,
      date: "2026-07-20",
    });

    expect(receipt.kind).toBe("status");
    expect(receipt.highlights).toHaveLength(5);
    expect(receipt.actions).toHaveLength(3);
    expect(receipt.audit).toEqual({
      candidateCount: 5,
      selectedCount: 5,
      sourceCategoryCount: 4,
      scheduledDate: "2026-07-20",
    });
    expect(
      receipt.highlights.every(
        (item) =>
          item.sourceCount >= 1 &&
          item.confidence === "high" &&
          item.impact === "medium",
      ),
    ).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/https?:|token|cookie/iu);
    expect(EditorialReportPayloadSchema.parse(receipt)).toEqual(receipt);
  });

  it("converts verified source URLs into counts and deterministic confidence", () => {
    const safe = toEditorialReportPayload(validEditorial(), {
      allowedUrls: ["https://one.test/a", "https://two.test/b"],
      candidateCount: 42,
      sourceCategoryCount: 4,
      scheduledDate: "2026-07-20",
    });

    expect(safe.highlights[0]).toEqual({
      title: "Codex 本地自动化能力增强",
      whyItMatters:
        "新的任务能力减少人工值守时间，并让固定流程拥有更清晰的验证、失败降级和中断恢复边界。",
      sourceCount: 2,
      confidence: "medium-high",
      impact: "high",
    });
    expect(safe.audit).toEqual({
      candidateCount: 42,
      selectedCount: 1,
      sourceCategoryCount: 4,
      scheduledDate: "2026-07-20",
    });
    expect(JSON.stringify(safe)).not.toContain("https://");
    expect(EditorialReportPayloadSchema.parse(safe)).toEqual(safe);
  });

  it.each([
    [1, "medium"],
    [2, "medium-high"],
    [3, "high"],
  ] as const)("maps %i verified sources to %s confidence", (count, confidence) => {
    const raw = validEditorial();
    raw.highlights[0]!.sourceUrls = Array.from(
      { length: count },
      (_, index) => `https://source.test/${index}`,
    );
    const safe = toEditorialReportPayload(raw, {
      allowedUrls: raw.highlights[0]!.sourceUrls,
      candidateCount: count,
      sourceCategoryCount: 1,
      scheduledDate: "2026-07-20",
    });
    expect(safe.highlights[0]?.confidence).toBe(confidence);
  });

  it("rejects a source absent from the approved candidates", () => {
    expect(() =>
      toEditorialReportPayload(validEditorial(), {
        allowedUrls: ["https://one.test/a"],
        candidateCount: 1,
        sourceCategoryCount: 1,
        scheduledDate: "2026-07-20",
      }),
    ).toThrowError("Editorial source verification failed");
  });

  it("enforces the exact character and cardinality contract", () => {
    expect(() =>
      DigestEditorialSchema.parse({
        ...validEditorial(),
        executiveSummary: "太短",
      }),
    ).toThrow();
    expect(() =>
      DigestEditorialSchema.parse({
        ...validEditorial(),
        actions: ["只有一项行动会被拒绝"],
      }),
    ).toThrow();
  });
});
