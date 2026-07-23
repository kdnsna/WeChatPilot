# Release P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the six P0 release blockers without expanding the WeChat delivery boundary.

**Architecture:** Harden the transport at its shared fetch boundary, make report delivery use one persisted canonical payload, and make runtime/configuration explicit inputs. Treat unsupported v0.1 options as validation errors. Make CI create all of its dependencies deterministically.

**Tech Stack:** Node.js 22, TypeScript, Zod, Vitest, GitHub Actions, macOS launchd.

---

### Task 1: Stop all implicit WeChat redirects

**Files:**
- Modify: `src/transport/wechat-transport.ts`
- Test: `tests/delivery/wechat.test.ts`
- Test: `tests/security/wechat-boundary.test.ts`

- [ ] **Step 1: Write failing redirect tests**

```ts
it.each([301, 302, 307, 308])("rejects authenticated %i redirects without a second request", async (status) => {
  const fetchImplementation = vi.fn(async () => new Response(null, {
    status,
    headers: { location: "https://evil.example/collect" },
  }));
  await expect(fetchWithRetry(AUTHENTICATED_URL, { headers: AUTH_HEADERS, fetchImplementation })).rejects.toThrow(/redirect/i);
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `npx vitest run tests/delivery/wechat.test.ts`

Expected: redirect test fails because the transport follows the Response/does not set `redirect: "manual"`.

- [ ] **Step 3: Add the minimal transport policy**

```ts
const response = await fetch(url, { ...init, redirect: init.redirect ?? "manual", signal });
if (response.status >= 300 && response.status < 400) {
  await response.body?.cancel();
  throw new Error("WeChat transport redirect rejected");
}
```

Ensure QR acquire/poll call sites also pass their explicit `redirect: "manual"` policy and preserve no-follow behavior.

- [ ] **Step 4: Verify green**

Run: `npx vitest run tests/delivery/wechat.test.ts tests/security/wechat-boundary.test.ts`

Expected: all focused tests pass; each 301/302/307/308 case records one request only.

### Task 2: Persist intentional notification suppression

**Files:**
- Modify: `src/delivery/run-report-delivery.ts`
- Modify: `src/app/observer.ts`
- Modify: `src/app/health.ts`
- Test: `tests/app/observer.test.ts`
- Test: `tests/app/health.test.ts`

- [ ] **Step 1: Add failing two-process policy tests**

```ts
it.each([
  ["always", "success", 1],
  ["on-failure", "success", 0],
  ["never", "failed", 0],
] as const)("preserves %s notification policy across a second Observer start", async (notify, status, sends) => {
  await runObserverJob(fixture({ notify, status }));
  await runObserverJob(fixture({ notify, status }));
  expect(deliver).toHaveBeenCalledTimes(sends);
  expect(inspectRunDeliveryState(root).pending).toBe(0);
});
```

- [ ] **Step 2: Run the test and confirm red**

Run: `npx vitest run tests/app/observer.test.ts tests/app/health.test.ts`

Expected: `on-failure` and `never` are queued on the second start or appear as pending.

- [ ] **Step 3: Implement terminal notification dispositions**

```ts
export type RunDeliveryDisposition = "missing" | "retryable" | "sent" | "not-required" | "notification-disabled" | "indeterminate";

export function recordRunNotificationDisposition(options: { projectRoot: string; report: RunReport; disposition: "not-required" | "notification-disabled" }): void {
  writeLedger(options.projectRoot, terminalLedger(options));
}
```

Call this before returning from `!shouldNotify`. In historical queuing, find the job for each report and call `shouldNotify(job, report)` before enqueueing. Exclude the two terminal states from health pending counts.

- [ ] **Step 4: Verify green**

Run: `npx vitest run tests/app/observer.test.ts tests/app/observer-outbox.test.ts tests/app/health.test.ts`

Expected: the two-start matrix passes and intentional suppression is absent from pending health.

### Task 3: Finalize canonical reports before delivery

**Files:**
- Modify: `src/app/observer.ts`
- Modify: `src/delivery/outbox.ts`
- Test: `tests/app/observer.test.ts`
- Test: `tests/delivery/outbox.test.ts`

- [ ] **Step 1: Add the failing numbered-editorial recovery test**

```ts
it("retries a rejected editorial image with the numbered canonical report after restart", async () => {
  await expect(runObserverJob(editorialFixture({ image: "rejected" }))).rejects.toThrow();
  const persisted = listFinalRunReports(root)[0];
  const outbox = readOutbox(root, persisted.runId);
  expect(outbox.report).toMatchObject({ issueNumber: 7, issueLabel: "WP-000007" });
  await runObserverJob(editorialFixture({ image: "sent" }));
  expect(runDeliveryLedger(root, persisted.runId).reportSha256).toBe(outbox.envelope.payloadSha256);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run tests/app/observer.test.ts tests/delivery/outbox.test.ts`

Expected: initial Outbox report lacks the issue fields or has a different payload hash.

- [ ] **Step 3: Make report preparation canonical**

```ts
const prepared = await prepareFinalReportArtifacts(options, dependencies, report, "missing");
const canonical = RunReportSchema.parse(prepared.report);
// all send, ledger, and catch/enqueue paths use canonical
```

Prepare once before sender construction and return `{ report, artifact, imageEnabled }` to both the delivery and catch paths. Do not reassign an issue when retrying a canonical report. In `enqueueRunReportOutbox`, compare `stableHash(report)` to the stored payload; replace only an unattempted missing item for the same run, otherwise preserve the existing item for manual review.

- [ ] **Step 4: Verify green**

Run: `npx vitest run tests/app/observer.test.ts tests/delivery/outbox.test.ts tests/delivery/run-report-delivery.test.ts`

Expected: every persisted representation has the identical numbered hash and the restart retry reaches image send.

### Task 4: Make the runtime manifest authoritative

**Files:**
- Modify: `src/config/runtime.ts`
- Modify: `src/config/load.ts`
- Modify: `src/observer/config.ts`
- Modify: `src/cli/wechatpilot.ts`
- Test: `tests/config/config.test.ts`
- Test: `tests/cli/wechatpilot.test.ts`
- Test: `tests/launchd/plist.test.ts`

- [ ] **Step 1: Write failing manifest/minimal-PATH tests**

```ts
it("loads a validated runtime manifest when PATH has no codex", () => {
  writeRuntimeManifest(root, fakeRuntime);
  expect(loadConfig(root, { environment: { PATH: "/usr/bin:/bin" } })).toMatchObject({ digest: { codex: { nodeExecutable: fakeRuntime.nodeExecutable } } });
});

it("puts the runtime manifest path in LaunchAgent arguments", () => {
  expect(plist).toContain("--runtime-manifest");
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run tests/config/config.test.ts tests/cli/wechatpilot.test.ts tests/launchd/plist.test.ts`

Expected: loadConfig invokes PATH discovery and the plist has no manifest argument.

- [ ] **Step 3: Implement manifest read/validation and dependency injection**

```ts
export function loadRuntimeManifest(projectRoot: string): ResolvedRuntime {
  const path = resolveProjectPath(projectRoot, ".state", "runtime.json");
  assertPrivateRegularFile(path, 0o600);
  return ResolvedRuntimeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
```

Use discovery only in `init`/explicit doctor repair. Make `loadConfig` accept a runtime or runtime loader dependency; replace observer placeholders from that supplied manifest. Add `--runtime-manifest <absolute path>` to the LaunchAgent program arguments and use its recorded Node path. Doctor verifies executable and version rather than silently rediscovering.

- [ ] **Step 4: Verify green**

Run: `npx vitest run tests/config/config.test.ts tests/cli/wechatpilot.test.ts tests/launchd/plist.test.ts`

Expected: minimal-PATH fixture passes with its manifest; missing/unsafe manifests fail closed.

### Task 5: Enforce the fixed v0.1 contract

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/cli/wechatpilot.ts`
- Modify: `README.md`
- Test: `tests/config/config.test.ts`
- Test: `tests/cli/wechatpilot.test.ts`

- [ ] **Step 1: Write failing rejection tests**

```ts
it.each([
  ["timezone: Asia/Tokyo", /Asia\/Shanghai/],
  ["language: en", /zh-CN/],
  ["community: 4", /community/],
  ["min: 1800", /2000/],
])("rejects unsupported v0.1 digest configuration: %s", (replacement, message) => {
  expect(() => loadConfig(mutatedFixture(replacement))).toThrow(message);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run tests/config/config.test.ts tests/cli/wechatpilot.test.ts`

Expected: non-Shanghai, English, and altered values validate today.

- [ ] **Step 3: Replace ranges with literals and reject CLI drift**

```ts
timezone: z.literal("Asia/Shanghai"),
language: z.literal("zh-CN"),
quotas: z.object({ community: z.literal(3), news: z.literal(5), github: z.literal(3), deepReading: z.literal(2) }),
length: z.object({ unit: z.literal("chinese-characters"), min: z.literal(2000), max: z.literal(3000) }),
```

Reject `schedule install --timezone` unless its value is `Asia/Shanghai`; document host-timezone launchd behavior and fixed template limits.

- [ ] **Step 4: Verify green**

Run: `npx vitest run tests/config/config.test.ts tests/cli/wechatpilot.test.ts && npm run wechatpilot -- config validate`

Expected: default configuration passes; every unsupported value fails clearly.

### Task 6: Reproduce CI dependencies and release gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `scripts/fresh-clone-smoke.mjs`
- Create: `scripts/check-tracked-paths.mjs`
- Delete: `README 2.md`
- Test: `tests/project/branding.test.ts`

- [ ] **Step 1: Add failing workflow/script tests**

```ts
it("does not retain the obsolete duplicate README", () => {
  expect(existsSync(join(projectRoot, "README 2.md"))).toBe(false);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run tests/project/branding.test.ts && test ! -e 'README 2.md'`

Expected: the duplicate README exists.

- [ ] **Step 3: Make CI explicit**

Use `npm run test:coverage`, `npm run check:fresh-clone`, and a tracked-file scanner driven by `git ls-files -z`, not an allowlist. Have fresh-clone obtain the committed tree via `git archive HEAD` before `npm ci` and build. Replace floating CodeQL tags with verified full SHAs. Keep config tests on injected fake runtime and add a separate real-Codex compatibility job that skips cleanly when unavailable.

- [ ] **Step 4: Verify green**

Run: `npm run check:governance && npm run format:check && npm run check:fresh-clone && npx vitest run tests/project/branding.test.ts`

Expected: clean archive build works, full tracked-file scan is clean, and no obsolete README remains.

### Task 7: Final release verification

**Files:**
- Modify: release-relevant files from Tasks 1-6 only

- [ ] **Step 1: Run focused regression groups**

Run: `npx vitest run tests/delivery/wechat.test.ts tests/app/observer.test.ts tests/delivery/outbox.test.ts tests/config/config.test.ts tests/cli/wechatpilot.test.ts tests/launchd/plist.test.ts`

Expected: zero failures.

- [ ] **Step 2: Run full repository gates**

Run: `npm run audit:runtime && npm run check:transport-boundary && npm run format:check && npm run test:coverage && npm run typecheck && npm run build && npm run check:fresh-clone && npm run wechatpilot -- config validate`

Expected: all commands exit zero; coverage thresholds execute.

- [ ] **Step 3: Inspect change scope**

Run: `git status --short && git diff --check && git diff --stat main...HEAD`

Expected: only the scoped P0 implementation, tests, docs, and CI files changed.
