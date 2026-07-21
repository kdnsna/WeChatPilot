# Security Policy

## Supported version

Security fixes are applied to the latest commit on `main`. Older commits and
locally modified deployments are not supported separately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/kdnsna/WeChatPilot/security/advisories/new>

Do not open a public Issue for an unpatched vulnerability. Do not include real
tokens, cookies, WeChat user IDs, context tokens, QR codes, private logs, local
paths, or other personal data. Use minimal redacted reproduction material and
describe:

- the affected commit and component;
- the security boundary that can be crossed;
- minimal reproduction steps using synthetic data;
- the expected impact and any known mitigation.

The most important security boundaries are one-way WeChat delivery, single-owner
binding, local-only private state, credential redaction, project-root path
confinement, and the read-only non-interactive Codex child invocation. Reports
that require enabling the upstream remote-control entry point or bypassing the
documented safety model should clearly state that precondition.

Please allow time for triage and a coordinated fix before public disclosure.
