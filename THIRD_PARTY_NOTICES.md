# Third-Party Notices

WeChatPilot includes a Git submodule at `vendor/cli-in-wechat` that points to:

- Project: `cli-in-wechat`
- Upstream: <https://github.com/sgaofen/cli-in-wechat>
- Reviewed commit: `75d7db9338e133080fef9914b92ceb5e3ebd0dfc`
- Declared license at that commit: MIT (`package.json`)

The submodule remains a separate upstream work and is not covered by the
copyright notice for WeChatPilot's own code. Obtain its source and applicable
license terms from the upstream repository. WeChatPilot uses only a narrowly
reviewed QR-login, context and proactive-send adapter surface; see
`vendor/README.md` for the pinned integration and security boundary.

Other npm dependencies remain subject to their respective licenses. Their exact
resolved versions are recorded in `package-lock.json` and the submodule's own
lockfile.

WeChat, 微信 and related names and marks belong to their respective owners.
WeChatPilot is independent and is not affiliated with, authorized by, or
endorsed by WeChat or Tencent.
