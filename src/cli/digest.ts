import { resolve } from "node:path";

import { runDailyDigest } from "../app/digest.js";

function arguments_(values: readonly string[]): {
  readonly projectRoot: string;
  readonly dryRun: boolean;
} {
  let projectRoot = resolve(process.cwd());
  let dryRun = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--project-root") {
      const path = values[index + 1];
      if (path === undefined) {
        throw new Error("--project-root requires a path");
      }
      projectRoot = resolve(path);
      index += 1;
      continue;
    }
    throw new Error("Usage: digest [--dry-run] [--project-root ABSOLUTE_PATH]");
  }
  return { projectRoot, dryRun };
}

async function main(): Promise<void> {
  const parsed = arguments_(process.argv.slice(2));
  const result = await runDailyDigest({
    projectRoot: parsed.projectRoot,
    dryRun: parsed.dryRun,
    ...(process.env.GITHUB_TOKEN === undefined
      ? {}
      : { githubToken: process.env.GITHUB_TOKEN }),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      status: result.status,
      runId: result.collection.artifacts.runId,
      candidateCount: result.candidateCount,
      inputPath: result.inputPath,
      ...(result.status === "generated"
        ? {
            digestPath: result.digestPath,
            jsonPath: result.jsonPath,
            attempts: result.attempts,
            sourceUrlCount: result.output.sourceUrls.length,
          }
        : {
            executable: result.invocation.executable,
            args: result.invocation.args,
          }),
      logPath: result.logPath,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const diagnostic =
    error !== null &&
    typeof error === "object" &&
    "diagnostic" in error &&
    typeof error.diagnostic === "string"
      ? error.diagnostic
      : undefined;
  const validationReason =
    error instanceof Error && error.name === "DigestValidationError"
      ? error.message
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.name : "UnknownError",
      message: "digest generation failed; inspect the project log",
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(validationReason === undefined ? {} : { validationReason }),
    })}\n`,
  );
  process.exitCode = 1;
});
