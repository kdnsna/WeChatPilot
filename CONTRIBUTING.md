# Contributing

Thanks for helping improve WeChatPilot.

## Scope

- Keep WeChat one-way. Do not add inbound command execution, remote control, or Codex exposure through WeChat.
- Prefer small, reviewable pull requests with tests for the changed boundary.
- Do not commit secrets, tokens, cookies, QR codes, private digests, real user IDs, or local absolute paths.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run wechatpilot -- config validate
```

Contributor bootstrap:

```sh
./scripts/init-project.sh
```

Ordinary user setup uses `npm run wechatpilot -- init` and `./scripts/init-wechat.sh`.

## Pull requests

- Explain the risk boundary you touched: delivery, locks, transport, config, or docs.
- Include or update tests for regressions.
- Keep diagnostics free of secrets and absolute personal paths.
- By contributing, you agree that your contribution is licensed under the MIT License of this repository.

## Security

Use private vulnerability reporting for unpatched security issues. See [SECURITY.md](SECURITY.md).
