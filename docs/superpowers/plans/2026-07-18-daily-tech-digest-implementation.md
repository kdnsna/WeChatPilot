# Daily Tech Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally validate a safe daily technology digest that generates through Codex and delivers through a pinned WeChat adapter.

**Architecture:** A TypeScript orchestrator runs independent collectors into one normalized schema, ranks and clusters with deterministic metrics, calls Codex through a read-only ephemeral process boundary, then calls a delivery-only upstream adapter. Local state provides evidence, locking, retry bounds, history penalties, and send idempotency.

**Tech Stack:** Node.js 22.23.1, TypeScript, native fetch, YAML, RSS parsing, Zod, Vitest, pinned `sgaofen/cli-in-wechat`, Codex CLI 0.144.4, macOS launchd.

---

### Task 1: Runtime scaffold and secret boundary

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `AGENTS.md`
- Create: `config/sources.yaml`, `config/ranking.yaml`, `config/digest.yaml`
- Create: `prompts/daily-digest.md`
- Test: `tests/config/config.test.ts`, `tests/security/redaction.test.ts`

- [ ] Write configuration and redaction tests that import wished-for `loadConfig` and `redactSecrets` APIs.
- [ ] Run `npm test -- tests/config/config.test.ts tests/security/redaction.test.ts` and confirm failure because the APIs do not exist.
- [ ] Implement minimal schema-validated configuration loading and recursive secret redaction.
- [ ] Re-run the focused tests, then the full test suite.

### Task 2: Common types, HTTP boundary, and result envelopes

**Files:**
- Create: `src/types/item.ts`, `src/types/collector.ts`
- Create: `src/lib/http.ts`, `src/lib/time.ts`, `src/lib/logger.ts`, `src/lib/paths.ts`
- Test: `tests/lib/http.test.ts`, `tests/lib/logger.test.ts`

- [ ] Write tests proving timeouts, non-2xx classification, no cookie forwarding, and secret-safe structured logs.
- [ ] Run the focused tests and confirm failures for missing modules.
- [ ] Implement the bounded fetch client, collector result envelope, time helpers, path guard, and JSONL logger.
- [ ] Re-run focused and full tests.

### Task 3: Hacker News and V2EX collectors

**Files:**
- Create: `src/collectors/hacker-news.ts`, `src/collectors/v2ex.ts`, `src/normalizers/hacker-news.ts`, `src/normalizers/v2ex.ts`
- Test: `tests/collectors/hacker-news.test.ts`, `tests/collectors/v2ex.test.ts`
- Fixtures: `tests/fixtures/hn/*.json`, `tests/fixtures/v2ex/*.json`

- [ ] Write fixture-driven tests for top/new ID deduplication, item normalization, V2EX reply/node metrics, malformed items, and bounded partial failure.
- [ ] Run focused tests and verify expected missing-implementation failures.
- [ ] Implement only the collector behaviors exercised by the tests.
- [ ] Re-run focused and full tests.

### Task 4: GitHub, RSS, and degradable Reddit collectors

**Files:**
- Create: `src/collectors/github.ts`, `src/collectors/rss.ts`, `src/collectors/reddit.ts`
- Create: `src/normalizers/github.ts`, `src/normalizers/rss.ts`, `src/normalizers/reddit.ts`
- Test: `tests/collectors/github.test.ts`, `tests/collectors/rss.test.ts`, `tests/collectors/reddit.test.ts`
- Fixtures: `tests/fixtures/github/*.json`, `tests/fixtures/rss/*.xml`, `tests/fixtures/reddit/*.json`

- [ ] Write tests for unauthenticated GitHub headers, optional token use without logging it, real star-growth snapshot math, first-run null growth, per-feed RSS isolation, and Reddit 403/429 degradation.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement the three collectors and snapshot update logic.
- [ ] Re-run focused and full tests.

### Task 5: Transparent ranking, clustering, and history penalty

**Files:**
- Create: `src/ranking/percentile.ts`, `src/ranking/metrics.ts`, `src/ranking/cluster.ts`, `src/ranking/rank.ts`
- Create: `src/history/delivery-history.ts`, `src/history/github-snapshots.ts`
- Test: `tests/ranking/percentile.test.ts`, `tests/ranking/cluster.test.ts`, `tests/ranking/rank.test.ts`, `tests/history/history.test.ts`

- [ ] Write tests proving source-local percentiles, tie handling, recency decay, velocity, cross-source confirmation, canonical URL/title clustering, and the seven-day `0.35` history factor.
- [ ] Run the focused tests and confirm missing-implementation failures.
- [ ] Implement the exact configurable formula from the design.
- [ ] Re-run focused and full tests and inspect deterministic ranking explanations.

### Task 6: Collection orchestration and raw evidence

**Files:**
- Create: `src/collectors/index.ts`, `src/pipeline/collect.ts`, `src/pipeline/run-context.ts`
- Test: `tests/pipeline/collect.test.ts`, `tests/pipeline/degradation.test.ts`

- [ ] Write tests showing one source failure does not fail the run, all-source failure does, and each source receives an isolated raw evidence file.
- [ ] Run focused tests and confirm failures.
- [ ] Implement bounded parallel orchestration and sanitized error summaries.
- [ ] Re-run focused and full tests.

### Task 7: Codex prompt bundle and output validation

**Files:**
- Create: `src/digest/prompt.ts`, `src/digest/schema.ts`, `src/digest/validate.ts`, `src/digest/codex.ts`
- Create: `config/digest-output.schema.json`
- Test: `tests/digest/prompt.test.ts`, `tests/digest/validate.test.ts`, `tests/digest/codex-command.test.ts`

- [ ] Write tests for the exact installed-CLI argument order, stdin-only input, forbidden dangerous flags, read-only/ephemeral/search settings, required sections, URL evidence, and length validation.
- [ ] Run focused tests and verify failures.
- [ ] Implement prompt assembly, safe child-process invocation, structured output schema, and validation.
- [ ] Re-run focused and full tests.

### Task 8: Pin and audit `cli-in-wechat`

**Files:**
- Create: `.gitmodules`
- Create: `vendor/cli-in-wechat` pinned Git link
- Create: `vendor/README.md`
- Test: `tests/vendor/upstream-pin.test.ts`

- [ ] Write a test that reads the Git link/metadata and requires commit `75d7db9338e133080fef9914b92ceb5e3ebd0dfc`.
- [ ] Run the test and confirm it fails before the vendor dependency exists.
- [ ] Add the upstream repository under `vendor/cli-in-wechat`, checkout the exact commit, install with Node 22, and build using its locked package manager.
- [ ] Re-run the pin test and record the upstream build command without copying secrets.

### Task 9: Delivery-only WeChat adapter

**Files:**
- Create: `src/delivery/wechat.ts`, `src/delivery/state.ts`, `src/delivery/errors.ts`
- Create: `scripts/init-wechat.ts`, `scripts/send-test.ts`, `scripts/send-digest.ts`
- Test: `tests/delivery/wechat.test.ts`, `tests/delivery/state.test.ts`

- [ ] Write tests that reject blank allowlists, redact context tokens, classify expired login once, delegate long-message segmentation to upstream, and block duplicate successful sends.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the smallest adapter around the audited upstream QR/context/send entry points; do not start its Codex or remote-control entry point.
- [ ] Re-run focused and full tests.

### Task 10: End-to-end runner, lock, and bounded retries

**Files:**
- Create: `src/cli.ts`, `src/pipeline/run.ts`, `src/runtime/lock.ts`, `src/runtime/retry.ts`
- Create: `scripts/run-manual.ts`, `scripts/run-scheduled.ts`, `scripts/health-check.ts`
- Test: `tests/pipeline/run.test.ts`, `tests/runtime/lock.test.ts`, `tests/runtime/retry.test.ts`

- [ ] Write tests for no-send mode, per-day idempotency, stale-lock recovery, concurrent-run refusal, and one initial attempt plus two retries.
- [ ] Run focused tests and confirm failures.
- [ ] Implement commands `collect`, `digest:dry-run`, `run:manual`, `run:scheduled`, `health`, `wechat:init`, `wechat:test`, and `wechat:send-digest`.
- [ ] Re-run focused and full tests.

### Task 11: LaunchAgent generation without loading

**Files:**
- Create: `launchd/io.wechatpilot.tech-digest.plist.template`
- Create: `scripts/render-launchd.ts`, `scripts/uninstall-launchd.ts`
- Test: `tests/launchd/render.test.ts`

- [ ] Write tests for 08:00 calendar fields, `RunAtLoad`, absolute paths, current-user operation, log paths, and absence of `sudo`, root, `KeepAlive`, or shell-dependent PATH lookup.
- [ ] Run focused tests and confirm failures.
- [ ] Implement deterministic rendering using detected `/path/to/node`, `codex`, `/bin/zsh`, and the absolute project path.
- [ ] Render the plist and validate it with `/usr/bin/plutil -lint`; do not call `launchctl load` or `bootstrap`.

### Task 12: Local dry run and manual acceptance gate

**Files:**
- Produce: `data/raw/<run-id>/*`, `output/<date>.md`, `logs/*.jsonl`
- Modify: `README.md`

- [ ] Run Node 22 install, typecheck, tests, and build from a clean dependency state.
- [ ] Run collectors against live endpoints and verify a Reddit failure remains non-fatal.
- [ ] Run prompt dry-run, then a real no-send Codex generation with the safe command.
- [ ] Scan every selected digest item for an accessible source URL and ranking explanation.
- [ ] Run log and repository secret scans.
- [ ] Pause only here for the user to scan the WeChat QR code and send “初始化”.

### Task 13: WeChat and release acceptance

**Files:**
- Produce: ignored local WeChat state, sent ledger, final acceptance report
- Modify: `README.md` with exact health, manual run, rescan, and uninstall commands

- [ ] Verify context state exists and is not printed or tracked; verify the bound-user allowlist is non-empty and singular.
- [ ] Send one test message and obtain a successful upstream result.
- [ ] Send one complete digest and confirm the daily ledger prevents a duplicate send.
- [ ] Re-run build, all tests, typecheck, health check, plist lint, Git status, ignored-file checks, and secret/log scans.
- [ ] Present the generated plist and ask for explicit confirmation before loading it.

## Plan self-review

- The plan covers every source, the transparent formula, seven-day history, Codex safety flags, delivery-only WeChat use, bounded retry/locking/idempotency, launchd catch-up, test delivery, and credential auditing.
- The production modules are introduced only after focused tests fail for their absence.
- Runtime paths match the environment detected on 2026-07-18 and are revalidated before plist generation.
- Git commits are intentionally not required by this plan because the empty repository has no configured author identity; delivery does not invent one.
