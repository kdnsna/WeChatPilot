# WeChatPilot GitHub Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the verified local digest project as WeChatPilot, publish it to a private `kdnsna/WeChatPilot` repository, and configure lightweight GitHub project management without disrupting the installed daily service.

**Architecture:** Public-facing names and repository metadata change to WeChatPilot while deployed identifiers, state paths, and the loaded LaunchAgent remain stable. A branding contract test prevents accidental runtime renames, and repository publication is gated by full local verification and secret scans before GitHub metadata, labels, milestone, issues, and CI are validated.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Git, GitHub CLI, GitHub Actions, macOS launchd

---

## File map

- Create `tests/project/branding.test.ts`: enforce public WeChatPilot identity and deployed LaunchAgent compatibility.
- Modify `README.md`: present WeChatPilot as a local-first WeChat automation platform and retain the digest operating guide.
- Modify `package.json`: add non-secret public repository metadata and rename the private package.
- Modify `.github/ISSUE_TEMPLATE/config.yml`: replace the stale repository URL.
- Add `.github/workflows/ci.yml`: run root and pinned vendor verification on Node.js 22.
- Add `.github/CODEOWNERS`: protect security-sensitive project areas with owner review.
- Add `.github/pull_request_template.md`: require test and security-boundary attestations.
- Add `.github/ISSUE_TEMPLATE/bug_report.yml`: structured redacted bug reports.
- Add `.github/ISSUE_TEMPLATE/feature_request.yml`: structured, testable feature proposals.
- Add `.github/ISSUE_TEMPLATE/config.yml`: disable unstructured issues and link to the correct health-check guide.
- Add `docs/superpowers/plans/2026-07-19-wechatpilot-github-publication.md`: record this execution plan.

### Task 1: Add the branding and runtime-compatibility contract

**Files:**
- Create: `tests/project/branding.test.ts`
- Test: `tests/project/branding.test.ts`

- [x] **Step 1: Write the failing branding test**

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('WeChatPilot public identity', () => {
  it('uses the new public brand without renaming the deployed LaunchAgent', async () => {
    const [readme, packageText, issueConfig, launchd] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('package.json'),
      readProjectFile('.github/ISSUE_TEMPLATE/config.yml'),
      readProjectFile('launchd/com.kdnsna.daily-tech-digest.plist'),
    ]);
    const packageJson = JSON.parse(packageText) as Record<string, unknown>;

    expect(readme).toContain('# WeChatPilot');
    expect(readme).toContain('Local-first AI automation for WeChat');
    expect(readme).toContain('非微信或腾讯官方项目');
    expect(packageJson.name).toBe('wechatpilot');
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/kdnsna/WeChatPilot.git',
    });
    expect(issueConfig).toContain('github.com/kdnsna/WeChatPilot/');
    expect(launchd).toContain('com.kdnsna.daily-tech-digest');
    expect(launchd).not.toContain('com.kdnsna.wechatpilot');
  });
});
```

- [x] **Step 2: Run the focused test and verify the old branding fails**

Run:

```sh
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  node_modules/vitest/vitest.mjs run tests/project/branding.test.ts
```

Expected: FAIL because `README.md`, `package.json`, and the issue contact link still use the old public identity.

### Task 2: Apply the public WeChatPilot identity

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `.github/ISSUE_TEMPLATE/config.yml`
- Test: `tests/project/branding.test.ts`

- [x] **Step 1: Replace the README title and opening positioning**

Use this opening while retaining all existing operational and security documentation below it:

```markdown
# WeChatPilot

> Local-first AI automation for WeChat

WeChatPilot 是一个运行在本机的微信 AI 自动化平台。当前内置的第一个工作流是“每日科技情报”：它每天收集过去 24 小时的技术信号，用透明指标完成归一化、聚类、排序和七日去重，再通过受限的 `codex exec` 生成中文日报，最后单向推送到扫码绑定的微信 Chatbot。后续工作流将复用同一套本地调度、权限、投递和审计基础设施。

> [!IMPORTANT]
> WeChatPilot 是独立、非微信或腾讯官方项目，与微信及腾讯不存在隶属、授权或背书关系。
```

- [x] **Step 2: Add private-package repository metadata**

Set these top-level fields in `package.json` without changing runtime scripts or dependency versions:

```json
{
  "name": "wechatpilot",
  "version": "0.1.0",
  "private": true,
  "description": "Local-first AI automation for WeChat",
  "homepage": "https://github.com/kdnsna/WeChatPilot#readme",
  "bugs": {
    "url": "https://github.com/kdnsna/WeChatPilot/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/kdnsna/WeChatPilot.git"
  }
}
```

- [x] **Step 3: Correct the issue-template health-check link**

```yaml
blank_issues_enabled: false
contact_links:
  - name: 本地健康检查
    url: https://github.com/kdnsna/WeChatPilot/blob/main/README.md#初始化与本地命令
    about: 提交 Issue 前先运行 README 中的健康检查。
```

- [x] **Step 4: Run the focused test and verify it passes**

Run the Task 1 command again.

Expected: 1 test file passed; the public brand is WeChatPilot and the deployed LaunchAgent label remains `com.kdnsna.daily-tech-digest`.

### Task 3: Validate GitHub repository controls

**Files:**
- Add: `.github/workflows/ci.yml`
- Add: `.github/CODEOWNERS`
- Add: `.github/pull_request_template.md`
- Add: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Add: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Add: `.github/ISSUE_TEMPLATE/config.yml`

- [x] **Step 1: Parse every YAML control file with the installed YAML library**

Run:

```sh
/opt/homebrew/opt/node@22/bin/node --input-type=module -e '
import fs from "node:fs";
import YAML from "yaml";
for (const path of [
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
]) YAML.parse(fs.readFileSync(path, "utf8"));
console.log("github-yaml: ok");
'
```

Expected: `github-yaml: ok`.

- [x] **Step 2: Confirm CI is least-privilege and pinned**

Run:

```sh
rg -n 'contents: read|actions/checkout@[0-9a-f]{40}|actions/setup-node@[0-9a-f]{40}|node-version: 22|npm test|npm run typecheck|npm run build|vendor/cli-in-wechat test' .github/workflows/ci.yml
```

Expected: all policies and commands are found; no floating action tag appears.

### Task 4: Run release gates and inspect the exact publish scope

**Files:**
- Test: all root and vendor tests
- Inspect: all tracked and untracked publication files

- [x] **Step 1: Run the complete local verification suite**

Run:

```sh
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js test
/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit
/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit false --outDir dist
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js \
  --prefix vendor/cli-in-wechat test
```

Expected: root tests, type checking, build, and all 81 pinned-vendor tests pass.

- [x] **Step 2: Verify the submodule pin and LaunchAgent syntax**

Run:

```sh
git -C vendor/cli-in-wechat rev-parse HEAD
/usr/bin/plutil -lint launchd/com.kdnsna.daily-tech-digest.plist
```

Expected: commit `75d7db9338e133080fef9914b92ceb5e3ebd0dfc` and `OK`.

- [x] **Step 3: Inspect ignored and tracked paths for sensitive artifacts**

Run:

```sh
git status --short
git check-ignore .env .state/wechat logs/launchd.stdout.log output/2026-07-19.txt data/raw/2026-07-19
git ls-files | rg '(^|/)(\.env$|\.state/.+|logs/.+\.log$|output/.+\.(txt|json)$|data/raw/.+|context|login-qr)' || true
git grep -nEI '(bot[_-]?token|context[_-]?token|authorization:|cookie:|dangerously-bypass-approvals-and-sandbox)' -- ':!package-lock.json' ':!docs/superpowers/**' || true
```

Expected: runtime paths are ignored; no tracked private artifact appears; any source-code matches are policy names or redaction tests, not credential values.

### Task 5: Commit the approved publication surface on `main`

**Files:**
- Stage: `README.md`, `package.json`, `.github/`, `tests/project/branding.test.ts`, and this plan

- [x] **Step 1: Rename the initial branch and stage only approved files**

Run:

```sh
git branch -m main
git add README.md package.json .github tests/project/branding.test.ts docs/superpowers/plans/2026-07-19-wechatpilot-github-publication.md
git diff --cached --check
git status --short --branch
```

Expected: branch `main`; only the approved WeChatPilot and repository-management files are staged.

- [x] **Step 2: Commit the publication changes**

Run:

```sh
git commit -m "chore: launch WeChatPilot brand"
```

Expected: one new local commit after the verified baseline.

### Task 6: Create and push the private GitHub repository

**Files:**
- Remote state only; no new local files

- [x] **Step 1: Reverify GitHub identity, target availability, and repository scope**

Run:

```sh
gh auth status
gh api user --jq '{login,id}'
gh repo view kdnsna/WeChatPilot --json nameWithOwner 2>/dev/null || true
git remote -v
```

Expected: active login `kdnsna`; target repository absent; no conflicting remote.

- [x] **Step 2: Create the private repository and push `main`**

Run:

```sh
gh repo create WeChatPilot \
  --private \
  --source=. \
  --remote=origin \
  --description='Local-first AI automation for WeChat — scheduled digests today, extensible chatbot workflows tomorrow.' \
  --push
```

Expected: `https://github.com/kdnsna/WeChatPilot` is created, `main` is pushed, and `origin/main` tracks the local branch.

Execution note: GitHub CLI 2.88.1 misclassified the isolated Git worktree because `git rev-parse --git-dir` returned the worktree's absolute gitdir instead of `.git`. The repository was therefore created with `gh repo create kdnsna/WeChatPilot --private`, then connected and pushed with `git remote add origin git@github.com:kdnsna/WeChatPilot.git` and `git push -u origin main`. The resulting remote and branch state are equivalent to the planned command.

### Task 7: Configure repository metadata and project management

**Files:**
- GitHub repository settings, labels, milestone, and issues

- [x] **Step 1: Configure merge policy, features, and topics**

After checking `gh repo edit --help` for supported flags, configure:

```sh
gh repo edit kdnsna/WeChatPilot \
  --description='Local-first AI automation for WeChat — scheduled digests today, extensible chatbot workflows tomorrow.' \
  --homepage='https://github.com/kdnsna/WeChatPilot#readme' \
  --enable-issues \
  --enable-wiki=false \
  --enable-discussions=false \
  --enable-projects=false \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --enable-squash-merge \
  --delete-branch-on-merge \
  --add-topic=wechat \
  --add-topic=wechat-bot \
  --add-topic=ai-agent \
  --add-topic=automation \
  --add-topic=local-first \
  --add-topic=typescript \
  --add-topic=nodejs \
  --add-topic=codex \
  --add-topic=launchd
```

Expected: repository settings and nine topics match the approved design.

- [x] **Step 2: Create the project labels**

Create or update these exact label definitions using `gh label create --force --repo kdnsna/WeChatPilot`:

```text
area:collectors  1D76DB  数据源采集与降级
area:ranking     5319E7  热度计算、聚类与去重
area:digest      A371F7  Codex 生成、校验与内容结构
area:wechat      0E8A16  微信绑定与单向投递
area:automation  FBCA04  调度、幂等与工作流基础设施
security         B60205  安全边界、凭据与权限
maintenance      C5DEF5  维护、升级与稳定性
priority:high    D93F0B  高优先级
priority:medium  E4E669  中优先级
triage           D4C5F9  等待分类
```

Expected: all ten labels exist with descriptions and stable colors.

- [x] **Step 3: Create the v1.1 milestone**

Run:

```sh
gh api --method POST repos/kdnsna/WeChatPilot/milestones \
  -f title='v1.1 通用 Chatbot 基础' \
  -f description='把科技日报沉淀为首个内置工作流，建立通用、安全、可审计的本地微信 Chatbot 基础。'
```

Expected: one open milestone named `v1.1 通用 Chatbot 基础`.

- [x] **Step 4: Create four scoped issues in the milestone**

Create the following issues with `gh issue create --repo kdnsna/WeChatPilot --milestone 'v1.1 通用 Chatbot 基础'`:

```text
抽象通用消息、事件与工作流接口
  labels: enhancement, area:automation, priority:high
  acceptance: digest becomes a registered workflow; typed event/result contracts; existing scheduled digest remains compatible.

设计安全的入站消息权限模型，明确禁止远程 Shell
  labels: enhancement, security, area:wechat, priority:high
  acceptance: one-owner identity binding; deny-by-default actions; no shell/Codex remote control; threat-model tests.

建立插件与工作流注册机制
  labels: enhancement, area:automation, priority:medium
  acceptance: explicit registry; per-workflow configuration and permission declaration; isolated failure handling.

完成每日推送一周稳定性复盘
  labels: maintenance, area:automation, priority:medium
  acceptance: seven days of delivery evidence; duplicate/error/retry review; redacted-log and ledger audit.
```

Expected: four open, labeled issues attached to the milestone.

### Task 8: Verify the public GitHub surface and CI

**Files:**
- Inspect GitHub state and local Git state

- [x] **Step 1: Verify repository identity and settings**

Run:

```sh
gh repo view kdnsna/WeChatPilot --json nameWithOwner,url,visibility,defaultBranchRef,description,homepageUrl,repositoryTopics,hasIssuesEnabled,hasWikiEnabled,hasDiscussionsEnabled,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,deleteBranchOnMerge
gh label list --repo kdnsna/WeChatPilot --limit 100
gh api repos/kdnsna/WeChatPilot/milestones --jq '.[] | {title,state,open_issues}'
gh issue list --repo kdnsna/WeChatPilot --milestone 'v1.1 通用 Chatbot 基础' --limit 20
```

Expected: private `main` repository, approved settings/topics, ten custom labels, one open milestone, and four open issues.

- [x] **Step 2: Wait for the first CI run and require success**

Run:

```sh
gh run list --repo kdnsna/WeChatPilot --workflow CI --branch main --limit 1 --json databaseId,status,conclusion,url
gh run watch --repo kdnsna/WeChatPilot <database-id> --exit-status
```

Expected: the initial `main` CI run concludes `success`. If it fails, inspect with `gh run view --log-failed`, fix the demonstrated cause, rerun local gates, commit, push, and recheck.

- [x] **Step 3: Perform the final local publication audit**

Run:

```sh
git status --short --branch
git remote -v
git log --oneline --decorate -3
git submodule status
```

Expected: clean `main` tracking `origin/main`; exactly the intended remote; pinned vendor submodule; no private runtime artifacts tracked.
