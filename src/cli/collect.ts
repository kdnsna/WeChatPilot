import { resolve } from "node:path";

import { runDailyCollection } from "../app/collect.js";

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
  throw new Error("Usage: collect [--project-root ABSOLUTE_PATH]");
}

async function main(): Promise<void> {
  const projectRoot = projectRootFromArguments(process.argv.slice(2));
  const result = await runDailyCollection({
    projectRoot,
    ...(process.env.GITHUB_TOKEN === undefined
      ? {}
      : { githubToken: process.env.GITHUB_TOKEN }),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runId: result.artifacts.runId,
      sourceStatuses: result.collection.results.map((source) => ({
        source: source.sourceId,
        status: source.status,
        items: source.items.length,
      })),
      itemCount: result.collection.items.length,
      eligibleItemCount: result.eligibleItemCount,
      rankedCount: result.ranked.length,
      degraded: result.collection.degraded,
      rawPath: result.artifacts.rawPath,
      rankedPath: result.artifacts.rankedPath,
      logPath: result.logPath,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: name, message: "collection failed; inspect the project log" })}\n`,
  );
  process.exitCode = 1;
});
