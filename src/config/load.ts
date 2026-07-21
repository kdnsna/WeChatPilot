import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";
import type { ZodType } from "zod";

import {
  DigestConfigSchema,
  DigestUserConfigSchema,
  RankingConfigSchema,
  SourcesConfigSchema,
  type DigestConfig,
  type RankingConfig,
  type SourcesConfig,
} from "./schema.js";
import { loadRuntimeManifest, resolveRuntime, resolveRuntimePlaceholders, type ResolvedRuntime } from "./runtime.js";
import { loadSecurityProfile } from "./security-profile.js";

export interface ProjectConfig {
  sources: SourcesConfig;
  ranking: RankingConfig;
  digest: DigestConfig;
}

function loadYaml<T>(path: string, schema: ZodType<T>, label: string): T {
  try {
    const document = parse(readFileSync(path, "utf8")) as unknown;
    return schema.parse(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} configuration at ${path}: ${message}`, {
      cause: error,
    });
  }
}

export function loadConfig(projectRoot: string = process.cwd(), runtime?: ResolvedRuntime): ProjectConfig {
  const configDirectory = join(projectRoot, "config");
  let resolvedRuntime = runtime;
  if (resolvedRuntime === undefined) {
    try {
      resolvedRuntime = loadRuntimeManifest(projectRoot);
    } catch {
      resolvedRuntime = resolveRuntime();
    }
  }
  const security = loadSecurityProfile(projectRoot);

  return {
    sources: loadYaml(
      join(configDirectory, "sources.yaml"),
      SourcesConfigSchema,
      "sources",
    ),
    ranking: loadYaml(
      join(configDirectory, "ranking.yaml"),
      RankingConfigSchema,
      "ranking",
    ),
    digest: resolveRuntimePlaceholders(DigestConfigSchema.parse({
      ...loadYaml(join(configDirectory, "digest.yaml"), DigestUserConfigSchema, "digest user"),
      codex: security.digestCodex,
  }), resolvedRuntime),
  };
}
