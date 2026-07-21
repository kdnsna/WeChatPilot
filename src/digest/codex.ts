import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import type { DigestConfig } from "../config/schema.js";
import { redactSecrets } from "../security/redact.js";

export interface CodexInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CodexExecutionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maximumOutputBytes?: number;
}

export type CodexFailureKind =
  | "aborted"
  | "failed"
  | "output_limit"
  | "spawn"
  | "timeout";

export class CodexExecutionError extends Error {
  override readonly name = "CodexExecutionError";
  readonly kind: CodexFailureKind;
  readonly exitCode?: number;
  readonly diagnostic?: string;

  constructor(
    kind: CodexFailureKind,
    options: { readonly exitCode?: number; readonly diagnostic?: string } = {},
  ) {
    super(`Codex digest generation failed: ${kind}`);
    this.kind = kind;
    if (options.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options.diagnostic !== undefined) {
      this.diagnostic = options.diagnostic;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.diagnostic === undefined ? {} : { diagnostic: this.diagnostic }),
    };
  }
}

const SAFE_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "CODEX_HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "__CF_USER_TEXT_ENCODING",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

export function safeCodexEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (SAFE_ENVIRONMENT_NAMES.has(name) && value !== undefined) {
      safe[name] = value;
    }
  }
  return safe;
}

function expandProjectRoot(argument: string, projectRoot: string): string {
  return argument.replaceAll("{projectRoot}", projectRoot);
}

export function buildCodexInvocation(
  config: DigestConfig["codex"],
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): CodexInvocation {
  if (
    !isAbsolute(projectRoot) ||
    !isAbsolute(config.nodeExecutable) ||
    !isAbsolute(config.javascriptEntrypoint)
  ) {
    throw new TypeError("Codex invocation paths must be absolute");
  }
  const configuredArguments = [
    ...config.globalArgs,
    config.command,
    ...config.execArgs,
  ];
  for (const forbidden of config.forbiddenArgs) {
    if (configuredArguments.includes(forbidden)) {
      throw new TypeError("Codex invocation contains a forbidden argument");
    }
  }
  return {
    executable: config.direct ? config.javascriptEntrypoint : config.nodeExecutable,
    args: [
      ...(config.direct ? [] : [config.javascriptEntrypoint]),
      ...configuredArguments.map((argument) =>
        expandProjectRoot(argument, projectRoot),
      ),
    ],
    cwd: projectRoot,
    env: safeCodexEnvironment(environment),
  };
}

function safeDiagnostic(stderr: string): string | undefined {
  const errorMarker = stderr.lastIndexOf("ERROR:");
  const diagnosticSource =
    errorMarker >= 0 ? stderr.slice(errorMarker) : stderr.slice(-1_000);
  const tail = diagnosticSource.slice(-2_000).trim();
  if (tail === "") {
    return undefined;
  }
  const redacted = redactSecrets(tail);
  return typeof redacted === "string" ? redacted.slice(-1_000) : undefined;
}

export async function executeCodex(
  invocation: CodexInvocation,
  prompt: string,
  options: CodexExecutionOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maximumOutputBytes = options.maximumOutputBytes ?? 8 * 1_024 * 1_024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Codex timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new RangeError("Codex output limit must be a positive safe integer");
  }
  if (options.signal?.aborted === true) {
    throw new CodexExecutionError("aborted");
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    };
    const onAbort = (): void => {
      terminate();
      finish(() => reject(new CodexExecutionError("aborted")));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new CodexExecutionError("timeout")));
    }, timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        terminate();
        finish(() => reject(new CodexExecutionError("output_limit")));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        terminate();
        finish(() => reject(new CodexExecutionError("output_limit")));
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => {
      finish(() => reject(new CodexExecutionError("spawn")));
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish(() => resolve(stdout));
        return;
      }
      const diagnostic = safeDiagnostic(stderr);
      finish(() =>
        reject(
          new CodexExecutionError("failed", {
            ...(code === null ? {} : { exitCode: code }),
            ...(diagnostic === undefined ? {} : { diagnostic }),
          }),
        ),
      );
    });
    child.stdin.on("error", () => {
      // Exit handling above returns the sanitized authoritative failure.
    });
    child.stdin.end(prompt, "utf8");
  });
}
