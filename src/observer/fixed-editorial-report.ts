import { RunReportSchema, type RunReport } from "./run-report.js";
import type { ReportIssue } from "./report-sequence.js";

const SIGNALS = [
  {
    title: "Codex 定时任务进入可审计值守阶段",
    whyItMatters:
      "固定入口、只读执行和完成后报告，让家庭电脑上的自动任务可以被远程了解，同时不开放命令控制能力。",
    sourceCount: 3,
    confidence: "high" as const,
    impact: "high" as const,
  },
  {
    title: "Image 2 负责主视觉而非文字排版",
    whyItMatters:
      "生成式图片专注表达当天主题，标题、信号、行动和审计信息继续由确定性排版生成，兼顾美观与可读性。",
    sourceCount: 2,
    confidence: "medium-high" as const,
    impact: "high" as const,
  },
  {
    title: "微信成为单向通知与监控终端",
    whyItMatters:
      "任务完成后主动发送长图和摘要，用户在移动端即可掌握结果，同时消息入口不会触发本机命令或远程控制。",
    sourceCount: 2,
    confidence: "medium-high" as const,
    impact: "medium-high" as const,
  },
  {
    title: "编号与账本支持失败恢复和去重",
    whyItMatters:
      "每份报告获得稳定期号，视觉生成和微信投递分别记录状态，使明确失败可以重试而不重复发送已经成功的部分。",
    sourceCount: 2,
    confidence: "medium-high" as const,
    impact: "medium-high" as const,
  },
  {
    title: "固定长图版式提升每日信息密度",
    whyItMatters:
      "一张长图同时容纳今日结论、五项重点信号、三项行动和执行审计，避免过去只有一句话且版式单薄的问题。",
    sourceCount: 1,
    confidence: "medium" as const,
    impact: "medium" as const,
  },
] as const;

export const FIXED_PREVIEW_RUN_ID = "33333333-3333-4333-8333-333333333333";
export const FIXED_PREVIEW_FINISHED_AT = "2026-07-20T01:00:00.000Z";

export function buildFixedEditorialReport(options: {
  readonly runId: string;
  readonly finishedAt: string;
  readonly issue: ReportIssue;
  readonly taskId?: string;
  readonly taskName?: string;
}): RunReport {
  const finished = new Date(options.finishedAt);
  const startedAt = new Date(finished.getTime() - 82_000).toISOString();
  return RunReportSchema.parse({
    version: 1,
    runId: options.runId,
    taskId: options.taskId ?? "codex-wechat-editorial-test",
    taskName: options.taskName ?? "Codex 编辑部情报链路测试",
    projectLabel: "WeChatPilot",
    status: "success",
    startedAt,
    finishedAt: finished.toISOString(),
    durationMs: 82_000,
    summary: ["编辑部情报长图、编号、审计与微信单向投递链路验证完成"],
    metrics: [
      { label: "报告版式", value: "1080 × 2400 单张长图" },
      { label: "主视觉", value: "Codex 内置 Image 2" },
      { label: "安全边界", value: "微信仅接收通知，不执行命令" },
    ],
    failure: null,
    artifacts: [],
    editorial: {
      version: 1,
      kind: "digest",
      executiveSummary:
        "本次固定报告验证 Codex 本地任务完成后，能够生成详尽、编号清晰且版式稳定的编辑部情报长图，并通过已绑定微信进行单向通知。主视觉由内置 Image 2 生成，正文和审计信息保持确定性排版。",
      highlights: SIGNALS,
      actions: [
        "先运行能力探测，确认当前 Codex 与编辑部视觉版本可用",
        "检查本地预览的文字密度、编号、主视觉裁切和审计信息",
        "确认微信实发后再让 LaunchAgent 执行每日自动值守任务",
      ],
      audit: {
        candidateCount: 28,
        selectedCount: 5,
        sourceCategoryCount: 4,
        scheduledDate: "2026-07-20",
      },
    },
    issueNumber: options.issue.number,
    issueLabel: options.issue.label,
  });
}
