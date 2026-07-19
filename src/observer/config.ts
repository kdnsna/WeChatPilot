import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

export const ObserverJobSchema = z
  .object({
    id: z.literal("daily-tech-digest"),
    name: z.literal("每日科技情报"),
    projectLabel: z.literal("WeChatPilot"),
    executable: z.literal("/opt/homebrew/opt/node@22/bin/node"),
    entrypoint: z.literal("dist/src/cli/scheduled.js"),
    arguments: z.tuple([
      z.literal("--project-root"),
      z.literal("{projectRoot}"),
    ]),
    workingDirectory: z.literal("."),
    timeoutMs: z.number().int().min(1_000).max(1_800_000),
    resultAdapter: z.literal("scheduled-digest-json-v1"),
    allowedArtifactRoot: z.literal("output"),
    notify: z.literal("always"),
  })
  .strict();

export const ObserverConfigSchema = z
  .object({
    version: z.literal(1),
    jobs: z.tuple([ObserverJobSchema]),
  })
  .strict();

export type ObserverJob = z.infer<typeof ObserverJobSchema>;

export interface ObserverConfig {
  readonly version: 1;
  readonly jobs: readonly [ObserverJob];
}

export function loadObserverConfig(projectRoot: string): ObserverConfig {
  try {
    const path = join(projectRoot, "config", "observer-jobs.yaml");
    const document = parse(readFileSync(path, "utf8")) as unknown;
    return ObserverConfigSchema.parse(document);
  } catch (error) {
    throw new Error("Invalid observer configuration", { cause: error });
  }
}

export function findObserverJob(
  config: ObserverConfig,
  jobId: string,
): ObserverJob {
  const job = config.jobs.find((candidate) => candidate.id === jobId);
  if (job === undefined) {
    throw new Error("Unknown observer job");
  }
  return job;
}
