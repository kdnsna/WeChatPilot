# Codex Image 2 editorial report design

Date: 2026-07-20
Status: approved design, pending implementation plan
Project: WeChatPilot

## 1. Goal

Replace the current sparse 1080 × 1440 run card with a detailed, single-image WeChat report that is useful without reading preceding messages. Every new observer report must attempt a fresh visual through Codex's built-in GPT Image 2 capability. A deterministic local compositor then adds exact Chinese text, issue numbering, metrics, and audit data.

The design must preserve the existing product boundary: WeChat is a one-way, owner-bound delivery destination. A WeChat message cannot start a job, alter a prompt, select a command, choose a recipient, or control Codex.

## 2. Approved product decisions

- Delivery format: one portrait report image per new report.
- Final image size: 1080 × 2400 PNG, at most 5 MiB.
- Visual language: “编辑部情报刊” — warm paper background, navy body text, warm orange emphasis, dense but calm editorial hierarchy.
- Information balance: about 70% task result or technical intelligence and 30% Codex execution and delivery audit.
- Visual generation: Codex built-in GPT Image 2, not a direct Image API integration and not a user-supplied API key.
- Composition: GPT Image generates only the text-free hero visual. Local code renders all readable text and numbers.
- Numbering: all new success, skipped, failed, timed-out, cancelled, interrupted, and recovered reports share one continuous `WP-000001` issue sequence. Content items use `01`, `02`, and so on.
- Retry identity: the same report and run ID always reuse the same issue number, generated hero, final PNG, and report content.
- Generation retry: one initial Codex image attempt plus at most two retries, for three attempts total.
- Generation fallback: after three failed attempts, use the deterministic branded hero and display `AI 主视觉暂不可用`; the detailed report still sends.

## 3. Approaches considered

### 3.1 Selected: LaunchAgent-controlled Codex image child

The existing LaunchAgent remains the scheduler and recovery owner. After the managed digest job produces a final report, the observer invokes one ephemeral, non-interactive Codex child to generate the hero visual, composites the final report, and sends it through the existing audited WeChat adapter.

This retains the deployed task lock, run journal, delivery ledger, recovery logic, and owner-bound sender.

### 3.2 Rejected: Codex automation owns the whole schedule

This places image generation in a native Codex scheduled task but duplicates or replaces the verified LaunchAgent scheduler, lock, outbox, and recovery system. The migration surface is unnecessary for one daily job.

### 3.3 Rejected: two-stage persistent image queue

A LaunchAgent could produce report jobs for a separate long-running Codex image worker. This isolates latency but adds a second scheduler, queue reconciliation, and more failure states. Current volume does not justify it.

## 4. Report content model

New runs use a versioned editorial report payload while existing version 1 final records remain readable for recovery and delivery disposition checks.

For a successful digest, the payload contains:

- `executiveSummary`: 80–140 Chinese characters that state the main conclusion and what completed.
- `highlights`: three to five verified items. Five is the target when enough high-confidence candidates exist. Each item contains a short title, a 40–100 character “why it matters” explanation, references to approved source URLs, and an impact label.
- `actions`: exactly three concrete follow-ups, tracking targets, experiments, or safe Codex automation ideas.
- `audit`: candidate count, selected count, source-category count, start and finish timestamps, duration, visual mode, and delivery state.

The model must never fabricate extra highlights to fill the layout. If fewer than three verified signals exist, the report states the actual count and uses an explicit low-signal editorial block.

The digest-generating Codex child continues to receive only the ranked candidate bundle through stdin. Its strict output schema is extended with the editorial fields. Highlight source URLs must be members of the approved candidate set; local validation converts URLs to counts and removes URLs before rendering or image prompting.

For skipped, failed, timed-out, cancelled, interrupted, and recovered runs, local deterministic code builds a status-specific editorial payload. It contains:

- what was checked;
- the safe reason no normal digest was produced;
- retry or recovery outcome;
- the most recent known successful report reference when available;
- the next scheduled time or safe operator action;
- the same execution and delivery audit fields.

Status reports do not invent technical intelligence.

## 5. Fixed long-image layout

The 1080 × 2400 canvas has five zones:

1. **Hero and identity** — a generated text-free visual, `WECHATPILOT · DAILY SIGNAL`, issue number, report title, status, date, and finish time.
2. **Executive brief** — the main conclusion in a high-contrast editorial callout.
3. **Top signals** — numbered items with title, why-it-matters text, source count, confidence derived from verified references, and impact.
4. **Next actions** — three numbered actions in a navy panel.
5. **Codex audit** — collection count, selection count, source coverage, duration, visual mode, delivery outcome, four-step timeline, short run ID, style version, and `PAGE 01 / 01`.

The renderer adapts vertical spacing for three, four, or five highlights without changing the canvas size. It must not shrink body text below the approved readable minimum merely to force content to fit. Overflow is truncated only at schema-defined safe limits and is explicitly marked.

## 6. Issue numbering and idempotency

The private sequence ledger is stored under `.state/observer/` and updated atomically while holding a dedicated sequence lock. It contains the last issued number and a run-ID-to-issue assignment map.

Issue assignment occurs only after a final run report exists and before visual generation. One atomic update assigns the next number and records the run ID. Recovery checks the map first, so a crash cannot give the same run a second issue. Delivery retries never allocate an issue.

The visible format is `WP-` plus six zero-padded digits. The internal run ID remains the delivery and recovery identity; the issue number is the human archive identity.

## 7. Codex built-in Image 2 boundary

The image generator spawns the installed `codex exec` binary with a string argument array and `shell: false`. The invocation must be:

- ephemeral;
- non-interactive;
- rooted at this project;
- read-only;
- supplied through stdin only;
- configured to enable image generation and disable shell execution, unified execution, browser use, computer use, Apps, plugins, and hooks;
- bounded by a fixed timeout;
- unauthorised to add directories or bypass approvals and sandboxing.

The child receives a sanitized visual brief containing only:

- style version;
- generic report status;
- a small set of sanitized topic labels;
- palette and composition instructions;
- an instruction to create a text-free editorial hero.

It never receives WeChat messages, recipient data, credentials, local paths, source URLs, the full digest, arbitrary user text, or executable instructions.

The parent parses Codex JSON events in memory. Only the built-in image-generation tool and a final structured response are allowed. If an event indicates a shell, browser, App, plugin, hook, computer-use, or any other non-image tool, the artifact is rejected and the attempt fails. Raw events, prompts, authentication data, and generated-image source paths are not logged.

The structured response may return only the generated artifact path and a fixed success marker. The parent accepts one regular image file from the Codex-owned generated-images directory, using exact path containment and file-identity checks. It copies that one file into the report artifact directory; it never scans a personal directory.

The implementation must not set, clear, or repurpose `HOME` or `CODEX_HOME`.

## 8. Visual generation, validation, and composition

Each new report has a private visual ledger with:

- issue number;
- state: `pending`, `generating`, `generated`, or `fallback`;
- attempt count;
- style version;
- sanitized prompt hash;
- project-relative copied hero path and hash when generated;
- stable failure code when fallback is used.

No raw prompt, error body, external generated-image path, or credential is persisted.

Generated images are accepted only when they are regular files of an allowed image type, within size limits, decodable, and large enough for the hero crop. Local code crops and scales the hero, applies a contrast treatment, and composites the deterministic text layer. The final PNG must validate as exactly 1080 × 2400 and at most 5 MiB.

The completed hero, editorial payload, final PNG, and their hashes are immutable for a run. A retryable WeChat rejection reuses them. An indeterminate send is never replayed automatically.

## 9. Failure handling

### 9.1 Codex or Image 2 unavailable

Attempt generation at most three times with finite delays. Timeouts, missing artifacts, unexpected tool events, unsafe paths, malformed files, and model failures use stable internal codes. After the third failure, create the deterministic branded hero and continue.

### 9.2 Composition failure

Do not send a partial, wrong-size, or oversized image. Record a safe render failure. Preserve the finalized run and visual ledger for recovery. The observer may send the existing safe text status, but the image remains pending until a later verified recovery or an explicit terminal fallback artifact is available.

### 9.3 Delivery failure

The existing ledger rules remain authoritative:

- retry only explicit rejection and stay within the attempt cap;
- reuse the same image and issue number;
- mark lost or ambiguous responses indeterminate;
- never retry an indeterminate image automatically.

## 10. Health and observability

Health adds counts and readiness checks without exposing IDs, prompts, paths, or errors:

- Codex executable available;
- image-generation capability probe passed;
- report sequence ledger valid;
- editorial schema and compositor ready;
- pending visual generations;
- fallback visuals awaiting send;
- invalid visual ledgers;
- existing pending, indeterminate, and recovery delivery counts.

Logs use stable codes and counts only. The final image footer may expose only the short run ID, issue number, style version, timestamps, and public audit values.

## 11. Test strategy

### 11.1 Feasibility gate

Before production implementation, run one minimal `codex exec` experiment from the same effective LaunchAgent environment. With non-image tools disabled, it must invoke built-in Image 2, return an auditable structured result, and produce one valid image. If this fails, stop and report the blocker. Do not silently switch to a direct API key.

### 11.2 Automated tests

Tests must cover:

- strict successful editorial payloads and honest low-signal layouts;
- status-specific content without fabricated intelligence;
- approved-source membership and URL removal before render or image prompt;
- continuous, atomic issue assignment and recovery reuse;
- one visual per run across crashes and delivery retries;
- rejection of unsafe paths, symlinks, oversized or malformed images;
- rejection of any unexpected Codex tool event;
- one initial generation plus at most two retries;
- deterministic fallback after exhausted image attempts;
- 1080 × 2400 output, 5 MiB cap, Chinese wrapping, safe truncation, and hostile text escaping;
- success, skipped, failed, and interrupted visual variants;
- existing owner-bound send-only and indeterminate-delivery protections.

### 11.3 Visual and live acceptance

Generate a fixed test report with five sample signals, three actions, audit data, and a real Codex Image 2 hero. Inspect the PNG locally, then send it to the bound owner through the audited WeChat path.

Acceptance requires:

- readable mobile typography;
- no garbled Chinese, overlap, clipping, or large unintended blank regions;
- a visible issue number and item numbering;
- an editorial hero that does not contain generated text;
- correct 70/30 information balance;
- confirmed WeChat text and image delivery with no duplicate;
- healthy observer and empty pending queues after completion.

Only after this live test is approved may the production build and LaunchAgent be reloaded.

## 12. Rollout and rollback

Rollout is staged:

1. Codex built-in Image 2 feasibility gate.
2. Editorial schema, numbering, and deterministic compositor behind tests.
3. Fixed local test render and visual review.
4. Real Image 2 test render and local review.
5. One owner-bound WeChat test send.
6. Full suite, build, health, plist validation, and clean-worktree check.
7. LaunchAgent reload and one observed run.

Rollback restores the previous deterministic report-card renderer and installed LaunchAgent build. Existing final reports, delivery ledgers, and issue assignments remain intact. Rollback never replays an indeterminate delivery.

## 13. External capability references

- [Codex use cases](https://developers.openai.com/codex/use-cases) list image-generation workflows.
- [GPT Image 2 model](https://developers.openai.com/api/docs/models/gpt-image-2) documents the current model capability.
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation) documents image latency and the continuing limits of exact text rendering, which is why this design generates only a visual layer and renders text locally.
