# Codex WeChat Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, local Codex task observer that always records managed-job outcomes and sends a concise text summary plus a deterministic PNG report card to the single bound WeChat owner.

**Architecture:** A versioned managed-job registry launches one audited project-local task through `spawn(..., { shell: false })`, journals the run before child start, classifies completion or recovery, and normalizes an optional adapter result into a strict `RunReport`. A deterministic SVG-to-PNG renderer and a run-level delivery ledger then send text first and image second through the existing owner-bound WeChat adapter, failing closed on uncertain delivery.

**Tech Stack:** Node.js 22.23.1, TypeScript 7, Zod 4, YAML, Vitest 4, `@resvg/resvg-js` 2.6.2, macOS launchd, Tencent iLink media protocol, pinned `sgaofen/cli-in-wechat` commit `75d7db9338e133080fef9914b92ceb5e3ebd0dfc`.

---

## Scope boundary

This plan implements design phases 1 and 2: the report pipeline and the first WeChatPilot-managed Codex job (`daily-tech-digest`). It does not implement transparent discovery of Codex Desktop Scheduled tasks, Codex Hooks such as `Stop` or `PermissionRequest`, App Server subscriptions, WeChat approvals, inbound commands, or arbitrary job registration. Those require a separate approved specification and implementation plan after this managed-job path is proven.

Before Task 1, create a dedicated worktree and branch from commit `954ad5c` using the repository's worktree workflow. Use worktree `.worktrees/codex-wechat-observer` and branch `codex/codex-wechat-observer`; do not implement these tasks directly in the currently deployed checkout.

## File map

### New observer modules

- `src/observer/config.ts` — strict loading of `config/observer-jobs.yaml`; only the audited v1 job shape is accepted.
- `src/observer/report-policy.ts` — removes secrets, local paths, URLs, control characters, and bidirectional overrides from report text.
- `src/observer/run-report.ts` — authoritative `RunReport` and untrusted `RunReportDraft` schemas plus normalization.
- `src/observer/run-state.ts` — private run journal, atomic `running`/recovery-pending/final transitions, final-report listing, and stale-run recovery.
- `src/observer/task-lock.ts` — per-task live/stale process lock.
- `src/observer/report-card.ts` — fixed SVG layout and 1080 × 1440 PNG rendering.
- `src/observer/job-adapters.ts` — converts bounded `scheduled` CLI JSON into a safe draft without persisting stdout.
- `src/observer/managed-job.ts` — bounded child lifecycle with `shell: false`, safe environment propagation, timeout, and cancellation.

### New delivery and orchestration modules

- `src/delivery/wechat-media.ts` — audited iLink image preparation, AES upload, and final `image_item` send.
- `src/delivery/run-report-delivery.ts` — text-first/image-second run ledger and retry state machine.
- `src/app/observer.ts` — recovery, run, normalize, render, and deliver orchestration.
- `src/cli/observer.ts` — fixed `--project-root` and `--job daily-tech-digest` entry point.
- `src/cli/send-run-report-test.ts` — explicit live test-card sender with no recipient override.

### Configuration, scripts, and tests

- `config/observer-jobs.yaml` — one fixed v1 managed job.
- `scripts/send-run-report-test.sh` — explicit test-card command.
- `tests/observer/*.test.ts` — report, state, renderer, adapter, runner, and lock tests.
- `tests/delivery/wechat-media.test.ts` — media protocol and path boundary tests.
- `tests/delivery/run-report-delivery.test.ts` — run delivery ledger tests.
- `tests/app/observer.test.ts` and `tests/cli/observer.test.ts` — end-to-end orchestration without live WeChat.

### Existing files to modify

- `package.json`, `package-lock.json` — add the fixed renderer dependency and observer scripts.
- `src/lib/project-file.ts`, `tests/lib/project-file.test.ts` — add atomic private binary output.
- `src/delivery/wechat.ts`, `tests/delivery/wechat.test.ts` — prepare the image sender without exposing credentials.
- `config/vendor-wechat-artifacts.json`, `tests/vendor/artifact-integrity.test.ts` — audit upstream `ilink/client.js` media reference.
- `src/app/health.ts`, `tests/app/health.test.ts` — report observer config, renderer, and interrupted/outbox state without paths.
- `scripts/run-scheduled.sh`, `launchd/com.kdnsna.daily-tech-digest.plist`, `tests/launchd/*.test.ts` — route the existing schedule through the observer while preserving the service label.
- `README.md` — document the read-only observer, test command, health states, and recovery behavior.

---

### Task 1: Strict job configuration and safe run-report contract

**Files:**
- Create: `config/observer-jobs.yaml`
- Create: `src/observer/config.ts`
- Create: `src/observer/report-policy.ts`
- Create: `src/observer/run-report.ts`
- Test: `tests/observer/config.test.ts`
- Test: `tests/observer/run-report.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Create `tests/observer/config.test.ts` with cases that load the real file, reject an absolute/parent-traversing entry point, reject any second job in v1, and reject a command override:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadObserverConfig } from "../../src/observer/config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-observer-config-"));
  roots.push(root);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "observer-jobs.yaml"), yaml);
  return root;
}

describe("observer job configuration", () => {
  it("loads only the audited daily digest job", () => {
    const config = loadObserverConfig(process.cwd());
    expect(config.jobs).toEqual([
      expect.objectContaining({
        id: "daily-tech-digest",
        entrypoint: "dist/src/cli/scheduled.js",
        resultAdapter: "scheduled-digest-json-v1",
      }),
    ]);
  });

  it.each(["/tmp/evil.js", "../evil.js"])("rejects entrypoint %s", (entrypoint) => {
    const root = fixture(`version: 1\njobs:\n  - id: daily-tech-digest\n    name: 每日科技情报\n    projectLabel: WeChatPilot\n    executable: /opt/homebrew/opt/node@22/bin/node\n    entrypoint: ${entrypoint}\n    arguments: [--project-root, \"{projectRoot}\"]\n    workingDirectory: .\n    timeoutMs: 1200000\n    resultAdapter: scheduled-digest-json-v1\n    allowedArtifactRoot: output\n    notify: always\n`);
    expect(() => loadObserverConfig(root)).toThrow(/observer|entrypoint|configuration/iu);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the missing module failure**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js \
  test -- tests/observer/config.test.ts
```

Expected: FAIL because `src/observer/config.ts` does not exist.

- [ ] **Step 3: Add the exact v1 job file and loader**

Create `config/observer-jobs.yaml`:

```yaml
version: 1
jobs:
  - id: daily-tech-digest
    name: 每日科技情报
    projectLabel: WeChatPilot
    executable: /opt/homebrew/opt/node@22/bin/node
    entrypoint: dist/src/cli/scheduled.js
    arguments:
      - --project-root
      - "{projectRoot}"
    workingDirectory: .
    timeoutMs: 1200000
    resultAdapter: scheduled-digest-json-v1
    allowedArtifactRoot: output
    notify: always
```

Implement `ObserverConfigSchema` so v1 accepts exactly one job, literal executable/entrypoint/arguments/adapter values, `timeoutMs` from 1 second through 30 minutes, `workingDirectory: "."`, and `allowedArtifactRoot: "output"`. Export:

```ts
export type ObserverJob = z.infer<typeof ObserverJobSchema>;
export interface ObserverConfig { readonly version: 1; readonly jobs: readonly [ObserverJob]; }
export function loadObserverConfig(projectRoot: string): ObserverConfig;
export function findObserverJob(config: ObserverConfig, jobId: string): ObserverJob;
```

`findObserverJob` must throw the fixed message `Unknown observer job` without echoing the supplied ID.

- [ ] **Step 4: Write failing run-report policy tests**

Create `tests/observer/run-report.test.ts` and require these outcomes:

```ts
import { describe, expect, it } from "vitest";
import { buildRunReport, RunReportSchema } from "../../src/observer/run-report.js";

const authority = {
  runId: "11111111-1111-4111-8111-111111111111",
  taskId: "daily-tech-digest",
  taskName: "每日科技情报",
  projectLabel: "WeChatPilot",
  status: "success" as const,
  startedAt: new Date("2026-07-19T00:00:00.000Z"),
  finishedAt: new Date("2026-07-19T00:01:30.000Z"),
};

describe("RunReport", () => {
  it("keeps authority fields and removes unsafe draft content", () => {
    const report = buildRunReport({
      authority,
      projectRoot: "/Users/example/private-project",
      draft: {
        version: 1,
        summary: ["完成 /Users/example/private-project token=secret-value"],
        metrics: [{ label: "结果", value: "https://private.invalid/path" }],
        artifacts: [],
      },
    });
    expect(RunReportSchema.parse(report)).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("/Users/example");
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(JSON.stringify(report)).not.toContain("https://");
    expect(report.durationMs).toBe(90_000);
  });

  it("falls back to a minimal summary when the draft is invalid", () => {
    const report = buildRunReport({ authority, projectRoot: process.cwd(), draft: null });
    expect(report.summary).toEqual(["任务已完成，未提供结构化业务摘要"]);
    expect(report.metrics).toEqual([]);
  });
});
```

- [ ] **Step 5: Implement report policy and schemas**

`RunReportDraftSchema` must contain only `version`, `summary`, `metrics`, `failure`, and project-relative `artifacts`. `RunReportSchema` must add authority fields and the enum:

```ts
export const RunStatusSchema = z.enum([
  "success",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
  "skipped",
]);
```

Implement `sanitizeReportText(value, { projectRoot, maximumCharacters })` with this order: call `redactSecrets`, remove C0/C1 controls except ordinary spaces, remove `U+202A`–`U+202E` and `U+2066`–`U+2069`, replace the exact project root and `/Users/<segment>/...` or `/home/<segment>/...` paths with `[LOCAL_PATH]`, replace URL-shaped text with `[URL]`, collapse whitespace, trim, and truncate with `…`. Reject an empty result rather than passing it to the card.

- [ ] **Step 6: Run focused and full tests, then commit**

Run the two focused files, then `npm test`. Expected: both focused files PASS and the existing suite has zero failures.

```bash
git add config/observer-jobs.yaml src/observer tests/observer/config.test.ts tests/observer/run-report.test.ts
git commit -m "feat: define observer jobs and run reports"
```

---

### Task 2: Private run journal, binary writes, and interrupted recovery

**Files:**
- Create: `src/observer/run-state.ts`
- Modify: `src/lib/project-file.ts`
- Test: `tests/observer/run-state.test.ts`
- Test: `tests/lib/project-file.test.ts`

- [ ] **Step 1: Add a failing private-binary-write test**

Append to `tests/lib/project-file.test.ts`:

```ts
it("atomically writes private binary content without following symlinks", () => {
  const root = project();
  const path = join(root, "output", "card.png");
  writeProjectBytesAtomic(root, path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  expect([...readFileSync(path)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
});
```

Run only this test file. Expected: FAIL because `writeProjectBytesAtomic` is not exported.

- [ ] **Step 2: Implement `writeProjectBytesAtomic` and reuse it for text**

Add:

```ts
export function writeProjectBytesAtomic(
  projectRoot: string,
  filePath: string,
  content: Uint8Array,
): void;
```

Use the same project/symlink checks, unique temporary file, `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, `0600`, `fsync`, rename, and cleanup behavior as the current text writer. Make `writeProjectTextAtomic` call the binary helper with `Buffer.from(content, "utf8")` so both paths retain one implementation.

- [ ] **Step 3: Write failing journal and recovery tests**

Create `tests/observer/run-state.test.ts` with a fixed clock and require:

```ts
const running = startRunRecord({
  projectRoot: root,
  runId: "22222222-2222-4222-8222-222222222222",
  job,
  runnerPid: 1234,
  startedAt: new Date("2026-07-19T01:00:00.000Z"),
});
expect(running.status).toBe("running");
updateRunChildPid({ projectRoot: root, runId: running.runId, childPid: 5678 });

expect(recoverInterruptedRuns({
  projectRoot: root,
  now: () => new Date("2026-07-19T01:05:00.000Z"),
  isProcessAlive: () => false,
})).toEqual({
  recovered: [
    expect.objectContaining({ status: "interrupted", taskId: "daily-tech-digest" }),
  ],
  activeTaskIds: [],
  invalidRecords: 0,
});
expect(recoverInterruptedRuns({
  projectRoot: root,
  now: () => new Date("2026-07-19T01:06:00.000Z"),
  isProcessAlive: () => false,
})).toEqual({ recovered: [], activeTaskIds: [], invalidRecords: 0 });
```

Also prove: a live runner or child PID appears in `activeTaskIds` and prevents recovery; a symlink, group-readable file, malformed JSON, oversized file, unknown task ID, or invalid UUID increments `invalidRecords`, is never rewritten, and never exposes its path or content.

- [ ] **Step 4: Implement strict state transitions**

Export these exact APIs:

```ts
export interface RunningRunRecord {
  readonly version: 1;
  readonly status: "running";
  readonly runId: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly projectLabel: string;
  readonly runnerPid: number;
  readonly childPid?: number;
  readonly startedAt: string;
}

export function startRunRecord(options: StartRunRecordOptions): RunningRunRecord;
export function updateRunChildPid(options: UpdateRunChildPidOptions): RunningRunRecord;
export function finishRunRecord(projectRoot: string, report: RunReport): void;
export interface RecoverInterruptedRunsResult {
  readonly recovered: readonly RunAuthority[];
  readonly activeTaskIds: readonly string[];
  readonly invalidRecords: number;
}
export function recoverInterruptedRuns(options: RecoverInterruptedRunsOptions): RecoverInterruptedRunsResult;
export function listFinalRunReports(projectRoot: string): readonly RunReport[];
export function inspectRunState(projectRoot: string): {
  readonly recoveryPending: number;
  readonly invalidRecords: number;
};
```

Store only under `.state/observer/runs/<runId>.json`. Each update must parse the existing private record and use `writeProjectTextAtomic`. Recovery may convert only a valid `running` record whose runner and child PIDs are both absent or confirmed dead; it writes `status: "recovery-pending"` before returning the authority so a second recovery cannot duplicate it. `finishRunRecord` replaces `running` or `recovery-pending` with the strict final `RunReport`. `listFinalRunReports` returns only valid private final reports and never raw running records.

- [ ] **Step 5: Run focused tests and commit**

Expected: `tests/lib/project-file.test.ts` and `tests/observer/run-state.test.ts` PASS; `git diff --check` emits no output.

```bash
git add src/lib/project-file.ts src/observer/run-state.ts tests/lib/project-file.test.ts tests/observer/run-state.test.ts
git commit -m "feat: journal observer runs and recover interruptions"
```

---

### Task 3: Deterministic SVG-to-PNG report card

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/observer/report-card.ts`
- Test: `tests/observer/report-card.test.ts`

- [ ] **Step 1: Install the pinned renderer dependency**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js \
  install --save-exact @resvg/resvg-js@2.6.2
```

Expected: `package.json` and `package-lock.json` contain exactly `2.6.2`; no unrelated dependency is upgraded.

- [ ] **Step 2: Write the failing renderer tests**

Create `tests/observer/report-card.test.ts`. Use a real normalized report and assert:

```ts
const artifact = renderReportCard({ projectRoot: root, report });
const png = readFileSync(artifact.pngPath);
expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
expect(png.readUInt32BE(16)).toBe(1080);
expect(png.readUInt32BE(20)).toBe(1440);
expect(statSync(artifact.pngPath).mode & 0o777).toBe(0o600);
expect(JSON.parse(readFileSync(artifact.jsonPath, "utf8"))).toEqual(report);
```

Add a hostile summary containing `<script>`, `href=`, an ampersand, and a bidi override. Export `buildReportCardSvg` for testing and assert the SVG contains escaped text, contains no `<script`, no `href=`, no `data:`, and no remote font reference.

- [ ] **Step 3: Run the renderer test and verify failure**

Expected: FAIL because `src/observer/report-card.ts` does not exist.

- [ ] **Step 4: Implement the fixed card**

Export:

```ts
export interface ReportCardArtifact {
  readonly pngPath: string;
  readonly jsonPath: string;
}

export function buildReportCardSvg(report: RunReport): string;
export function renderReportCard(options: {
  readonly projectRoot: string;
  readonly report: RunReport;
}): ReportCardArtifact;
```

The SVG must use `viewBox="0 0 1080 1440"`, a single safe system-font family string, fixed font sizes, and escaped text nodes. Map `success` to green, `failed`/`timed-out` to red, `cancelled`/`interrupted` to orange, and `skipped` to gray. Render with:

```ts
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1080 },
  font: { loadSystemFonts: true, defaultFontFamily: "PingFang SC" },
}).render().asPng();
```

Reject output above 5 MiB or with a wrong PNG signature/IHDR before writing it. Store both files under `output/run-reports/<Asia-Shanghai date>/<runId>.{png,json}` using atomic private writers.

- [ ] **Step 5: Run focused and full tests, then commit**

```bash
git add package.json package-lock.json src/observer/report-card.ts tests/observer/report-card.test.ts
git commit -m "feat: render deterministic Codex run cards"
```

---

### Task 4: Audited WeChat image upload and send-only adapter

**Files:**
- Create: `src/delivery/wechat-media.ts`
- Modify: `src/delivery/wechat.ts`
- Modify: `config/vendor-wechat-artifacts.json`
- Test: `tests/delivery/wechat-media.test.ts`
- Test: `tests/delivery/wechat.test.ts`
- Test: `tests/vendor/artifact-integrity.test.ts`

- [ ] **Step 1: Extend the upstream audit fixture before copying media behavior**

Add this exact artifact from pinned commit `75d7db9338e133080fef9914b92ceb5e3ebd0dfc`:

```json
{
  "path": "ilink/client.js",
  "bytes": 29893,
  "sha256": "d4374ca607458c44321c58a4d2a9af7e040fbd21f055319533a89ce33d4c171b"
}
```

Update `VENDOR_ARTIFACT_PATHS` in `src/delivery/wechat.ts`. Run `tests/vendor/artifact-integrity.test.ts`; expected PASS for the current built vendor and FAIL if a copied fixture changes one byte.

- [ ] **Step 2: Write failing media protocol tests**

Use a 1080 × 1440 PNG fixture inside a temporary project. Inject deterministic random bytes and a fake `VendorWechatAdapter`. Require exactly three requests:

1. `POST https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl` with `media_type: 1`, `no_need_thumb: true`, raw MD5, padded AES size, owner ID, and no context token in logs.
2. `POST https://novac2c.cdn.weixin.qq.com/c2c/upload?...` with `application/octet-stream` encrypted bytes.
3. `POST https://ilinkai.weixin.qq.com/ilink/bot/sendmessage` with one `item_list` entry of type `2`, `image_item.media.encrypt_type: 1`, and the owner-bound context token.

Add cases for: outside path, symlink, non-PNG, wrong IHDR dimensions, file above 5 MiB, expired login, missing `upload_param`, missing `x-encrypted-param`, final nonzero `ret`, and lost final response. Failures before the final `sendmessage` must throw a stable `WechatMediaPreparationError`; the lost final response must throw `WechatDeliveryIndeterminateError`, not a preparation error.

- [ ] **Step 3: Run the focused media tests and verify failure**

Expected: FAIL because `prepareWechatImageSender` and `wechat-media.ts` do not exist.

- [ ] **Step 4: Implement the minimal first-party media path**

`src/delivery/wechat-media.ts` must use only Node crypto/fs primitives and the injected `VendorWechatAdapter`. Keep these audited constants:

```ts
const CHANNEL_VERSION = "1.0.2";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const MAX_REPORT_PNG_BYTES = 5 * 1_024 * 1_024;
```

Use AES-128-ECB with PKCS#7 padding, `Math.ceil((rawSize + 1) / 16) * 16`, MD5 for `rawfilemd5`, a random 16-byte key, a random 16-byte hex `filekey`, and base64 of the key's 32-character hex form for `image_item.media.aes_key`. Upload preparation may not call a router or vendor client class.

In `src/delivery/wechat.ts`, add only closure-returning public APIs:

```ts
export type PreparedWechatImageSender = (
  imagePath: string,
) => Promise<{ readonly status: "sent" }>;

export async function prepareWechatImageSender(
  options: PrepareWechatImageSenderOptions,
): Promise<PreparedWechatImageSender>;

export async function sendWechatImage(
  options: SendWechatImageOptions,
): Promise<{ readonly status: "sent" }>;
```

The closure captures the already validated owner credentials/context; callers cannot choose a user or token. Set `retries: 0` on the final `sendmessage`. Never include response bodies, upload URLs, keys, user IDs, or tokens in thrown public errors.

Export `WechatMediaPreparationError` with the fixed public message `微信报告图片准备失败，未尝试发送图片消息`. It covers local PNG validation, `getuploadurl`, encryption, and CDN upload failures before the final `sendmessage`; the delivery ledger treats it as terminal `blocked`, not automatically retryable.

- [ ] **Step 5: Run focused, vendor, and full tests, then commit**

```bash
git add src/delivery/wechat-media.ts src/delivery/wechat.ts config/vendor-wechat-artifacts.json tests/delivery tests/vendor/artifact-integrity.test.ts
git commit -m "feat: send audited WeChat report images"
```

---

### Task 5: Text-first report delivery ledger

**Files:**
- Create: `src/delivery/run-report-delivery.ts`
- Test: `tests/delivery/run-report-delivery.test.ts`

- [ ] **Step 1: Write the failing success and resume tests**

Create a valid report and assert:

```ts
const first = await deliverRunReport({
  projectRoot: root,
  report,
  imagePath,
  sendText,
  sendImage,
  now: () => NOW,
});
expect(first).toEqual({
  status: "sent",
  textChunks: 1,
  image: "sent",
  imageAttempt: 1,
});
await expect(deliverRunReport({
  projectRoot: root,
  report,
  imagePath,
  sendText,
  sendImage,
  now: () => NOW,
})).rejects.toBeInstanceOf(RunReportAlreadySentError);
expect(sendText).toHaveBeenCalledOnce();
expect(sendImage).toHaveBeenCalledOnce();
```

Add a second test where text succeeds and image receives one explicit `WechatDeliveryRejectedError`. On the next call with the same `runId`, assert text is not sent again and only image attempt 2 runs.

- [ ] **Step 2: Add failing closed-state tests**

Require these transitions:

- text lost response or partial text -> `indeterminate`, never retry either part;
- image lost response -> `indeterminate`, never retry image;
- login expired -> `failed` with safe `failureKind: "login-expired"`;
- `WechatMediaPreparationError` -> `failed` with `failureKind: "media-preparation"`, disposition `blocked`, and no automatic retry;
- three explicit rejections of the same pending part -> `RunReportRetryLimitError`;
- renderer provided no image -> text-only final `sent` with `image: "not-generated"`;
- concurrent same-run delivery -> `RunReportDeliveryBusyError`;
- a ledger with wrong mode, malformed JSON, wrong run hash, or symlink -> `RunReportDeliveryIndeterminateError`.

- [ ] **Step 3: Run the focused tests and verify failure**

Expected: FAIL because `src/delivery/run-report-delivery.ts` does not exist.

- [ ] **Step 4: Implement the strict ledger union and formatter**

Use `.state/delivery/runs/<runId>.json` and `.state/locks/report-delivery-<runId>.lock`. The Zod union must contain only these statuses:

```ts
type RunDeliveryStatus =
  | "text-sending"
  | "text-sent"
  | "image-sending"
  | "failed"
  | "indeterminate"
  | "sent";
```

Every ledger includes `version: 1`, `runId`, `reportSha256`, timestamps, `textAttempt`, and `imageAttempt`. `sent` includes `textChunks` and `image: "sent" | "not-generated"`. Format the four-line WeChat text from the design; the formatter receives only `RunReport` and never paths or raw errors.

Retry only a part whose prior outcome is an explicit rejection and whose attempt is below 3. Write `*-sending` before the network call. If a process stops in `text-sending` or `image-sending`, the next call must convert it to `indeterminate`, not replay it.

Export read-only reconciliation helpers:

```ts
export type RunDeliveryDisposition =
  | "missing"
  | "retryable"
  | "sent"
  | "indeterminate"
  | "blocked";
export function runDeliveryDisposition(
  projectRoot: string,
  report: RunReport,
): RunDeliveryDisposition;
export function inspectRunDeliveryState(projectRoot: string): {
  readonly pendingDeliveries: number;
  readonly indeterminateDeliveries: number;
  readonly invalidLedgers: number;
};
```

`missing` and `retryable` are the only dispositions the app may submit to `deliverRunReport`. `sent`, `indeterminate`, and `blocked` are terminal until local operator review.

- [ ] **Step 5: Run focused and full tests, then commit**

```bash
git add src/delivery/run-report-delivery.ts tests/delivery/run-report-delivery.test.ts
git commit -m "feat: deliver run reports without duplicate sends"
```

---

### Task 6: Managed child runner, task lock, and scheduled-result adapter

**Files:**
- Create: `src/observer/task-lock.ts`
- Create: `src/observer/job-adapters.ts`
- Create: `src/observer/managed-job.ts`
- Test: `tests/observer/task-lock.test.ts`
- Test: `tests/observer/job-adapters.test.ts`
- Test: `tests/observer/managed-job.test.ts`

- [ ] **Step 1: Write task-lock tests**

Adapt the current scheduled lock fixture, but use `.state/locks/observer-<taskId>.lock`. Prove one live owner blocks another, a dead PID lock is removed only after file-identity verification, an invalid task ID never becomes a filename, and release never deletes a replacement file.

- [ ] **Step 2: Write scheduled JSON adapter tests**

Export `parseScheduledDigestResult(stdout: string)`. Test the exact mappings:

```ts
expect(parseScheduledDigestResult('{"ok":true,"status":"sent","date":"2026-07-19","chunks":2,"jobAttempt":1,"deliveryAttempt":1}\n')).toEqual({
  statusOverride: "success",
  draft: {
    version: 1,
    summary: ["今日日报已生成并发送"],
    metrics: [
      { label: "日期", value: "2026-07-19" },
      { label: "消息分段", value: "2" },
      { label: "任务尝试", value: "1" },
      { label: "发送尝试", value: "1" },
    ],
    artifacts: [],
  },
});
expect(parseScheduledDigestResult('{"ok":true,"status":"not-due","date":"2026-07-19"}\n').statusOverride).toBe("skipped");
expect(parseScheduledDigestResult('{"ok":true,"status":"already-sent","date":"2026-07-19","jobAttempt":1}\n').statusOverride).toBe("skipped");
```

Reject extra lines, output above 64 KiB, unknown fields, wrong dates, unsafe strings, and `ok: false`. Do not persist stdout.

- [ ] **Step 3: Write managed-runner lifecycle tests**

Inject a fake spawn implementation and assert:

- `shell` is exactly `false`;
- executable, entry point, arguments, and cwd come only from validated config;
- `HOME` and `CODEX_HOME` are copied unchanged if present, never invented or removed;
- only `HOME`, `CODEX_HOME`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `USER`, `LOGNAME`, `__CF_USER_TEXT_ENCODING`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`, and optional `GITHUB_TOKEN` reach the child;
- the runner writes `running` before spawn, then child PID, then final state;
- exit 0 maps through the adapter; exit nonzero becomes `failed`; timer becomes `timed-out`; `AbortSignal` becomes `cancelled`;
- stdout/stderr combined above 1 MiB terminates the child and returns `failed` without persisting output;
- SIGTERM is followed by SIGKILL after two seconds only if the child has not exited.

- [ ] **Step 4: Implement the runner APIs**

Export:

```ts
export interface ManagedJobOutcome {
  readonly authority: RunAuthority;
  readonly draft: RunReportDraft | null;
}

export async function runManagedJob(options: {
  readonly projectRoot: string;
  readonly job: ObserverJob;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly dependencies?: ManagedJobDependencies;
}): Promise<ManagedJobOutcome>;
```

Resolve entrypoint and cwd with project path guards. Expand only the literal `{projectRoot}` argument. Spawn the fixed Node executable with a string array, `shell: false`, and piped stdout/stderr. Preserve `HOME`/`CODEX_HOME` only by copying existing values; never assign replacements. The public failure summary is selected from a constant table and never derived from stderr.

- [ ] **Step 5: Run all observer-focused tests and commit**

```bash
git add src/observer/task-lock.ts src/observer/job-adapters.ts src/observer/managed-job.ts tests/observer
git commit -m "feat: run fixed Codex jobs under observation"
```

---

### Task 7: Observer orchestration and safe CLI

**Files:**
- Create: `src/app/observer.ts`
- Create: `src/cli/observer.ts`
- Test: `tests/app/observer.test.ts`
- Test: `tests/cli/observer.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write orchestration tests with injected dependencies**

Test these exact sequences:

```ts
expect(calls).toEqual([
  "load-config",
  "recover",
  "deliver-recovered",
  "acquire-task-lock",
  "run-job",
  "normalize",
  "finish-record",
  "render",
  "prepare-text",
  "prepare-image",
  "deliver-current",
  "release-task-lock",
]);
```

Add cases proving: no recovered or undelivered final reports skips `deliver-recovered`; final reports with `missing` or `retryable` delivery are reconciled before a new run; `sent`, `indeterminate`, and `blocked` dispositions are never replayed; an active task ID prevents a new job even when its old runner PID is dead but its child PID is alive; render failure still calls delivery with no image; invalid draft falls back to minimal report; delivery failure leaves the final run record intact and returns a nonzero CLI result; the task lock is released in `finally`.

- [ ] **Step 2: Write CLI boundary tests**

`runObserverCli` must accept only:

```text
--project-root <absolute-path> --job daily-tech-digest
```

Reject missing arguments, relative roots, other job IDs, `--command`, `--cwd`, `--recipient`, and extra flags. Success stdout is exactly one JSON line containing `ok`, `status`, and short `runId`; failure stderr contains only a stable error name and `inspect project logs`, never a path, token, user ID, command, or raw exception.

- [ ] **Step 3: Run focused tests and verify failure**

Expected: FAIL because the app and CLI modules do not exist.

- [ ] **Step 4: Implement app and CLI**

Export:

```ts
export async function runObserverJob(options: RunObserverJobOptions): Promise<RunReport>;
export async function runObserverCli(
  arguments_: readonly string[],
  io?: ObserverCliIo,
  dependencies?: ObserverCliDependencies,
  signal?: AbortSignal,
): Promise<0 | 1>;
```

`runObserverJob` performs recovery and outbox reconciliation first, then the current job. Every recovered authority is normalized with the fixed summary `任务因主机或进程中断，已在恢复后补记`; it is finalized, rendered, and delivered through the same ledger. It also compares every final run report from `listFinalRunReports` with `runDeliveryDisposition`, submitting only `missing` and `retryable` entries before a new run starts. If `activeTaskIds` contains the requested job, it exits busy rather than starting a duplicate child. Rendering errors are logged through `createJsonlLogger` with a stable code and no error body; text delivery continues with `imagePath` omitted.

Add package scripts without replacing the internal `scheduled` command yet:

```json
{
  "observer": "tsx src/cli/observer.ts --project-root \"/Users/kdnsna/Documents/微信 chat\" --job daily-tech-digest"
}
```

- [ ] **Step 5: Run focused and full tests, then commit**

```bash
git add src/app/observer.ts src/cli/observer.ts tests/app/observer.test.ts tests/cli/observer.test.ts package.json
git commit -m "feat: orchestrate observed Codex jobs"
```

---

### Task 8: Health checks, explicit test card, launchd routing, and documentation

**Files:**
- Create: `src/cli/send-run-report-test.ts`
- Create: `scripts/send-run-report-test.sh`
- Modify: `src/app/health.ts`
- Modify: `tests/app/health.test.ts`
- Modify: `scripts/run-scheduled.sh`
- Modify: `launchd/com.kdnsna.daily-tech-digest.plist`
- Modify: `tests/launchd/scripts.test.ts`
- Modify: `tests/launchd/plist.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing health tests**

Extend `ProjectHealthReport` with:

```ts
observer: {
  status: "ok" | "failed";
  configValid: boolean;
  rendererReady: boolean;
  pendingRecoveryReports: number;
  pendingDeliveries: number;
  indeterminateDeliveries: number;
  invalidStateRecords: number;
}
```

Tests must prove counts only, never run IDs or paths. Missing config/renderer or invalid state records are required failure. Pending recovery/delivery and indeterminate delivery keep `requiredReady` true but overall status `pending`, with stable diagnostics `observer recovery pending`, `observer delivery pending`, and `observer delivery requires review`.

- [ ] **Step 2: Implement an explicit, fixed test-card CLI**

`send-run-report-test.ts` creates a fixed `success` report named `Codex 微信值守员测试`, renders it, prepares the owner-bound text/image senders, and calls `deliverRunReport`. It accepts only optional `--project-root`; it has no recipient, user, command, attachment, status, message, or path override.

Add this script to `package.json` only after the CLI exists:

```json
{
  "report:test": "tsx src/cli/send-run-report-test.ts"
}
```

Create `scripts/send-run-report-test.sh` using the same project-root discovery and fixed Node 22 pattern as `scripts/send-test.sh`:

```bash
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && /bin/pwd -P)"
NODE22="/opt/homebrew/opt/node@22/bin/node"
cd "${PROJECT_ROOT}"
exec "${NODE22}" --import tsx "${PROJECT_ROOT}/src/cli/send-run-report-test.ts"
```

- [ ] **Step 3: Route the existing scheduled service through the observer**

Change `scripts/run-scheduled.sh` and the plist `ProgramArguments` from `dist/src/cli/scheduled.js` to:

```text
dist/src/cli/observer.js
--project-root
/Users/kdnsna/Documents/微信 chat
--job
daily-tech-digest
```

Preserve label `com.kdnsna.daily-tech-digest`, 08:00 schedule, `RunAtLoad`, working directory, log paths, `ExitTimeOut`, lack of `KeepAlive`, and the existing environment. Update launchd tests to assert the observer entry and exact job ID, and to reject remote-control/dangerous flags.

- [ ] **Step 4: Update README with exact operator behavior**

Document:

- `./scripts/send-run-report-test.sh` performs a real text+PNG send;
- `./scripts/run-scheduled.sh` now sends the digest and then its run card;
- the report card is deterministic, not AI-generated;
- `interrupted` is reported only after the next successful observer startup;
- `indeterminate` never auto-replays;
- WeChat cannot start, approve, resume, stop, or modify Codex;
- how to run health, inspect only safe counts, reinitialize an expired login, and uninstall the existing LaunchAgent.

- [ ] **Step 5: Run focused checks and commit**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js \
  test -- tests/app/health.test.ts tests/launchd/scripts.test.ts tests/launchd/plist.test.ts
/usr/bin/plutil -lint launchd/com.kdnsna.daily-tech-digest.plist
```

Expected: all focused tests PASS and `plutil` prints `OK`.

```bash
git add package.json src/cli/send-run-report-test.ts scripts/send-run-report-test.sh src/app/health.ts tests/app/health.test.ts scripts/run-scheduled.sh launchd tests/launchd README.md
git commit -m "feat: operate the Codex WeChat observer"
```

---

### Task 9: Full regression, security audit, and live acceptance gate

**Files:**
- Verify: all files changed by Tasks 1–8
- Produce locally: ignored `.state/observer/`, `.state/delivery/runs/`, and `output/run-reports/` artifacts
- Do not commit: credentials, report output, logs, run state, QR artifacts, or live response bodies

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js test
/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit
/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc --noEmit false --outDir dist
/usr/bin/plutil -lint launchd/com.kdnsna.daily-tech-digest.plist
git diff --check
```

Expected: zero failed tests, typecheck/build exit 0, plist `OK`, and no whitespace errors.

- [ ] **Step 2: Run boundary scans**

Run repository tests that prove the vendor router is never loaded, then scan changed code and built output for forbidden control surfaces:

```bash
rg -n "bridge/router|/approve|/deny|/shell|--yolo|danger-full-access|dangerously-bypass|allowStopFromWeixin" \
  src config scripts launchd tests
git status --ignored --short
```

Expected: matches exist only in negative tests, safety documentation, or forbidden-argument lists; `.state`, `output`, and `logs` are ignored; no credential-bearing file is tracked.

- [ ] **Step 3: Perform the explicit live test-card checkpoint**

After confirming `./scripts/health-check.sh` reports owner/context ready, run:

```bash
./scripts/send-run-report-test.sh
```

Acceptance evidence: with the computer online, login valid, and WeChat accepting requests, one safe text summary and one readable 1080 × 1440 PNG appear in the bound owner's WeChat within the design's two-minute limit（两分钟）; the run ledger records both as confirmed. Do not print or copy the token, owner ID, context token, upload URL, AES key, or response body.

- [ ] **Step 4: Verify duplicate and failure behavior without risking a second real report**

Use the integration-test harness, not a second live send, to replay the same `runId` and to simulate explicit rejection, lost response, timeout, and interrupted recovery. Expected: confirmed parts are never called twice, uncertain sends stop, and one recovery report is produced after restart.

- [ ] **Step 5: Run one real observed daily task**

Run:

```bash
./scripts/run-scheduled.sh
```

If it is before 08:00 Shanghai time, expect a gray `skipped` card. If the digest was already sent, expect a gray already-sent card. Otherwise expect the normal digest followed by one run card. Verify the existing daily digest ledger and the new run ledger both remain consistent.

- [ ] **Step 6: Final verification and commit**

Repeat Step 1 after the live run, run `./scripts/health-check.sh`, and confirm `git status --short` contains no runtime artifacts. If the acceptance pass required reviewed source/config/test/doc corrections, commit only those corrections; do not create an empty commit:

```bash
git add package.json package-lock.json config src scripts launchd tests README.md
git commit -m "feat: add Codex run reports for WeChat"
```

Do not load or reload the LaunchAgent in this task. Present the verified plist and ask for explicit user confirmation before changing the installed service.

## Plan self-review checklist

- Design sections 3–14 are covered by Tasks 1–9: strict reports, deterministic PNG, audited media, text-first delivery, run journal, recovery, safe config, tests, health, and acceptance.
- `RunReport`, `RunReportDraft`, `RunAuthority`, `ObserverJob`, `PreparedWechatImageSender`, and `ManagedJobOutcome` names remain consistent throughout the plan.
- The plan preserves the existing daily digest sender and ledger; it wraps the scheduled CLI rather than duplicating digest generation.
- The new runner never accepts a command, cwd, recipient, user, arbitrary attachment, or approval override from CLI or WeChat.
- Power loss is not claimed as an immediate notification; it becomes exactly one `interrupted` report after observer recovery.
- Phase 3 Codex Hooks/App Server/native Scheduled discovery is explicitly excluded and requires a separate design after v1 evidence exists.
- Live WeChat and LaunchAgent mutations remain explicit user checkpoints.
