# WeChat runtime dependency closure

The production import path is:

```text
src/delivery/wechat.ts
  -> src/transport/wechat-transport.ts
       -> node:crypto
       -> global fetch
  -> qrcode-terminal (QR rendering only)
  -> json-bigint (lossless inbound message identifiers)
```

There is no upstream main entrypoint, router, CLI adapter registry, proxy
initializer, remote-control surface, or `undici` package in this closure.

The OpenVEX statement at `security/openvex.json` becomes invalid if a change
adds `cli-in-wechat`, `undici`, `ProxyAgent`, `initProxyFromEnv`, an upstream
main entrypoint, router, or adapter registry. CI rejects those imports and runs
the boundary tests plus `npm audit --omit=dev` on every change.
