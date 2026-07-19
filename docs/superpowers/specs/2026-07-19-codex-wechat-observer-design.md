# Codex 微信值守员设计

**日期：** 2026-07-19
**状态：** 产品方向已批准；等待用户审阅本书面规格
**实施范围：** WeChatPilot v1.1 的第一个独立子项目

## 1. 产品决策

WeChatPilot 下一阶段优先建设 **Codex Observer Gateway（Codex 微信值守员）**：让家中电脑上的 Codex 任务在每次运行结束后，主动向用户本人的微信发送一条简短状态消息和一张可核验的 PNG 报告卡。

产品定位是：

> 家中 Codex 的只读微信值守员——任务做完主动汇报，失败及时提醒，结果附带证据。

它不是微信里的 Codex 终端。微信始终只是单向报告目的地，不接收任务指令、不批准权限、不恢复会话，也不暴露本机命令、文件浏览或远程控制能力。

本设计收窄了上一份品牌规格中的近期平台方向：通用入站聊天机器人、意图路由和远程工作流触发不进入 v1.1。可复用的平台能力将围绕“本地任务事件、结构化报告、可靠出站通知”建设。

## 2. 调研依据

设计基于以下已经验证的能力边界：

- Codex 官方 Scheduled tasks 可以在本地项目或隔离 worktree 中后台运行；项目级任务要求电脑保持开机、桌面端运行且项目仍可访问。官方入口目前提供 Codex 内部的 Scheduled 收件箱，没有公开的微信 webhook 配置。
- Codex 官方 Hooks 可以在生命周期事件上运行确定性本地脚本，包含 `Stop`、`PermissionRequest` 等事件；它适合作为后续通知适配器，但单独依赖 Hook 不能保证覆盖进程崩溃、强制终止或未写出业务摘要的情况。
- Codex App Server 提供 `turn/started`、`turn/completed`、失败状态和 turn diff 等结构化事件，但部分传输和接口仍属于 experimental，第一版不以它作为生产依赖。
- 腾讯微信 iLink 的 `sendMessage` 与 CDN 上传流程支持文本、图片和文件，足以承载报告卡。
- `weixin-codex-bridge`、`cli-in-wechat` 和 `wechat-acp` 已验证微信连接 Codex 的市场需求，但它们主要把微信作为控制面；`codex-telegram-notifier` 则验证了独立任务通知网关的产品模式。

参考资料：

- [Codex Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [腾讯微信 iLink](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)
- [weixin-codex-bridge](https://github.com/zktww/weixin-codex-bridge)
- [codex-telegram-notifier](https://github.com/Menwitz/codex-telegram-notifier)

## 3. v1 目标与非目标

### 3.1 目标

第一版必须完成一个真实、可重复验证的闭环：

1. 一个本机定时任务通过 WeChatPilot 管理的外层运行器启动。
2. 运行器记录任务状态、开始时间、结束时间、耗时和退出结果。
3. 任务可选择提交结构化业务摘要和产物清单；未提交时仍能生成最小报告。
4. WeChatPilot 在本地完成脱敏、校验和 PNG 报告卡渲染。
5. 每次最终运行向本人微信发送文字摘要和报告卡。
6. 发送过程具有按运行实例幂等、有限重试、不确定态停止和私有审计记录。

首个参考集成使用现有 `daily-tech-digest` 定时流水线。设计出的运行报告协议必须与摘要业务解耦，使后续代码检查、测试、依赖审计、PPT 检查或文档处理任务可以复用。

### 3.2 非目标

v1 不实现：

- 微信消息触发 Codex、Shell、脚本或任意本机操作。
- 微信端 `/approve`、`/deny`、`/retry`、`/resume`、`/stop` 等控制命令。
- 扫描、解析或修改 `~/.codex` 会话数据库、rollout 文件或桌面端私有索引。
- 自动发现所有既有 Codex Desktop Scheduled tasks。
- 实时转发 Codex 思考、工具调用、终端输出或完整 diff。
- 从任意路径发送任意附件。
- 群聊、多用户、可选接收人或公网 webhook。

## 4. 交付分层

### 4.1 v1：受管任务运行器

v1 只保证监控 **WeChatPilot-managed jobs**。每个任务由本地、版本化、人工审核的任务定义注册，调度器调用 WeChatPilot 外层运行器，运行器再启动固定入口。因为外层进程掌握子任务退出和超时状态，所以即使 Codex 没有生成最终回复，也能形成失败或超时报告。

运行器必须在启动子任务之前持久化 `running` 记录。电脑断电、进程被强制终止或系统重启时无法即时发微信；下次启动时，恢复流程检查由本项目创建的未完成记录和进程身份，将确认已经失活的运行归类为 `interrupted`，再补发一份恢复报告。它不扫描 Codex 的全局会话或桌面端私有状态。

现有 `launchd -> scripts/run-scheduled.sh -> scheduled CLI` 是第一个受管任务基础，不改变其固定绝对路径、锁、重试和每日发送账本。

### 4.2 v1 兼容模式：任务主动上报

原生 Codex Scheduled task 可以在结束步骤调用一个只接受结构化报告的本地 reporter CLI。此模式能生成丰富报告，但 Codex 进程在调用 reporter 之前崩溃时可能漏报。因此它属于兼容能力，不计入 v1 的“总能报告最终状态”承诺。

### 4.3 v2：Codex 生命周期适配器

后续增加独立适配器：

- 优先评估官方项目级 `Stop` / `PermissionRequest` Hooks。
- App Server 仅在协议和桌面端连接方式稳定后，用于更丰富的运行状态、失败详情和 diff 指标。
- `PermissionRequest` 只生成“请回到电脑处理”的提醒，不允许微信返回审批决定。

适配器只能生产统一的 `RunReport`，不得直接调用微信传输层。这样 Codex 协议升级不会影响报告渲染和发送可靠性。

## 5. 总体架构

```text
launchd / approved local scheduler
  -> ManagedJobRunner
       -> fixed task entrypoint
       -> optional structured report draft
       -> exit / timeout / abort / recovery classification
  -> RunReportNormalizer
  -> ReportPolicy and redaction
  -> ReportCardRenderer (SVG -> PNG)
  -> RunDeliveryOutbox
       -> text sender
       -> audited WeChat image uploader
  -> private run ledger and health status
```

组件边界：

1. **ManagedJobRunner** 只负责运行一个已注册的本地入口并观测生命周期，不了解微信。
2. **RunReportNormalizer** 把运行器结果和可选业务摘要合并为唯一、严格校验的报告对象。
3. **ReportPolicy** 执行字段长度、脱敏、项目别名和附件路径策略，不负责排版。
4. **ReportCardRenderer** 只接收已经安全化的报告视图模型，生成固定尺寸 PNG。
5. **RunDeliveryOutbox** 负责编排文字和图片发送、幂等与重试，不读取 Codex 会话。
6. **WechatMediaSender** 只实现审计过的图片上传和发送协议，不加载 vendor 的 Router、Codex adapter 或主入口。

## 6. 运行报告协议

`RunReport` 使用严格版本化 JSON Schema。v1 字段如下：

```text
version          固定为 1
runId            本次运行的随机 UUID
taskId           版本化任务 ID，例如 daily-tech-digest
taskName         面向用户的固定中文名称
projectLabel     配置中的安全别名，不是绝对路径
status           success | failed | timed-out | cancelled | interrupted | skipped
startedAt        ISO 8601 时间
finishedAt       ISO 8601 时间
durationMs       非负安全整数
summary          1–3 条安全化摘要，每条有长度上限
metrics          最多 6 个 label/value 指标，均为字符串白名单
failure          可选的稳定错误分类与安全提示
artifacts        最多 3 个通过策略检查的本地产物引用
```

协议禁止包含：

- 原始 prompt、完整模型回复、reasoning、完整 stderr 或完整命令行。
- 绝对用户目录、用户名、微信 user ID、context token 或 Codex session ID。
- Authorization、Cookie、环境变量、API key 或任何凭据。
- 未经策略确认的 URL、Markdown/HTML、控制字符和双向文本覆盖字符。

任务业务代码可以写入一个 `RunReportDraft`，但不能指定 `runId`、时间、接收人、微信凭据、最终状态或任意附件路径。这些权威字段由外层运行器填写。draft 中的产物只能使用相对于任务定义中 `allowedArtifactRoot` 的路径，由外层策略解析和验证。

## 7. 报告卡设计

v1 报告卡使用本地确定性模板，不调用图片生成模型。

- 输出：PNG，1080 × 1440，sRGB。
- 视觉状态：成功为绿色、失败/超时为红色、跳过为灰色、取消/中断为橙色。
- 固定区域：任务名称、状态、完成时间、耗时、三条摘要、关键指标、下一步和短运行编号。
- 字体：macOS 中文系统字体链；缺字时回退到通用 sans-serif。
- 长文本：在进入渲染器前截断并添加省略标记，模板不自动缩小到不可读字号。
- 可访问性：状态同时使用文字和图标表达，不只依赖颜色。

渲染器先生成受控 SVG，再在本地栅格化为 PNG。SVG 不接受业务提供的原始标签、样式、脚本、外链、data URL 或远程字体。

文字消息是报告的可访问性与失败兜底，格式固定为：

```text
Codex 任务完成：<任务名>
状态：<状态> · 耗时：<耗时>
结果：<第一条摘要>
运行：<短 runId>
```

## 8. 微信图片发送

当前第一方 WeChat adapter 只实现受限文本发送。v1 新增最小图片发送能力：

1. 只接受由报告渲染器产生、位于项目 `output/run-reports/` 下的 PNG。
2. 拒绝 symlink、路径穿越、非普通文件、扩展名与 MIME 不一致、尺寸不符或超过配置上限的文件。
3. 按腾讯 iLink 流程计算摘要、AES 加密、获取上传 URL、上传密文并发送 `image_item`。
4. 媒体实现从固定上游提交中单独审计所需代码；不得实例化或启动 vendor 的 `bridge/router`、CLI、Codex adapter 或会话逻辑。
5. 日志只记录 `runId`、阶段和安全错误分类，不记录 URL 查询参数、AES key、token、用户 ID 或响应正文。

发送顺序固定为先文字、后图片。这样图片失败时用户仍能收到最小结果。每个部分单独记账：

```text
pending -> text-sending -> text-sent -> image-sending -> sent
                                  \-> partial / indeterminate
```

只有微信明确拒绝且尚未确认该部分送达时，才允许有限重试该部分。超时、连接中断、无法解析响应或图片发送结果不确定时，标记 `indeterminate` 并停止自动重放，避免重复消息。

## 9. 本地状态与幂等

新增状态布局：

```text
.state/observer/runs/<runId>.json       私有运行状态
.state/delivery/runs/<runId>.json       私有发送 ledger
.state/locks/observer-<taskId>.lock     每任务串行锁
output/run-reports/<date>/<runId>.png   已脱敏报告卡
output/run-reports/<date>/<runId>.json  已脱敏报告副本
```

- `.state` 目录保持 `0700`，文件保持 `0600`。
- 每次调度先创建 `runId`；同一 `runId` 永远只能形成一份最终报告和一条发送 ledger。
- `running` 记录必须在子任务启动前原子写入并同步落盘；恢复流程只处理本项目记录且确认原进程已经失活的运行。
- 每任务锁阻止同一任务重叠运行，沿用现有 live/stale PID 与文件身份校验策略。
- 报告卡和安全化 JSON 可保留用于本地审计；原始子进程输出不进入报告目录。
- 默认保留最近 30 天报告；清理只能删除明确位于上述报告目录、通过路径检查且早于保留期的文件。自动清理不纳入首个 POC。

## 10. 错误分类

用户可见失败只使用稳定分类：

- `task-failed`：任务以非零状态退出。
- `task-timeout`：超过任务定义的固定期限。
- `task-cancelled`：本机调度器收到终止信号。
- `task-interrupted`：恢复流程确认此前的运行因进程或主机中断而未完成。
- `report-invalid`：业务摘要未通过 schema 或策略校验，回退到最小报告。
- `render-failed`：PNG 生成失败，仍发送文字报告。
- `wechat-login-expired`：要求用户回到电脑重新扫码。
- `wechat-rejected`：微信明确拒绝，可有限重试未确认部分。
- `wechat-indeterminate`：结果无法确认，为避免重复而停止。

错误卡不展示原始异常堆栈。详细诊断只进入现有脱敏日志，并继续接受大小、权限和路径限制。

## 11. 配置边界

任务定义必须位于仓库内的版本化配置，且每个任务明确声明：

- 固定 `taskId`、名称和项目别名。
- 固定入口和参数；配置值不能来自微信消息。
- 固定工作目录，必须位于允许的项目根下。
- 超时、调度入口、报告摘要路径和允许产物根。
- 是否每次发送；v1 默认每次最终运行都发送，包括 `skipped`。

任务运行器不得接受 `--command`、`--cwd`、`--user`、`--recipient` 或任意附件路径等临时覆盖参数。新增或变更任务必须通过本机代码审查和版本控制完成。

运行器必须使用参数数组和 `shell: false` 启动固定入口，使用环境变量白名单，不设置、清空或改写 `HOME` / `CODEX_HOME`，也不得向任务追加沙箱绕过、自动批准或权限提升参数。WeChatPilot 只观察任务实际采用的本机安全配置，不替任务扩大权限。

## 12. 测试策略

### 12.1 单元测试

- `RunReport` / `RunReportDraft` schema、长度、枚举和权威字段覆盖。
- 对 token、Cookie、URL 查询参数、绝对路径、控制字符和嵌套错误对象的脱敏。
- 报告视图模型的截断、状态颜色、日期和耗时格式。
- PNG 签名、尺寸和非空渲染；模板输入不得产生脚本、外链或未转义标签。
- 附件根目录、symlink、普通文件、大小、扩展名和 MIME 检查。
- iLink 图片上传请求形状、摘要和加密参数使用固定无密钥 fixture 测试。
- 文字成功/图片失败、明确拒绝、不确定响应和重复 `runId` 的 ledger 状态机。

### 12.2 集成测试

- 使用无秘密的假任务覆盖成功、非零退出、超时、取消、中断恢复和无效 draft。
- 假任务不输出业务摘要时仍生成最小报告。
- 模拟报告渲染失败时只发送文字。
- 模拟两次并发运行时只有一个获得锁。
- 模拟外层进程被强制终止后，下一次启动只生成一份 `interrupted` 恢复报告。
- 模拟发送进程中断后不会整组重发。
- 现有日报、Codex 子进程安全参数、文本微信发送、每日 ledger 和 LaunchAgent 测试保持通过。

### 12.3 真实验证门槛

真实微信验证必须是显式的本机检查点：

1. 先发送不含私人数据的测试报告卡。
2. 证明文字和图片均得到微信明确接受。
3. 再执行一次真实 `daily-tech-digest` 集成。
4. 最后模拟一个受控失败，确认红色失败卡和不重复行为。

不得把“本地函数返回成功”当作微信真实送达证明。

## 13. 分阶段交付

### Phase 1：报告闭环

- `RunReport` schema、脱敏策略和固定报告卡渲染。
- 审计后的微信 PNG 上传与发送。
- 运行级发送 ledger。
- 手工触发成功/失败测试报告。

### Phase 2：首个受管 Codex 任务

- 通用 `ManagedJobRunner`。
- 将现有 `daily-tech-digest` 接入运行报告，但不改变它的日报正文发送语义。
- 成功、失败、超时和跳过报告。
- 保持现有 launchd 兼容性和每日幂等。

### Phase 3：Codex 官方适配器

- 评估项目级 Hooks 的稳定事件和任务相关性。
- 对原生 Scheduled task 提供主动 reporter 集成。
- 在不读取 Codex 私有状态、不开放微信控制的前提下，评估 App Server 观察能力。

实时进度、更多附件、日报/周报汇总和多项目总览均在前三阶段验证稳定后单独设计。

## 14. 验收标准

v1 完成时必须满足：

- 至少一个受管 Codex 任务在成功、失败、超时和中断恢复情况下都能形成最终 `RunReport`。
- 在电脑在线、微信登录有效且服务明确接受请求时，最终状态产生后两分钟内发送文字结果；渲染成功时同时发送 1080 × 1440 PNG 报告卡。主机中断的运行在恢复流程启动后遵循同一时限。
- 同一 `runId` 不会重复发送已经确认的文字或图片。
- 微信发送不确定时停止自动重放，并在本地健康状态中明确显示。
- 报告、图片、ledger、日志和错误中不出现凭据、微信身份、Codex 会话 ID、绝对个人路径或原始命令输出。
- 微信无法触发、批准、恢复、停止或修改任何 Codex 任务。
- vendor 远程控制入口从未启动或复用；新增媒体代码通过固定提交、大小和 SHA-256 审计。
- 根测试、vendor 测试、类型检查、构建、LaunchAgent 检查和秘密扫描全部通过。
- 真实微信验证同时证明成功报告、受控失败报告和重复保护。

## 15. 产品扩展方向

当 v1 稳定后，WeChatPilot 可以把同一报告协议扩展到：

- 夜间测试、依赖与安全检查。
- GitHub issue、PR、CI 和 release 状态巡检。
- PPT 质量检查和可视化评分卡。
- 长文、小说或文档处理的进度与成果报告。
- 多个家庭项目的每日总览和每周趋势图。

这些扩展共享一个原则：任务在本机按预先授权的方式运行，微信只接收经过脱敏和验证的结果。
