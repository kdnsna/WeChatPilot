# Threat model

## Assets

- WeChat bot credentials and context tokens
- Owner binding identity
- Delivery ledgers and locks
- Local digests and run reports
- Host filesystem access through the automation process

## Adversaries

- Malicious or compromised public sources
- Network attackers on source fetches or WeChat API transport
- Local malware with same-user filesystem access
- Accidental operator mistakes during open-source packaging

## Key controls

- One-way WeChat delivery only
- Single-owner binding
- Private state permissions and symlink-safe path confinement
- Read-only non-interactive Codex child with disabled dangerous tools
- Delivery ledgers that fail closed on indeterminate sends
- Outbox isolation so historical failures cannot starve the current workflow
- DNS pinning for link probes against rebinding

## Non-goals

- Multi-tenant hosting
- Shared server-side credential storage
- Fully offline local model inference
- Defending a compromised local user account that can already read `~` and process memory
