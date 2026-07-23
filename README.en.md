# WeChatPilot

[简体中文](README.md) | [English](README.en.md)

**Local-first, outbound-only, auditable AI automation for WeChat.**

Let local AI automation reach WeChat safely — without letting WeChat control your computer.

![WeChatPilot offline demo preview](docs/assets/demo-preview.png)

Current release: **Public Preview `v0.1.0-beta.1`**. This is not Stable and not Production Ready. Until the seven-day stability review (Issue #4) is complete, do not claim the pipeline is already stable.

> WeChatPilot is not affiliated with, authorized by, or endorsed by Tencent or WeChat.

## Product positioning

WeChatPilot is not a general remote-control WeChat bot. It is a local-first delivery tool for scheduled AI automation results:

- The work runs on your Mac.
- Delivery is outbound-only to the owner-bound WeChat account that scanned the QR code.
- WeChat cannot start jobs, choose recipients, open a shell, or remote-control Codex.
- Delivery state is auditable; indeterminate sends fail closed instead of auto-replaying.

The first built-in workflow is a daily tech digest.

## Offline demo

```sh
npm ci
npm run build
npm run wechatpilot -- demo
```

The demo:

- does not access WeChat
- does not call Codex
- does not read private `.state` credentials
- uses fixed fixtures
- writes a sample digest and preview image under `output/demo/`
- prints safe next steps

## Supported environment

- macOS
- Node.js 22
- Official Codex CLI available on `PATH` and logged in
- Simplified Chinese and `Asia/Shanghai` for v0.1
- Personal WeChat account for owner-bound outbound delivery

## Quick start

```sh
npm ci
npm run build
npm run wechatpilot -- init
npm run wechatpilot -- doctor
./scripts/init-wechat.sh
npm run send:test
```

Common commands:

```sh
npm run wechatpilot -- demo
npm run wechatpilot -- doctor --repair
npm run wechatpilot -- config validate
npm run wechatpilot -- run daily-tech-digest --dry-run
npm run wechatpilot -- schedule install --hour 8 --minute 0
npm run wechatpilot -- schedule status
npm run wechatpilot -- schedule remove
```

v0.1 scheduling is fixed to `08:00 Asia/Shanghai`. The host system timezone must also be `Asia/Shanghai` because LaunchAgent calendar triggers use the machine timezone.

## Security boundary

| Capability | Typical remote-control bot | WeChatPilot |
| --- | ---: | ---: |
| WeChat can trigger host commands | often possible | explicitly forbidden |
| Arbitrary recipients | often possible | owner-bound only |
| Auto-retry when send is indeterminate | may duplicate | stop by default |
| Credentials stay local | maybe | yes |
| Run/delivery ledger | maybe | yes |

Additional guarantees:

- Project-owned minimal WeChat transport only.
- No upstream remote-control entrypoint, router, adapter registry, or `undici` production dependency.
- Codex child stays ephemeral, read-only, non-interactive, stdin-only.
- Secrets, tokens, cookies, QR codes, and personal paths must stay out of Issues and logs.

See also:

- `docs/security/runtime-closure.md`
- `security/openvex.json`
- `SECURITY.md`
- `THREAT_MODEL.md`

## Privacy model

Local-first means scheduling, credentials, ledgers, locks, and audit state stay on the machine. It does **not** mean model inference is fully offline. Candidate titles, summaries, and public URLs may enter the Codex child process. WeChat tokens, context tokens, and user IDs must not.

Details: [PRIVACY.md](PRIVACY.md) and [DATA_FLOW.md](DATA_FLOW.md).

## Known limitations

- macOS only
- Node.js 22 and logged-in Codex CLI required
- v0.1 locked to Simplified Chinese and `Asia/Shanghai`
- outbound delivery only to the bound owner account
- no inbound WeChat commands, remote shell, or Codex remote control
- only one built-in workflow: daily tech digest
- Public Preview, not Stable
- Issue #4 seven-day stability evidence is still open

## Contribution guide

Thanks for helping improve WeChatPilot.

- Keep WeChat one-way. Do not add inbound command execution or remote control.
- Prefer small pull requests with tests for the changed boundary.
- Do not commit secrets, tokens, cookies, QR codes, private digests, real user IDs, or local absolute paths.
- Start with:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run wechatpilot -- config validate
```

Full contributor guidance: [CONTRIBUTING.md](CONTRIBUTING.md)  
Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)  
Security reporting: [SECURITY.md](SECURITY.md)

## License

MIT for WeChatPilot-owned code. Third-party notices: `THIRD_PARTY_NOTICES.md` and `package-lock.json`.
