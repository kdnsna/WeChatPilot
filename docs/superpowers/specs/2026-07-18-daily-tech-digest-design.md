# Local Daily Tech Digest Design

**Date:** 2026-07-18

**Status:** Approved for implementation by the user's detailed project brief and explicit instruction to continue until the WeChat scan/login gate.

## 1. Goal and boundaries

Build a local Node.js 22 and TypeScript application that runs at 08:00 Asia/Shanghai, collects verifiable technology signals from the previous 24 hours, ranks them with transparent metrics, asks the installed Codex CLI to write a Chinese digest, sends the digest through a pinned `cli-in-wechat` delivery adapter, and retains non-secret evidence for troubleshooting.

The application is deliberately one-way. It does not expose a shell, Codex session, remote-control endpoint, or arbitrary command execution to WeChat. It never starts Codex remote control and never invokes `--dangerously-bypass-approvals-and-sandbox`.

## 2. Considered approaches

### A. Separate orchestrator plus pinned upstream delivery adapter — selected

The main project owns collection, normalization, ranking, generation, idempotency, and scheduling. `vendor/cli-in-wechat` is pinned to commit `75d7db9338e133080fef9914b92ceb5e3ebd0dfc` and is used only for QR login, context binding, and proactive send. This keeps the security boundary small and makes upstream drift explicit.

### B. Fork and modify `cli-in-wechat` as the whole application — rejected

This would mix upstream remote-control assumptions with the digest pipeline, complicate upgrades, and violate the requested project separation.

### C. Reimplement the WeChat protocol — rejected

This would duplicate the most fragile and security-sensitive part of the system. The pinned upstream already supplies the required login and send behavior.

## 3. Architecture

```text
configured sources
  -> isolated collectors
  -> raw evidence files
  -> normalized items
  -> within-source percentiles
  -> duplicate/event clusters
  -> seven-day history penalty
  -> ranked candidate bundle
  -> constrained Codex exec
  -> validated Markdown digest
  -> delivery-only WeChat adapter
  -> sent ledger and logs
```

Each collector returns a result envelope instead of throwing through the whole run. A failed source is recorded with a sanitized error and the remaining collectors continue. The orchestrator only fails when every usable source fails, candidate minimums cannot be met, Codex output validation fails, or delivery fails after the bounded retry policy.

## 4. Data model and persistence

Every normalized item contains:

```ts
interface NormalizedItem {
  source: string;
  category: 'community' | 'news' | 'github' | 'deep-reading';
  title: string;
  url: string;
  author: string | null;
  publishedAt: string;
  comments: number | null;
  score: number | null;
  stars: number | null;
  summary: string | null;
  rawMetrics: Record<string, string | number | boolean | null>;
  collectedAt: string;
}
```

Run evidence is stored under `data/raw/<date>/`. GitHub star snapshots and seven-day delivery history live under `data/history/`. Generated prompt bundles stay with the raw run evidence, while final digests and their hash-bound selection manifests live under `output/`. Structured JSONL logs live under `logs/`. Runtime lock and delivery state files are local and ignored by Git.

Sensitive upstream state, `.env` files, tokens, cookies, QR/session data, context tokens, generated data, logs, and final reports are ignored. Logging passes through a recursive redactor that removes values associated with token, cookie, authorization, credential, secret, and session-like keys.

## 5. Collectors

- Hacker News reads `topstories` and `newstories`, deduplicates IDs, then reads bounded item details. It retains title, URL, score, descendants/comments, author, and Unix publication time.
- V2EX reads the public hot-topic endpoint and retains reply count, node, member, URL, and available timestamps.
- GitHub uses unauthenticated repository search when no token exists and authenticated requests only when an optional token is supplied by the environment. It records current stars, repository age, stars per day, language, pushed/updated time, and the locally observed 24-hour star delta when a prior snapshot exists. A first run reports the delta as unavailable rather than inventing it.
- RSS feeds are declared in `config/sources.yaml`. Each feed is isolated so one broken feed does not invalidate the RSS collector.
- Reddit tries configured public endpoints with a descriptive user agent. HTTP 403, 429, timeout, or malformed payload yields a degraded source result, not a pipeline failure.

All HTTP requests use bounded timeouts, bounded concurrency, a project-specific user agent, and no ambient cookies.

## 6. Ranking, clustering, and history

Raw counts from different platforms are never added together. Metrics are converted to percentile ranks within the same source before combination.

For item `i`, the pre-history score is:

```text
base(i) =
  0.24 * engagement_percentile(i)
  + 0.20 * popularity_percentile(i)
  + 0.18 * velocity_percentile(i)
  + 0.18 * 2^(-age_hours(i) / recency_half_life_hours)
  + 0.12 * cross_source_confirmation(i)
  + 0.08 * source_quality(i)

score(i) = 100 * base(i) * history_factor(i)
```

Engagement uses comments or replies. Popularity uses the platform's score or stars. Velocity uses comments per age hour for discussion sources, and prefers an observed star delta for GitHub before falling back to a clearly labeled lifetime pace. Missing metrics receive a neutral within-source percentile. Source quality, including the configured source-family weight, is already the sixth weighted component and is not multiplied a second time. Cross-source confirmation is based on the number of distinct sources in the duplicate/event cluster, capped by configuration. `history_factor` is configurable and defaults to `0.35` for an item sent in the preceding seven days; otherwise it is `1.0`.

Clustering first compares canonical URLs with tracking parameters removed, then normalized titles using token and character-bigram similarity. One representative is retained while alternate sources and their links remain available to Codex as corroboration. All formula weights, source weights, time windows, thresholds, and quotas are configurable.

## 7. Codex generation boundary

The detected CLI is `/opt/homebrew/bin/codex` version `0.144.4`. Live help shows that `--search` is a global option while `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, and `--output-schema` are `exec` options. The application therefore uses the compatible shape:

```text
/opt/homebrew/bin/codex --search --ask-for-approval never exec \
  --ephemeral --ignore-user-config --ignore-rules \
  --sandbox read-only --cd <project-root> \
  --output-schema <project-schema> -
```

The prompt and ranked data are passed on standard input. The system prompt explicitly forbids shell commands and reading files outside the supplied input, requires accessible links, separates facts from judgment, and requires disclosure when data is insufficient. `AGENTS.md` repeats the local security boundary. The returned structured object is validated before its Markdown is written. Validation checks the title/date, required sections, source URLs, and a 2,000–3,000 Chinese-character target with a narrow retry path for correctable formatting failures.

## 8. WeChat delivery boundary

The adapter uses the pinned upstream QR login, audited HTTP retry helper, UIN helper, and proactive-send endpoint while keeping all context persistence and one-owner validation in project-owned code. Initialization verifies the presence and permissions of required state; it never prints the token. Sending refuses to run when the bound user allowlist is empty or when the user cannot be matched to the scan-bound identity. Long text follows a tested compatibility copy of the upstream paragraph/line/space/hard-cut segmentation because the upstream helper is not exported.

Login expiry is classified and reported once with the re-scan command. Automatic login retry is bounded and never loops forever. Digest sends are guarded by a per-day ledger; there is no force option, so a successful send is never repeated for the same local date.

## 9. Scheduling and recovery

The generated LaunchAgent runs as the current user with `StartCalendarInterval` at 08:00 and `RunAtLoad` for boot/login catch-up. The scheduled entry script checks Asia/Shanghai time, so a pre-08:00 login exits cleanly while a post-08:00 login can catch up once. An atomic whole-job lock prevents overlap, and the per-day delivery ledger prevents a second successful send. The wrapper allows one initial attempt plus at most two retries, then exits non-zero.

The plist contains only detected absolute executable and project paths. Standard output and error use absolute paths under `logs/`. It is syntax-checked but not loaded until the user explicitly approves loading it after manual delivery acceptance.

## 10. Verification

Acceptance requires Node 22 build success, unit and integration tests for all collectors and degradation paths, deterministic ranking and seven-day deduplication tests, Codex prompt and output validation tests, a no-send Codex run, one WeChat test message, one complete digest send, plist syntax validation, a repository secret scan, sanitized-log inspection, and Git status inspection.

## 11. Decisions fixed by this design

- Runtime: Homebrew Node 22 via `/opt/homebrew/opt/node@22/bin` without changing the user's global Node 26 link.
- GitHub authentication: optional environment variable only; unauthenticated mode remains functional.
- Reddit: best-effort and non-blocking.
- WeChat: one-way delivery only; no remote command surface.
- Scheduling: generate and validate now; do not load before explicit approval.
