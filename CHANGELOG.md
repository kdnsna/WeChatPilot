# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Independent delivery outbox so historical report delivery no longer blocks the current observer workflow.
- Shared delivery envelope primitives for future unified payload adapters.
- `readPublicProjectText` / `readPrivateProjectText` split for public workspace files vs private state.
- Layout roots helper for app/workspace/state separation, with compatibility defaults under the project root.
- Optional report visuals: `off`, `deterministic`, `editorial`, and legacy modes.
- Human-readable doctor/health output with remediation hints; `--json` preserved.
- Open-source governance docs: contributing, code of conduct, support, architecture, privacy/data flow, threat model, compatibility, and changelog.

### Changed

- Observer default notify policy is `on-failure`.
- Image capability is optional for basic readiness when visual mode is not `editorial`.
