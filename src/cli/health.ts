import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatProjectHealthHuman,
  healthExitCode,
  inspectProjectHealth,
  type InspectProjectHealthOptions,
  type ProjectHealthReport,
} from "../app/health.js";

export interface HealthCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface HealthCliDependencies {
  readonly inspect?: (
    options: InspectProjectHealthOptions,
  ) => ProjectHealthReport;
}

export interface HealthCliOptions {
  readonly projectRoot: string;
  readonly json: boolean;
  readonly requireWechat: boolean;
  readonly requireImage: boolean;
  readonly strict: boolean;
}

function parseHealthArguments(arguments_: readonly string[]): HealthCliOptions {
  let projectRoot = resolve(process.cwd());
  let json = false;
  let requireWechat = false;
  let requireImage = false;
  let strict = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const current = arguments_[index];
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--require-wechat") {
      requireWechat = true;
      continue;
    }
    if (current === "--require-image") {
      requireImage = true;
      continue;
    }
    if (current === "--strict") {
      strict = true;
      continue;
    }
    if (current === "--project-root") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("Usage: health [--project-root PATH] [--json] [--require-wechat] [--require-image] [--strict]");
      }
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new Error("Usage: health [--project-root PATH] [--json] [--require-wechat] [--require-image] [--strict]");
  }
  return { projectRoot, json, requireWechat, requireImage, strict };
}

function applyStrictness(
  report: ProjectHealthReport,
  options: HealthCliOptions,
): ProjectHealthReport {
  const diagnostics = [...report.diagnostics];
  let status = report.status;
  let requiredReady = report.requiredReady;
  if (options.requireWechat && report.wechat.status !== "ready") {
    diagnostics.push("WeChat readiness check failed");
    status = "failed";
    requiredReady = false;
  }
  if (options.requireImage && !report.observer.imageCapabilityReady) {
    diagnostics.push("observer image capability unavailable");
    status = "failed";
    requiredReady = false;
  }
  if (options.strict && (report.observer.pendingDeliveries > 0 || report.observer.indeterminateDeliveries > 0 || report.status === "pending")) {
    status = status === "failed" ? "failed" : "pending";
  }
  return {
    ...report,
    status,
    requiredReady,
    diagnostics: [...new Set(diagnostics)],
  };
}

export function healthCliExitCode(
  report: ProjectHealthReport,
  options: Pick<HealthCliOptions, "strict">,
): 0 | 1 | 2 {
  if (report.status === "failed" || !report.requiredReady) return 1;
  if (options.strict && report.status === "pending") return 2;
  return healthExitCode(report);
}

const processIo: HealthCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export function runHealthCli(
  arguments_: readonly string[],
  io: HealthCliIo = processIo,
  dependencies: HealthCliDependencies = {},
): 0 | 1 | 2 {
  const options = parseHealthArguments(arguments_);
  const inspect = dependencies.inspect ?? inspectProjectHealth;
  const report = applyStrictness(
    inspect({ projectRoot: options.projectRoot }),
    options,
  );
  const output = options.json
    ? `${JSON.stringify(report)}\n`
    : formatProjectHealthHuman(report);
  if (report.status === "failed") {
    io.stderr(output);
  } else {
    io.stdout(output);
  }
  return healthCliExitCode(report, options);
}

function main(): void {
  try {
    process.exitCode = runHealthCli(process.argv.slice(2));
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        status: "failed",
        requiredReady: false,
        message: "health check failed; no sensitive details were emitted",
      })}\n`,
    );
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main();
}
