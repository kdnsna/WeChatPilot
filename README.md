# WeChatPilot

WeChatPilot 是一个本地优先、只向本人微信单向投递的自动化项目。当前内置工作流是“每日科技情报”。微信不能执行命令、控制 Codex 或选择收件人；凭据与投递状态只保存在被 Git 忽略且权限受限的 `.state/`。

> WeChatPilot 与微信、腾讯不存在隶属、授权或背书关系。

## 安装

要求 macOS、Node.js 22，以及已登录且可从 `PATH` 找到的官方 Codex CLI。仓库不保存个人路径，不提交可直接加载的部署 plist，也不要求固定 Homebrew 目录。

普通用户：

```sh
npm ci
npm run build
npm run wechatpilot -- init
npm run wechatpilot -- doctor
./scripts/init-wechat.sh
```

贡献者使用 `./scripts/init-project.sh` 安装依赖、执行测试、类型检查和构建；它与普通用户初始化分开。

统一命令：

```sh
npm run wechatpilot -- init
npm run wechatpilot -- doctor
npm run wechatpilot -- doctor --repair
npm run wechatpilot -- config validate
npm run wechatpilot -- run daily-tech-digest --dry-run
npm run wechatpilot -- schedule install --hour 8 --minute 0
npm run wechatpilot -- schedule status
npm run wechatpilot -- schedule remove
```

`schedule install` 在安装时探测 Node/Codex，生成当前用户专属 plist。v0.1 固定使用简体中文、`Asia/Shanghai`、每日 08:00 与固定栏目配额；LaunchAgent 日历触发使用机器系统时区，因此运行机器也必须设为 `Asia/Shanghai`。`doctor` 默认输出人类可读结果（`--json` 保留机器格式），且默认只读；只有显式 `--repair` 才会删除已确认进程死亡、inode 未变化且未被 `sending/indeterminate` ledger 阻止的陈旧锁。

## 配置模型

- `UserConfig`：`config/sources.yaml`、`ranking.yaml`、`digest.yaml` 与 observer 的来源和通知策略；v0.1 的时区、语言、配额、栏目和篇幅为固定契约。
- `SecurityProfile`：代码中固定的 Codex 只读参数、禁用工具、stdin-only、输出上限、本人收件人约束和禁止参数。
- `ResolvedRuntime`：`wechatpilot init` 探测的 Node/Codex 绝对路径、版本与能力，写入私有 `.state/runtime.json`，不进入版本控制。

用户配置可修改，但不能覆盖安全参数。Codex 子进程保持 ephemeral、read-only、approval never，只通过 stdin 接收候选数据；Apps、插件、hooks、shell、浏览器、computer-use、多代理和额外目录均被禁用。

## 微信 transport 与供应链

项目不再携带 `cli-in-wechat` submodule，也不安装其 `undici` 或开发依赖。最小 transport 位于 `src/transport/wechat-transport.ts`，只实现扫码登录、重试请求和主动发送所需能力。运行时闭包、失效条件和机器可读 OpenVEX 见：

- `docs/security/runtime-closure.md`
- `security/openvex.json`

CI 会执行生产依赖审计，并禁止重新引入上游主入口、Router、适配器注册表、代理初始化器、`ProxyAgent` 或 `undici`。

## 正确性与网络安全

- 微信 `message_id` 使用 lossless JSON 解析并在内部、状态文件和去重集合中统一为规范十进制字符串；旧的安全整数状态会自动迁移。
- 来源链接每一跳只解析一次，验证全部地址均为公网后，把本次已验证地址钉入实际 TCP/TLS 连接；Host 与 TLS SNI 保持原域名，重定向后重新解析和验证。
- scheduled、日报投递和 observer 锁都记录 PID、nonce、createdAt，并在恢复与释放时核验文件身份。日报锁恢复还受 delivery ledger 约束，无法确认的发送绝不自动重放。

## 隐私与数据流

“本地优先”指调度、凭据、ledger、锁和审计在本地，不代表模型推理完全离线。候选标题、摘要和公开 URL 会进入 Codex 子进程；微信 Token、context token 和用户 ID 不会进入模型。详见 [PRIVACY.md](PRIVACY.md) 与 [DATA_FLOW.md](DATA_FLOW.md)。

## 目录布局

- `appRoot`：程序代码与内置资源
- `workspaceRoot`：用户配置、输出、历史、日志
- `stateRoot`：凭据、ledger、锁、outbox

兼容默认仍落在项目目录；可通过 profile root / 环境变量拆分。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 稳定性门禁

平台抽象 Issue #1 明确依赖七天稳定性复盘 Issue #4。复盘只允许输出脱敏计数和耗时分布，不包含正文、路径、身份或凭据。未收集满七个自然日时，项目不得宣称链路“已经稳定”，也不得开始通用平台抽象。

至少记录：每日成功/失败/跳过、来源降级、Codex 重写、链接替换与门禁失败、微信确定失败与不确定发送、重复拦截、陈旧锁与人工恢复、日报生成和投递耗时。

## 常用命令

```sh
npm test
npm run typecheck
npm run build
npm run audit:runtime
npm run check:transport-boundary
./scripts/generate-digest.sh --dry-run
./scripts/send-test.sh
./scripts/send-digest.sh --date YYYY-MM-DD
```

日志会递归脱敏。请勿在公开 Issue 提交 Token、Cookie、微信用户 ID、context token、二维码、私有正文、日志或本机路径。漏洞请使用 GitHub 私密安全报告。

WeChatPilot 自有代码采用 MIT License；第三方依赖见 `THIRD_PARTY_NOTICES.md` 与 `package-lock.json`。
