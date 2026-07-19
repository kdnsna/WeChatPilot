import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
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

function projectRootFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return resolve(process.cwd());
  }
  if (arguments_.length === 2 && arguments_[0] === "--project-root") {
    const value = arguments_[1];
    if (value !== undefined) {
      return resolve(value);
    }
  }
  throw new Error("Usage: health [--project-root PATH]");
}

const processIo: HealthCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export function runHealthCli(
  arguments_: readonly string[],
  io: HealthCliIo = processIo,
  dependencies: HealthCliDependencies = {},
): 0 | 1 {
  const inspect = dependencies.inspect ?? inspectProjectHealth;
  const report = inspect({
    projectRoot: projectRootFromArguments(arguments_),
  });
  const output = `${JSON.stringify(report)}\n`;
  if (report.status === "failed") {
    io.stderr(output);
  } else {
    io.stdout(output);
  }
  return healthExitCode(report);
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
