# Pinned `cli-in-wechat` upstream

`vendor/cli-in-wechat` is a Git submodule of
<https://github.com/sgaofen/cli-in-wechat>, pinned to the reviewed commit:

```text
75d7db9338e133080fef9914b92ceb5e3ebd0dfc
```

The submodule is intentionally detached. `.gitmodules` has no `branch` setting,
and this project must not automatically follow `main` or any other upstream
branch.

## Allowed use

Treat this upstream only as a pinned QR-login, context-token, and proactive-send
adapter for one-way digest delivery. Never expose a shell, arbitrary commands,
or remote-control behavior through WeChat.

Do **not** run `npm start`, `npm run dev`, or `npm run dev:debug`. Do not execute
the upstream entry point, instantiate its `Router`, or invoke its Codex adapter
or any other CLI adapter. Production integration must call only the narrowly
reviewed delivery behavior from project-owned wrappers.

## Toolchain and verification

The upstream declares Node `>=20.0.0`. This exact pin was installed and verified
with Node `22.23.1` and npm `10.9.8`, so it is compatible with this project's
Node 22 runtime.

Run the upstream checks from `vendor/cli-in-wechat` with the controlled Node 22
path:

```sh
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin node --version
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm ci
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm run typecheck
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm run build
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm test
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm audit --json
```

`npm ci` is the only install command used for verification. Do not edit the
upstream source or lockfile, and do not run `npm audit fix`.

## Sensitive local state

The forbidden upstream main program would store credentials and delivery context
under `~/.wx-ai-bridge/`. This project does **not** run that program, import its
config/client modules, or read that personal directory. Its narrow wrapper keeps
the QR credentials, single-owner allowlist, poll cursor, and context token under
the project-local ignored `.state/wechat/` directory with `0700`/`0600`
permissions. Never print, log, commit, copy into fixtures or prompts, or include
any of that state in generated digests or error output.

The allowed runtime closure is limited to built `ilink/auth.js`, `utils/http.js`,
`utils/logger.js`, and `utils/crypto.js`. Because `dist/` is ignored, every load
first verifies all four files against the committed size/SHA-256 manifest at
`config/vendor-wechat-artifacts.json`; modified or stale output is rejected
before dynamic import.

## Audit findings for this pin

On 2026-07-18, `npm audit --json` reported **2 vulnerable packages**: 1 low,
0 moderate, 1 high, and 0 critical. The audit contains five advisory records:

- Transitive `esbuild` (`>=0.27.3 <0.28.1`): low severity,
  [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
- Direct optional `undici` (`<6.27.0`): moderate severity,
  [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv).
- Direct optional `undici` (`<6.27.0`): high severity,
  [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q).
- Direct optional `undici` (`<6.27.0`): low severity,
  [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52).
- Direct optional `undici` (`<6.27.0`): low severity,
  [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m).

npm reported fixes as available, but none were applied so the reviewed source
and lockfile remain exact. Reassess these findings before deploying the adapter.

At this commit, `esbuild` is used only by the development toolchain. The
vulnerable optional `undici` package is dynamically loaded only by the
upstream proxy initializer; the upstream `send` path uses `fetchWithRetry` and
short-circuits before that initializer. The local delivery wrapper must not
import or call `initProxyFromEnv()`. If proxy support or any broader upstream
entry point is enabled later, re-pin to a reviewed fix and repeat the audit
before deployment.

## Explicit update procedure

Updates are manual and commit-specific. Review an upstream commit first, then
replace `<FULL_REVIEWED_COMMIT>` below with its full 40-character SHA:

```sh
git -C vendor/cli-in-wechat fetch origin
git -C vendor/cli-in-wechat checkout --detach <FULL_REVIEWED_COMMIT>
git add .gitmodules vendor/cli-in-wechat
PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm test -- tests/vendor/upstream-pin.test.ts
```

Then rerun all install, typecheck, build, test, and audit commands above and
review the resulting gitlink before committing. Never use
`git submodule update --remote`, never pass a branch to `git submodule add`, and
never add a `branch` key to `.gitmodules` or local submodule configuration.
