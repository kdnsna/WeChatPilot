# Data flow

```text
Public sources
  -> collectors
  -> ranking / history
  -> candidate bundle (stdin)
  -> Codex child (read-only, ephemeral)
  -> digest artifacts
  -> link gate
  -> WeChat text send

Run authority + draft
  -> run report
  -> optional visual prepare/render
  -> outbox item
  -> delivery state machine
  -> WeChat text/image send
```

## Trust boundaries

1. Source network fetch: public HTTP(S) only, SSRF-checked with pinned DNS addresses.
2. Codex child: project-rooted, read-only, stdin-only candidate data, no shell/apps/plugins.
3. Private state: credentials, ledgers, locks, outbox.
4. WeChat API: one-way send after owner binding; no remote command surface.
