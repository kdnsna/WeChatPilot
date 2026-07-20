import { z } from "zod";

import { sanitizeReportText } from "../observer/report-policy.js";

function codePointLength(value: string): number {
  return [...value].length;
}

const boundedText = (minimum: number, maximum: number) =>
  z
    .string()
    .refine(
      (value) =>
        codePointLength(value) >= minimum && codePointLength(value) <= maximum,
    );

export const DigestEditorialSchema = z
  .object({
    executiveSummary: boundedText(80, 140),
    highlights: z
      .array(
        z
          .object({
            title: boundedText(8, 36),
            whyItMatters: boundedText(40, 100),
            sourceUrls: z
              .array(z.string().url())
              .min(1)
              .max(6)
              .refine((values) => new Set(values).size === values.length),
            impact: z.enum([
              "high",
              "medium-high",
              "medium",
              "exploratory",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    actions: z.array(boundedText(12, 80)).length(3),
  })
  .strict();

export const EditorialReportPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["digest", "status"]),
    executiveSummary: z.string().min(1).max(280),
    highlights: z
      .array(
        z
          .object({
            title: z.string().min(1).max(80),
            whyItMatters: z.string().min(1).max(240),
            sourceCount: z.number().int().min(1).max(6),
            confidence: z.enum(["high", "medium-high", "medium"]),
            impact: z.enum([
              "high",
              "medium-high",
              "medium",
              "exploratory",
            ]),
          })
          .strict(),
      )
      .max(5),
    actions: z.array(z.string().min(1).max(120)).max(3),
    audit: z
      .object({
        candidateCount: z.number().int().nonnegative().optional(),
        selectedCount: z.number().int().nonnegative().optional(),
        sourceCategoryCount: z.number().int().nonnegative().optional(),
        scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      })
      .strict(),
  })
  .strict();

export type DigestEditorial = z.infer<typeof DigestEditorialSchema>;
export type EditorialReportPayload = z.infer<
  typeof EditorialReportPayloadSchema
>;

export interface EditorialPayloadOptions {
  readonly allowedUrls: readonly string[];
  readonly candidateCount: number;
  readonly sourceCategoryCount: number;
  readonly scheduledDate: string;
}

function safeText(
  value: string,
  maximumCharacters: number,
  projectRoot = "",
): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/giu, "");
  const sanitized = sanitizeReportText(withoutUrls, {
    projectRoot,
    maximumCharacters,
  });
  if (sanitized === null) {
    throw new Error("Editorial text sanitization failed");
  }
  return sanitized;
}

export function sanitizeEditorialReportPayload(
  input: unknown,
  projectRoot: string,
): EditorialReportPayload {
  const payload = EditorialReportPayloadSchema.parse(input);
  return EditorialReportPayloadSchema.parse({
    ...payload,
    executiveSummary: safeText(payload.executiveSummary, 280, projectRoot),
    highlights: payload.highlights.map((highlight) => ({
      ...highlight,
      title: safeText(highlight.title, 80, projectRoot),
      whyItMatters: safeText(highlight.whyItMatters, 240, projectRoot),
    })),
    actions: payload.actions.map((action) =>
      safeText(action, 120, projectRoot),
    ),
  });
}

function confidence(sourceCount: number): "high" | "medium-high" | "medium" {
  if (sourceCount >= 3) {
    return "high";
  }
  return sourceCount === 2 ? "medium-high" : "medium";
}

export function toEditorialReportPayload(
  input: DigestEditorial,
  options: EditorialPayloadOptions,
): EditorialReportPayload {
  const raw = DigestEditorialSchema.parse(input);
  const allowed = new Set(options.allowedUrls);
  if (
    raw.highlights.some((highlight) =>
      highlight.sourceUrls.some((url) => !allowed.has(url)),
    )
  ) {
    throw new Error("Editorial source verification failed");
  }

  return EditorialReportPayloadSchema.parse({
    version: 1,
    kind: "digest",
    executiveSummary: safeText(raw.executiveSummary, 280),
    highlights: raw.highlights.map((highlight) => ({
      title: safeText(highlight.title, 80),
      whyItMatters: safeText(highlight.whyItMatters, 240),
      sourceCount: highlight.sourceUrls.length,
      confidence: confidence(highlight.sourceUrls.length),
      impact: highlight.impact,
    })),
    actions: raw.actions.map((action) => safeText(action, 120)),
    audit: {
      candidateCount: options.candidateCount,
      selectedCount: raw.highlights.length,
      sourceCategoryCount: options.sourceCategoryCount,
      scheduledDate: options.scheduledDate,
    },
  });
}

export function buildStatusEditorialReport(options: {
  readonly reason: "not-due" | "already-sent" | "failed" | "interrupted";
  readonly date: string;
  readonly nextScheduledAt?: string;
}): EditorialReportPayload {
  const descriptions = {
    "not-due": "尚未到每日情报发送时间，本次只完成调度检查，没有生成新的技术信号或重复推送内容。",
    "already-sent": "今日情报已经完成发送，幂等记录阻止本次重复生成和重复投递，保留原有发送结果。",
    failed: "本次情报任务未能完成，系统只记录可审计的失败状态，不会用未核验内容填充或伪造今日信号。",
    interrupted: "任务因主机或进程中断而结束，恢复流程已补记状态，不自动重放任何可能已发送的内容。",
  } as const;
  const receipts = {
    "not-due": {
      highlights: [
        ["调度日期已完成核对", "系统只执行了计划时间检查，当前运行不满足新一轮情报任务的启动条件。"],
        ["未启动新的候选采集", "本次没有读取或编排新的技术候选，因此不会把过时数据包装成当日信号。"],
        ["未调用日报正文投递", "微信正文通道未被触发，这避免了在计划时间之外产生额外消息。"],
        ["现有编号与账本保持不变", "本次状态检查不改写已完成的日报、投递记录或历史审计信息。"],
        ["下一计划周期仍然有效", "本次跳过不会停用定时任务，后续仍由 LaunchAgent 按既定时间再次检查。"],
      ],
      actions: [
        "无需手工重跑，等待下一计划周期自动检查",
        "如需临时发送，先确认调度时间和当日去重状态",
        "保留本次跳过回执，用于核对定时器是否按预期唤醒",
      ],
    },
    "already-sent": {
      highlights: [
        ["幂等账本确认今日已发送", "当日投递记录已处于完成状态，因此这次唤醒不会再创建一份相同日报。"],
        ["重复执行在生成前被拦截", "去重判断发生在新正文和新图片投递之前，避免消耗生成配额或打扰微信会话。"],
        ["原始微信投递结果保持不变", "系统保留既有的已发文本、图片和尝试次数，不覆盖也不伪造新的成功记录。"],
        ["本次不制造新的技术信号", "由于正文已经完成，状态回执只展示可验证的执行事实，不为填满版面而补写情报。"],
        ["后续定时调度继续保留", "这次去重跳过只影响当前唤醒，不会关闭下一个计划周期的自动值守。"],
      ],
      actions: [
        "查看先前已发送的日报和对应期号，不以本次状态回执替代正文",
        "保留幂等与投递账本，不手工清除已发送标记",
        "等待下一计划周期，再由 LaunchAgent 触发新的核验和发送",
      ],
    },
    failed: {
      highlights: [
        ["任务未达到完成终态", "运行账本已记录失败状态，本次回执不会把未完成结果标注为成功。"],
        ["未验证内容不进入情报区", "系统没有使用失败过程中的中间产物填充今日信号，避免误导后续判断。"],
        ["微信投递不会无限重试", "只有明确可重试的拒绝才使用有限尝试，不确定或登录失效会立即阻断。"],
        ["失败证据保留供后续诊断", "状态、阶段和尝试次数会写入私有账本，同时不记录令牌、凭据或个人上下文。"],
        ["下一次执行需要先通过健康检查", "在重新执行前应确认运行时、配置、微信上下文和视觉生成能力均为就绪。"],
      ],
      actions: [
        "查看安全失败分类和对应阶段，不从日志中追索私密上下文",
        "先运行健康检查，仅在必需能力恢复后启动一次明确重试",
        "保留失败账本与期号，避免新任务覆盖待审计记录",
      ],
    },
    interrupted: {
      highlights: [
        ["中断运行已由恢复流程识别", "系统根据运行身份与存活检查确认原进程不再活动，然后补记中断状态。"],
        ["不自动重放可能已发送的内容", "中断点可能位于外部投递前后，因此系统不假设未发送，也不自动重复全份报告。"],
        ["恢复回执不伪造技术信号", "本次只展示中断和恢复证据，没有把不完整的候选、正文或视觉产物当作日报。"],
        ["旧运行账本保持可审计", "原运行的开始时间、任务身份和中断结果会被保留，新任务不会覆盖它。"],
        ["后续恢复必须使用新运行身份", "只有在锁、进程和微信投递状态均明确后，才能安全启动下一次独立运行。"],
      ],
      actions: [
        "先核对原运行是否已经产生外部投递，不根据本地猜测盲目重发",
        "清理前先确认锁文件对应的进程已消失，保留恢复审计记录",
        "通过健康检查后再启动新运行，并使用新期号区分两次执行",
      ],
    },
  } as const;
  const receipt = receipts[options.reason];
  return EditorialReportPayloadSchema.parse({
    version: 1,
    kind: "status",
    executiveSummary: descriptions[options.reason],
    highlights: receipt.highlights.map(([title, whyItMatters]) => ({
      title,
      whyItMatters,
      sourceCount: 1,
      confidence: "high",
      impact: "medium",
    })),
    actions: receipt.actions,
    audit: {
      candidateCount: 5,
      selectedCount: 5,
      sourceCategoryCount: 4,
      scheduledDate: options.date,
    },
  });
}
