import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { z } from "zod";

export const ResolvedRuntimeSchema = z.object({
  version: z.literal(1),
  nodeExecutable: z.string().refine(isAbsolute),
  nodeVersion: z.string().refine((value) => {
    const match = /^v?(\d+)(?:\.|$)/u.exec(value);
    return match !== null && Number(match[1]) >= 22;
  }, "Node.js 22 or newer is required"),
  codexExecutable: z.string().refine(isAbsolute),
  codexEntrypoint: z.string().refine(isAbsolute),
  codexVersion: z.string().min(1).max(128),
}).strict();

export type ResolvedRuntime = z.infer<typeof ResolvedRuntimeSchema>;

function pathExecutables(name: string, environment: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      found.push(candidate);
    } catch {
      // Continue through the explicit PATH only.
    }
  }
  return found;
}

export function resolveRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedRuntime {
  const nodeExecutable = realpathSync(process.execPath);
  const nodeVersion = process.version;
  const candidates = pathExecutables("codex", environment);
  const codexExecutable = candidates[0];
  if (codexExecutable === undefined) {
    throw new Error("Codex CLI was not found on PATH");
  }
  const resolvedCodex = realpathSync(codexExecutable);
  const codexVersion = execFileSync(codexExecutable, ["--version"], {
    encoding: "utf8",
    maxBuffer: 4_096,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return ResolvedRuntimeSchema.parse({
    version: 1,
    nodeExecutable,
    nodeVersion,
    codexExecutable: realpathSync(codexExecutable),
    codexEntrypoint: resolvedCodex,
    codexVersion,
  });
}

export function resolveRuntimePlaceholders<T>(
  value: T,
  runtime: ResolvedRuntime,
): T {
  const serialized = JSON.stringify(value)
    .replaceAll("{nodeExecutable}", runtime.nodeExecutable)
    .replaceAll("{codexEntrypoint}", runtime.codexEntrypoint);
  return JSON.parse(serialized) as T;
}
