# WeChatPilot Brand and Repository Design

**Date:** 2026-07-19

**Status:** Approved in principle; awaiting final review of this written specification before repository publication.

## 1. Product decision

The public product name is **WeChatPilot** and the GitHub repository will be `kdnsna/WeChatPilot`.

- English tagline: **Local-first AI automation for WeChat**
- Chinese positioning: **微信里的本地 AI 自动化平台**
- Current flagship workflow: a verified daily technology-intelligence digest
- Long-term direction: a reusable local workflow engine for safe WeChat chatbot automations

The name keeps WeChat discoverability while leaving room beyond a single digest. Public materials must state that WeChatPilot is an independent, unofficial project and is not affiliated with or endorsed by WeChat or Tencent.

## 2. Product boundary

WeChatPilot evolves in two layers:

1. **Stable foundation now:** scheduling, source collection, evidence-backed ranking, Codex generation, one-way WeChat delivery, idempotency, redacted logs, and local state.
2. **General chatbot platform later:** inbound event adapters, an intent and command router, workflow/plugin registration, reusable outbound channels, per-workflow permissions, and an auditable execution policy.

The current release remains send-only by default. Publishing it under the new brand does not enable inbound remote control, arbitrary shell execution, a Codex control channel, or the upstream project's high-permission remote-control mode. Future inbound features require a separate security design and explicit user approval.

## 3. Architecture direction

```text
WeChat transport adapters
  -> identity and permission policy
  -> message / schedule event router
  -> registered workflows
       -> Daily Tech Digest (available now)
       -> future local automations
  -> constrained AI and tool adapters
  -> safe outbound delivery
  -> local audit trail and idempotency ledger
```

The technology digest becomes the first built-in workflow rather than the product's permanent top-level identity. Collection, ranking, generation, and delivery stay separated so later workflows can reuse the platform without inheriting digest-specific assumptions.

## 4. Naming migration and runtime compatibility

This publication changes the public brand and repository surface, not the already deployed runtime identity.

Change now:

- README title, product description, badges, repository links, examples, and public-facing language
- `package.json` description and non-breaking metadata where appropriate
- GitHub repository name, description, topics, templates, and issue links
- documentation language that presents the digest as the first built-in workflow

Preserve for this release:

- installed LaunchAgent label `com.kdnsna.daily-tech-digest`
- current LaunchAgent file path and service state
- `.state` files, delivery ledger, history, logs, and output paths
- existing internal module and script names that are part of the working deployment

This compatibility-first migration avoids interrupting the daily 08:00 service or causing a duplicate send. Operational identifiers can be migrated later with a dedicated state-migration and rollback plan.

## 5. GitHub repository design

Create the repository as **private** first at `https://github.com/kdnsna/WeChatPilot`, with `main` as the default branch.

Repository description:

> Local-first AI automation for WeChat — scheduled digests today, extensible chatbot workflows tomorrow.

Topics:

- `wechat`
- `wechat-bot`
- `ai-agent`
- `automation`
- `local-first`
- `typescript`
- `nodejs`
- `codex`
- `launchd`

Repository controls:

- GitHub Actions CI for Node.js 22 tests, type checking, and build
- CODEOWNERS for the repository owner
- structured bug and feature issue forms
- pull request template with testing and security checks
- Issues enabled; Wiki and Discussions disabled initially
- squash merge enabled and merged head branches deleted automatically
- no secret-bearing runtime artifacts in source control

The initial repository stays private while the public documentation, license decision, upstream attribution, and security disclosure path are completed. Public release is a later explicit decision.

## 6. Project management model

Use GitHub Issues, labels, and a milestone as the initial lightweight management system.

Labels:

- `area:collectors`
- `area:ranking`
- `area:digest`
- `area:wechat`
- `area:automation`
- `security`
- `maintenance`
- `priority:high`
- `priority:medium`
- `triage`

Create milestone **v1.1 通用 Chatbot 基础** with these initial issues:

1. 抽象通用消息、事件与工作流接口
2. 设计安全的入站消息权限模型，明确禁止远程 Shell
3. 建立插件与工作流注册机制
4. 完成每日推送一周稳定性复盘

The current GitHub CLI authorization does not include the `project` scope, so a GitHub Projects board is not required for the initial setup. Issues, labels, and the milestone provide full traceability without requesting broader credentials. A board can be added later after the user explicitly authorizes that scope.

## 7. Publication sequence

1. Preserve the verified local implementation as the baseline commit.
2. Apply the public WeChatPilot branding without renaming deployed runtime identifiers.
3. Run the full root and vendored test suites, type checking, build, CI configuration checks, and secret-path/value scans.
4. Create the private repository, push `main`, and verify visibility, remote URL, default branch, and commit identity.
5. Configure repository metadata, settings, topics, labels, milestone, and initial issues.
6. Verify the first GitHub Actions run and report any platform-side limitation explicitly.

## 8. Acceptance criteria

- The repository is named `WeChatPilot` and belongs to the verified `kdnsna` account.
- Public copy positions it as a local-first WeChat automation platform, with the tech digest as its first workflow.
- The disclaimer makes independence from WeChat and Tencent unambiguous.
- The installed daily service continues using its existing identifiers and state without interruption.
- CI passes on Node.js 22, and local root/vendor tests, type checking, and build remain green.
- No token, cookie, Codex credential, context token, QR/session artifact, generated digest, raw data, or private log is committed.
- GitHub issues and the v1.1 milestone describe the path toward a general chatbot without enabling unsafe remote execution.
