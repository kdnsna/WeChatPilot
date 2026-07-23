import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import type { ResolvedRuntime } from "../../src/config/runtime.js";

export function fakeRuntime(
  overrides: Partial<ResolvedRuntime> = {},
): ResolvedRuntime {
  const nodeExecutable = realpathSync(process.execPath);
  return {
    version: 1,
    nodeExecutable,
    nodeVersion: process.version,
    codexExecutable: nodeExecutable,
    codexEntrypoint: nodeExecutable,
    codexVersion: "0.0.0-test",
    ...overrides,
  };
}

export function writeRuntimeManifest(
  projectRoot: string,
  runtime: ResolvedRuntime = fakeRuntime(),
): string {
  const stateDirectory = join(projectRoot, ".state");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const path = join(stateDirectory, "runtime.json");
  writeFileSync(path, `${JSON.stringify(runtime, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}
