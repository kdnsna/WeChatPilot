# Privacy and data flow

## Local-first means control, not offline inference

Scheduling, credentials, ledgers, locks, and audit state remain local. Model inference is performed by the user-authenticated Codex CLI / model service.

## What can leave the machine

### Digest generation

Submitted to the ephemeral read-only Codex child over stdin only:

- ranked public candidate titles;
- public summaries already present in source data;
- public source URLs needed for link verification.

Not submitted:

- WeChat bot tokens;
- context tokens;
- WeChat user IDs;
- local filesystem paths outside the project root;
- credentials, cookies, or authorization headers;
- private delivery ledgers.

Native web search may be used by the child only to verify candidate facts and accessible source links.

### Report image generation

When visual mode is `editorial`, Codex image generation receives a sanitized visual brief derived from the run report. It does not receive WeChat credentials or private state files.

### WeChat delivery

Only the already-generated digest/report payload is sent to WeChat APIs with the local bot credential. Delivery responses update private ledgers.

## Retention

Private state remains in `.state/` or an explicit profile state root, is gitignored, and should use restrictive file modes.
