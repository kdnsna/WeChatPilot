import type { DigestEditorial } from "../../src/report/editorial.js";
import {
  toEditorialReportPayload,
  type EditorialReportPayload,
} from "../../src/report/editorial.js";

export function validEditorial(urls: readonly string[]): DigestEditorial {
  const sources = urls.slice(0, Math.min(2, urls.length));
  if (sources.length === 0) {
    throw new Error("editorial fixture requires at least one source URL");
  }
  return {
    executiveSummary:
      "今天最重要的变化是模型能力、开发工具和本地自动化继续融合，经过候选来源交叉核验后形成五项高价值信号，并给出三项可以在本周直接验证、持续跟踪和交给 Codex 安全执行的具体建议。",
    highlights: [
      {
        title: "Codex 本地自动化能力增强",
        whyItMatters:
          "新的任务能力减少人工值守时间，并让固定流程拥有更清晰的验证、失败降级和中断恢复边界。",
        sourceUrls: [...sources],
        impact: "high",
      },
    ],
    actions: [
      "用固定测试数据验证新的任务入口和输出结构",
      "连续记录一周运行耗时、失败率和恢复数据",
      "评估下一项适合交给 Codex 的安全自动化流程",
    ],
  };
}

export function validEditorialPayload(
  urls: readonly string[] = ["https://one.test/a", "https://two.test/b"],
  date = "2026-07-20",
): EditorialReportPayload {
  return toEditorialReportPayload(validEditorial(urls), {
    allowedUrls: urls,
    candidateCount: 42,
    sourceCategoryCount: 4,
    scheduledDate: date,
  });
}
