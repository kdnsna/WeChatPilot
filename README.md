# WeChatPilot

> Local-first AI automation for WeChat

WeChatPilot 是一个运行在本机的微信 AI 自动化平台。当前内置的第一个工作流是“每日科技情报”：它每天收集过去 24 小时的技术信号，用透明指标完成归一化、聚类、排序和七日去重，再通过受限的 `codex exec` 生成中文日报，最后单向推送到扫码绑定的微信 Chatbot。后续工作流将复用同一套本地调度、权限、投递和审计基础设施。

> [!IMPORTANT]
> WeChatPilot 是独立、非微信或腾讯官方项目，与微信及腾讯不存在隶属、授权或背书关系。

项目不会从微信执行命令，不会启动 `cli-in-wechat` 的 Router、Codex 适配器或远程控制入口，也不会使用 `--dangerously-bypass-approvals-and-sandbox`。微信不能启动、批准、恢复、停止或修改 Codex 任务；它在本项目中始终只是单向投递终点。微信凭据和 context token 只保存在本项目被 Git 忽略的 `.state/wechat/`，目录权限为 `0700`、文件权限为 `0600`；命令输出和日志只报告就绪状态，不显示具体值、用户 ID 或令牌。

## 产品方向

WeChatPilot 将科技日报作为首个经过真实运行验证的内置工作流，而不是把产品限制为资讯工具。后续版本会逐步抽象消息与事件接口、工作流注册、最小权限策略和可审计的本地插件机制。任何入站消息能力都必须经过独立安全设计；默认边界继续是单向发送，不开放远程 Shell、任意 Mac 命令或 Codex 远程控制。

## 运行环境

- macOS 当前用户权限，不需要 `sudo`。
- 固定运行时：`/opt/homebrew/opt/node@22/bin/node`（已验证为 Node 22.23.1）。
- Codex：由 `config/digest.yaml` 固定为检测到的 Node 可执行文件与官方 CLI JavaScript 入口。
- 微信依赖：`vendor/cli-in-wechat` Git submodule，固定提交 `75d7db9338e133080fef9914b92ceb5e3ebd0dfc`，不跟随任何分支。构建后仅对未跟踪的 QR 运行时产物应用已审计的 45 秒长轮询补丁，上游源码和 submodule 指针保持不变。

不要运行 vendor 内的 `npm start`、`npm run dev` 或其主入口。项目只校验并动态加载审计过的 QR、HTTP 和加密辅助模块；构建产物必须同时通过 `config/vendor-wechat-artifacts.json` 的大小和 SHA-256 清单。

## 初始化与本地命令

项目根目录为：

```text
/Users/kdnsna/Documents/微信 chat
```

首次安装、vendor 构建和全部测试：

```sh
cd '/Users/kdnsna/Documents/微信 chat'
./scripts/init-project.sh
```

健康检查（不输出路径、用户 ID 或令牌）：

```sh
./scripts/health-check.sh
```

输出中的 `observer` 只有配置/渲染器/Image 2 就绪布尔值，以及待恢复、待发送、不确定投递、待生成视觉、固定背景视觉和无效状态记录的安全计数，不包含 run ID、期号、提示词或路径。待处理计数会把整体状态标为 `pending`，不代表必需环境损坏；无效配置、编号/视觉账本损坏、渲染器不可用或 Image 2 能力标记不匹配则返回 `failed`。健康检查不会为自证就绪而现场生成图片。若微信登录过期，重新运行 `./scripts/init-wechat.sh` 扫码初始化，不要手工编辑私有状态文件。

只准备 Codex 输入、检查安全参数而不调用 Codex：

```sh
./scripts/generate-digest.sh --dry-run
```

真实采集并生成本地日报，但不发送微信：

```sh
./scripts/generate-digest.sh
```

GitHub Token 是可选项；不设置时使用公开 API 降级运行。若临时提供，只应通过当前进程环境传入，不要写入仓库、配置或日志。

## 微信初始化与发送

首次绑定：

```sh
./scripts/init-wechat.sh
```

脚本显示二维码后：

1. 用本人微信扫码并在手机确认。
2. 向刚绑定的 Chatbot 发送一条纯文本 `初始化`（不要发送 `/init`）。
3. 脚本只接受扫码返回的本人账号、单一文本项和本次扫码开始之后的新消息；其他账号、旧消息、媒体和引用消息都被忽略。

如果当前客户端隐藏了终端二维码，初始化会在 `.state/wechat/login-qr.svg` 写入一个权限受限、被 Git 忽略的临时副本，供本机界面显示；绑定完成后可以删除该临时图，不影响登录状态。初始化有明确超时，登录失效时退出并要求重新扫码，不会后台无限重试。`allowedUsers` 在本地绑定状态中必须恰好包含扫码本人，发送命令不提供 `--user` 或其他目标选择能力。

发送测试消息：

```sh
./scripts/send-test.sh
```

显式发送一张固定值守员测试卡（会真实向已绑定本人微信发送文字和 PNG）：

```sh
./scripts/send-run-report-test.sh
```

测试卡没有收件人、命令、附件、模型、提示词或消息覆盖参数。Codex 内置 Image 2 只生成不含文字的主视觉；所有中文、期号、信号、行动和审计字段由本地确定性模板渲染。

发送指定日期的完整日报：

```sh
./scripts/send-digest.sh --date 2026-07-18
```

长文本遵循固定上游逻辑：每段最多 2000 个 JavaScript 字符单元，依次优先在段落、换行、空格处分段，最后才硬切，段间等待 300ms。主动发送 POST 不做未经证明的网络重放；响应丢失或部分分段成功会记为 `indeterminate`，当天停止自动重发，避免重复。完整日报使用原子锁和每日 ledger；成功后同一天任何再次调用都会被拒绝。确定失败最多允许初次加两次重试。

## 编辑部情报长图与 Image 2

每个新的最终 Observer 运行报告会获得一个连续期号，例如 `WP-000021`，并对应唯一的视觉账本、主视觉和最终 PNG。成功、跳过、失败、超时、取消、中断和恢复报告共用同一条期号序列。同一 run 重试时复用原期号、主视觉、报告内容和最终长图，不再分配新期号或重复生成。

长图固定为 1080 × 2400 PNG，从上到下包含五个区域：

1. 无文字主视觉、报告身份、期号、状态与时间。
2. `EXECUTIVE BRIEF` 今日结论。
3. 最多五项带 `01`–`05` 编号的重点信号、为何重要、来源数、置信度和影响。
4. 三项可执行的下一步行动。
5. Codex 执行与交付审计，包含候选/入选数、来源覆盖、耗时、视觉模式和短 run ID。

Image 2 使用本机已登录的 Codex 内置认证，项目不读取、保存或要求 OpenAI API key。图片子进程仅接收经脱敏的视觉摘要，从 stdin 输入，且固定为临时、非交互、项目根目录、`read-only`、`approval never`。它只启用 `image_generation`，显式关闭 shell、unified exec、browser、computer use、Apps、plugins、hooks、多代理和额外目录；不接收微信消息、收件人、凭据、源 URL、完整日报、本机私有路径或可执行指令。

先验证能力，再生成本地预览，最后才实发：

```sh
npm run report:image-probe
npm run health
npm run report:preview
npm run report:test
```

`report:image-probe` 会调用一次相同的生产图片路径，完成后只保存 Codex 版本、样式版本、成功时间和产物哈希，并删除经文件身份核对的项目内探测图。`report:preview` 生成固定长图但不加载任何微信发送器。`report:test` 生成五项固定信号与三项行动，获得真实期号，然后向已绑定本人发送一次文字和长图。

主视觉最多尝试三次；三次都失败后生成确定性品牌背景，图上如实标注 `AI 主视觉暂不可用`，详细正文仍可投递。如果最终合成失败，文字和图片都不发送，最终报告与视觉账本保留供恢复；只有微信明确拒绝才在次数上限内重试，响应丢失则记为 `indeterminate` 且永不自动重放。

图片在微信发送之前已完成渲染，因此它只能声明 `报告图：已生成`，不得声明自己未来的微信投递已经成功。真实投递结果只由图片之外的私有 delivery ledger 确认。

紧急回滚无需更换代码或破坏新账本：只将 `config/report-visual.yaml` 中的 `mode: editorial` 改为 `mode: legacy`，再重新加载同一份 schema-compatible Observer 构建。legacy 模式仍会分配期号，但跳过 Image 2 并使用旧报告卡渲染器。保留所有最终报告、期号、视觉账本和不确定投递记录，不要重置状态或自动补发。

## 数据源与降级

首期配置位于 `config/sources.yaml`：

- Hacker News：top/new stories，保留分数、评论、作者、时间和 HN 讨论页。
- V2EX：热门主题，保留回复数、节点、作者和链接。
- GitHub：公开 Search API；可选 Token。保留 Star、Fork、语言、更新时间和本地快照测得的真实增长窗口。首次运行没有历史快照时明确标为不可得。
- 科技媒体与 AI 官方博客 RSS：每个 feed 独立失败，列表可在 YAML 中调整。
- Reddit RSS：可降级来源；403、429、超时或解析失败不会拖垮其他来源。

采集器通过 `Promise.allSettled` 风格的结果封装彼此隔离。单源失败会写入脱敏状态并继续；只有可用核心来源不足时任务才失败。HTTP 请求不携带环境 Cookie，设有超时、大小和并发上限。

## 热度公式

不同平台的原始评论、回复、积分和 Star 不直接相加。每项指标先按来源家族做 midrank 百分位；真实的 0 保留为观测值，缺失指标使用中性值 `0.5`。

默认分数（所有权重均可在 `config/ranking.yaml` 调整）：

```text
base =
  0.24 × engagement_percentile
  + 0.20 × popularity_percentile
  + 0.18 × velocity_percentile
  + 0.18 × 2^(-age_hours / 12)
  + 0.12 × cross_source_confirmation
  + 0.08 × source_quality

heatScore = 100 × base × historyFactor
```

- `engagement`：HN/Reddit 评论数、V2EX 回复数等来源内讨论指标。
- `popularity`：来源内积分或 Star。
- `velocity`：社区评论每小时；GitHub 优先使用本地快照按真实窗口归一化的 Star 增长，快照不可得时才显示项目生命周期速率，绝不冒充 24 小时新增。
- `recency`：12 小时半衰期。
- `cross_source_confirmation`：同一事件的不同来源数，默认 4 个来源封顶。
- `source_quality`：HN/GitHub 1.0、V2EX/RSS 0.9、Reddit 0.7。
- `historyFactor`：过去 7 天已推送的同链接或高相似标题默认乘 `0.35`，否则为 `1.0`。

生成日报时会写入一份与正文 SHA-256 绑定的私有入选清单；只有微信明确确认发送成功后，才把其中的真实入选 URL、标题和来源写入 `data/history/sent-items.json`。这样下一次排名读取的确实是“已推送历史”，生成失败或微信明确拒绝不会误降权。

聚类先移除常见跟踪参数并比较规范 URL，再使用标题 token 与字符 bigram 相似度。一个事件只保留一个代表条目，但相关来源、交叉印证和可访问备选链接会保留给日报生成器。排名结果中的 `components`、`reason`、`confirmedBy` 和 `velocityMetric` 可解释每条内容为何入选。

## Codex 安全边界

应用先根据本机实际 `codex exec --help` 固化兼容参数。当前调用使用绝对 Node 22 和 Codex JavaScript 入口，并包含：

```text
--search
--sandbox read-only
--ask-for-approval never
--cd <project-root>
exec --ephemeral --ignore-user-config --ignore-rules
--color never --output-schema <project-schema> -
```

候选数据只经 stdin 传入；子进程环境采用白名单，移除 GitHub/OpenAI/bot 等 Token。apps、plugins、hooks、shell、browser/computer-use、多代理、工作区依赖和额外目录能力被显式关闭。输出必须通过本地 JSON Schema、标题/日期、3/5/3/2 栏目、2000–3000 正文字符和来源 URL 双向一致校验；失败最多重写两次。

生成后还会对 13 个来源做无凭据 GET 检查：15 秒总期限、逐跳 DNS 与私网地址校验、最多 5 次人工处理的重定向。不可访问的 HN 原文只允许换成同一候选的严格 HN 讨论页；找不到同候选可访问备选时不发送日报。

## 文件与排查

```text
src/collectors/       数据采集
src/normalizers/      统一数据结构
src/ranking/          百分位、聚类与热度
src/digest/           候选输入、Codex、校验与链接检查
src/delivery/         本人绑定、微信发送、锁与每日 ledger
src/app/              采集/生成编排、健康检查与定时重试锁
config/               来源、排名、Codex 与审计清单
prompts/              日报提示词
data/raw/             每次原始与排名证据（Git 忽略）
data/history/         GitHub 快照与七日发送历史（Git 忽略）
output/               日报 TXT/JSON（Git 忽略）
logs/                 JSONL 日志（Git 忽略）
.state/               微信、锁和发送状态（Git 忽略）
launchd/              使用本机实际绝对路径的 LaunchAgent
```

所有项目文件写入都限制在项目根目录内，拒绝路径穿越和 symlink 逃逸。日志经过递归脱敏；QR 内容只交给终端渲染器及项目内私有临时 SVG，bot token、context token、Authorization、Cookie 和 Codex 凭据不会进入日报、日志、错误详情或 Git。

## 测试

在固定 Node 22 下执行：

```sh
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js test

/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit
/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit false --outDir dist
```

测试覆盖采集、单源降级、百分位与去重、GitHub 快照窗口、Codex 命令边界、提示词注入、输出结构、链接 SSRF 防护、微信本人绑定、旧消息拒绝、大整数消息 ID、分段、凭据 host 限制、vendor 产物篡改、并发锁、发送不确定态、每日幂等、定时重试边界和 LaunchAgent 结构。

## 定时任务状态

已生成并通过 `plutil` 校验：

```text
/Users/kdnsna/Documents/微信 chat/launchd/com.kdnsna.daily-tech-digest.plist
```

它使用当前用户和已检测到的绝对 Node 22、项目、构建产物与日志路径；每天本机时区 08:00 运行。当前 macOS 时区为 `Asia/Shanghai`，子进程也固定 `TZ=Asia/Shanghai`。`StartCalendarInterval` 在 Mac 休眠错过时间时会在唤醒后合并补跑一次，`RunAtLoad` 则覆盖首次加载或登录后重新加载；应用内的北京时间门槛会在 08:00 前返回 `not-due`，避免登录时早发。每日 ledger 保证当天已成功发送时不重复。全任务锁阻止并发，应用内部总共最多三次尝试（初次加两次重试），且只有明确可重试的失败才会重试。配置没有 `KeepAlive`，不会无限重启。

手动执行同一条定时流水线：

```sh
./scripts/run-scheduled.sh
```

该脚本现在由 Observer 启动受审计的 `daily-tech-digest` 任务：日报投递完成后，再发送对应的文字运行报告和 PNG 卡片。如果上次 Observer 在任务运行期间被主机或进程中断，`interrupted` 报告只会在下一次 Observer 成功启动并完成恢复检查后上报。投递状态为 `indeterminate` 时永不自动重放，必须由运维人员核查，避免向微信重复发送。

新环境默认不会自动加载 LaunchAgent。安装脚本必须收到显式确认参数，否则退出且不改动 LaunchAgent：

```sh
./scripts/install-launchd.sh --confirm-load
```

加载后可检查：

```sh
/bin/launchctl print "gui/$(/usr/bin/id -u)/com.kdnsna.daily-tech-digest"
./scripts/health-check.sh
```

要停用已存在的 LaunchAgent，使用专用卸载脚本。它只停止任务并删除用户 `LaunchAgents` 中这一份精确 plist，不删除项目、日报、日志或微信状态：

```sh
./scripts/uninstall-launchd.sh
```

标准输出与错误分别写入 `logs/launchd.stdout.log` 和 `logs/launchd.stderr.log`。业务过程的脱敏 JSONL 日志仍保存在 `logs/`；微信登录失效会单次退出并提示重新运行 `./scripts/init-wechat.sh`，不会无限重试。
