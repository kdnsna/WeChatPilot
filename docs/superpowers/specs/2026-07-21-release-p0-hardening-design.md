# Release P0 Hardening Design

**Goal:** Close the six release-blocking security, delivery-consistency, runtime, configuration, and CI gaps before public release.

## Scope and compatibility

Version 0.1 has a deliberately fixed product contract: simplified-Chinese output,
`Asia/Shanghai`, the existing four digest lanes, and their existing quotas and
length limits. User configuration must reject unsupported alternatives instead of
accepting values that the runtime ignores.

No WeChat control plane is introduced. The WeChat transport remains a one-way
delivery path only.

## 1. Redirect-safe WeChat transport

Every vendor fetch call receives an explicit redirect policy. Requests carrying
credentials, recipient identity, context tokens, messages, or upload parameters
use `redirect: "manual"` and reject any 3xx response before parsing it. QR and
other unauthenticated requests also choose their policy explicitly rather than
inheriting fetch defaults.

The transport validates initial origins as today and treats manual redirect
responses as terminal transport errors. Future allowed redirects must be an
explicit, separately audited allowlist; this release does not follow any
redirect. Tests cover 301, 302, 307, and 308 and assert that no second request is
made to another origin.

## 2. Notification disposition and historical recovery

Delivery state has explicit terminal dispositions in addition to successful
delivery: `not-required` for reports suppressed by the job policy and
`notification-disabled` for `never`. The current run records the matching
disposition when it decides not to notify.

Historical queuing evaluates the job policy before making an Outbox item and
does not enqueue terminally suppressed reports. Health counts only delivery
states that still need action. Integration tests run two Observer processes for
`always`, `on-failure`, and `never`.

## 3. Canonical editorial reports

All report preparation, including issue assignment and final-record replacement,
finishes before the first network send. The result is schema-validated immutable
canonical data. The final JSON record, text/image sends, delivery ledger,
Outbox payload, and payload hash all consume that same canonical report.

An existing Outbox item is compared by payload hash. It can be replaced only if
it has not started delivery and represents the same run's valid finalization;
otherwise the conflict is retained for manual review. A cross-process recovery
test covers numbered-editorial text success followed by an explicitly rejected
image and the next-process retry.

## 4. Runtime manifest as an execution input

`init` writes a private, schema-validated runtime manifest containing resolved
Node and Codex executables, expected versions, and paths. Normal configuration
uses that manifest rather than looking up `codex` on every startup. `doctor`
revalidates existence, mode, identity, and version; it is the controlled repair
path after an upgrade.

LaunchAgent receives the absolute runtime manifest path and uses the recorded
Node executable. Test fixtures exercise an environment whose PATH contains only
`/usr/bin:/bin`. Configuration schema validation is separated from runtime
discovery so CI needs no installed Codex.

## 5. Fixed v0.1 schedule and template configuration

The config schema only accepts `Asia/Shanghai`, `zh-CN`, the documented quotas,
and the fixed word-count contract. CLI schedule installation likewise rejects a
different timezone. README and generated examples describe these as v0.1 fixed
behavior. The fixed system timezone is also documented as a launchd prerequisite,
because launchd calendar triggers are based on the host timezone.

## 6. Reproducible release gates

CI uses injected fake runtime data for unit/configuration tests, runs coverage
instead of bare tests, invokes the clean-checkout smoke test, and pins CodeQL
actions by full SHA. The fresh-install smoke test checks out the committed tree
into a new directory rather than copying selected working-tree files.

Governance scans every tracked file. The obsolete `README 2.md` is removed.
A separate, opt-in compatibility smoke job is the only job allowed to depend on
an actual Codex binary. Issue #5 may close only after this branch is pushed and
the newest remote CI run succeeds.

## Verification

- Unit tests for all four redirect statuses and explicit unauthenticated policy.
- Two-process Observer integration coverage for notification disposition and
  canonical-report retry behavior.
- Runtime manifest and minimal-PATH LaunchAgent tests.
- Schema tests rejecting unsupported v0.1 configuration.
- CI workflow and fresh-checkout tests, then local typecheck, coverage, build,
  governance scan, and fresh-clone smoke.
