# Architecture

## Goals

WeChatPilot is a local-first automation host for one-way WeChat delivery. The first built-in workflow is the daily tech digest.

## Process layout

```text
LaunchAgent / CLI
  -> observer job runner
      -> managed digest workflow
      -> final run report
      -> delivery outbox
          -> delivery state machine
              -> WeChat transport
```

## Delivery

- Workflow execution creates durable artifacts and enqueues delivery work.
- Historical and retryable deliveries live in an outbox under private state.
- Each scheduled pass drains only a limited number of historical items.
- Indeterminate results enter manual review and never auto-replay.
- Digest text and run-report text/image share disposition concepts through delivery envelopes.

## Configuration layers

- `UserConfig`: sources, ranking, digest preferences, observer notify policy, visual mode.
- `SecurityProfile`: fixed Codex sandbox, disabled tools, forbidden args, recipient constraints.
- `ResolvedRuntime`: detected Node/Codex paths and versions.

## Roots

- `appRoot`: read-mostly code, prompts, and packaged config templates.
- `workspaceRoot`: user config overrides, outputs, history, logs.
- `stateRoot`: credentials, ledgers, locks, outbox, private runtime markers.

Compatibility default: all three remain under the project root until a profile root is configured.
