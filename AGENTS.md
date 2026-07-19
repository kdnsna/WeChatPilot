# Project safety rules

- Never invoke Codex with `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--add-dir`, `danger-full-access`, or any equivalent sandbox/approval bypass.
- Never expose Codex, a shell, arbitrary commands, or remote-control behavior through WeChat. WeChat is a one-way delivery destination only.
- Never print, log, commit, or include secrets in errors, fixtures, prompts, generated digests, or command output. Redact tokens, credentials, cookies, authorization headers, passwords, and local WeChat context before persistence.
- Treat `vendor/cli-in-wechat` only as a pinned upstream QR-login/context/proactive-send adapter. Do not start or reuse any upstream Codex or remote-control entry point.
- Do not set, clear, or repurpose `HOME` or `CODEX_HOME` for the application or its child processes.

## Child Codex invocation boundary

The following restrictions apply specifically to the digest-generating Codex child invocation. They do not prohibit normal development agents from using the shell or reading repository files while building and testing this project.

- Pass the ranked candidate bundle only through stdin.
- Keep the child ephemeral, read-only, non-interactive, and rooted at this project.
- The child must not run shell commands, open applications, use apps/plugins/hooks/browser/computer-use tools, add directories, or read personal files or directories outside the supplied stdin data.
- Native web search is allowed only to verify candidate facts and accessible source links.
