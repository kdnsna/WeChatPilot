import { z } from "zod";

const sourceTierSchema = z.enum(["core", "optional"]);
const sourceWeightSchema = z.number().positive().max(2);
const urlSchema = z.string().url();
const sourceFilterValueSchema = z.string().trim().min(1);

const weightedSourceSchema = z
  .object({
    tier: sourceTierSchema,
    weight: sourceWeightSchema,
  })
  .strict();

const rssFeedSchema = weightedSourceSchema
  .extend({
    id: z.string().min(1),
    name: z.string().min(1),
    url: urlSchema,
  })
  .strict();

export const SourcesConfigSchema = z
  .object({
    version: z.literal(1),
    sources: z
      .object({
        hackerNews: weightedSourceSchema
          .extend({
            kind: z.literal("hacker-news"),
            tier: z.literal("core"),
            endpoints: z
              .object({
                top: urlSchema,
                new: urlSchema,
              })
              .strict(),
          })
          .strict(),
        v2ex: weightedSourceSchema
          .extend({
            kind: z.literal("v2ex"),
            tier: z.literal("core"),
            endpoint: urlSchema,
            technicalNodes: z.array(sourceFilterValueSchema).min(1),
            technicalKeywords: z.array(sourceFilterValueSchema).min(1),
          })
          .strict(),
        github: weightedSourceSchema
          .extend({
            kind: z.literal("github-search"),
            tier: z.literal("core"),
            endpoint: urlSchema,
            query: z.string().includes("created:>="),
            sort: z.literal("stars"),
            order: z.literal("desc"),
            lookbackDays: z.number().int().positive().max(365),
            minimumStars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            itemLimit: z.number().int().positive().max(100),
          })
          .strict(),
        rss: weightedSourceSchema
          .extend({
            kind: z.literal("rss"),
            tier: z.literal("core"),
            feeds: z.array(rssFeedSchema).min(1),
          })
          .strict(),
        reddit: weightedSourceSchema
          .extend({
            kind: z.literal("reddit-rss"),
            tier: z.literal("optional"),
            subreddits: z.array(z.string().min(1)).min(1),
            url: urlSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const rankingWeightsSchema = z
  .object({
    engagement: z.number().min(0).max(1),
    popularity: z.number().min(0).max(1),
    velocity: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
    crossSource: z.number().min(0).max(1),
    sourceQuality: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (weights) =>
      Math.abs(
        Object.values(weights).reduce((total, weight) => total + weight, 0) - 1,
      ) < 1e-12,
    { message: "ranking formula weights must sum to 1" },
  );

export const RankingConfigSchema = z
  .object({
    version: z.literal(1),
    formula: z
      .object({
        weights: rankingWeightsSchema,
      })
      .strict(),
    recency: z
      .object({
        halfLifeHours: z.number().positive(),
      })
      .strict(),
    history: z
      .object({
        lookbackDays: z.number().int().positive(),
        repeatFactor: z.number().min(0).max(1),
      })
      .strict(),
    crossSource: z
      .object({
        confirmationCap: z.number().int().positive(),
      })
      .strict(),
    sourceWeights: z
      .object({
        hackerNews: sourceWeightSchema,
        v2ex: sourceWeightSchema,
        github: sourceWeightSchema,
        rss: sourceWeightSchema,
        reddit: sourceWeightSchema,
      })
      .strict(),
    clustering: z
      .object({
        titleTokenSimilarityThreshold: z.number().min(0).max(1),
        titleCharacterBigramThreshold: z.number().min(0).max(1),
        stripTrackingParameters: z.boolean(),
      })
      .strict(),
  })
  .strict();

const REQUIRED_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "multi_agent",
  "goals",
  "code_mode_host",
  "workspace_dependencies",
  "chronicle",
  "memories",
  "image_generation",
  "tool_suggest",
  "auth_elicitation",
] as const;

const EXPECTED_GLOBAL_ARGS = [
  "--search",
  "--sandbox",
  "read-only",
  "--ask-for-approval",
  "never",
  "--cd",
  "{projectRoot}",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "hooks",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
  "--disable",
  "in_app_browser",
  "--disable",
  "shell_tool",
  "--disable",
  "unified_exec",
  "--disable",
  "shell_snapshot",
  "--disable",
  "multi_agent",
  "--disable",
  "goals",
  "--disable",
  "code_mode_host",
  "--disable",
  "workspace_dependencies",
  "--disable",
  "chronicle",
  "--disable",
  "memories",
  "--disable",
  "image_generation",
  "--disable",
  "tool_suggest",
  "--disable",
  "auth_elicitation",
] as const;

const EXPECTED_EXEC_ARGS = [
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--color",
  "never",
  "--output-schema",
  "{projectRoot}/config/digest-output.schema.json",
  "-",
] as const;

const HARD_FORBIDDEN_CODEX_ARGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--add-dir",
  "workspace-write",
  "danger-full-access",
  "--skip-git-repo-check",
] as const;

function hasArgumentPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((argument, index) => argument === flag && args[index + 1] === value);
}

function matchesArguments(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

const codexConfigSchema = z
  .object({
    version: z.string().min(1).max(128),
    nodeExecutable: z.string().refine((value) => value === "{nodeExecutable}" || value.startsWith("/")),
    javascriptEntrypoint: z.string().refine((value) => value === "{codexEntrypoint}" || value.startsWith("/")),
    direct: z.boolean().default(false),
    globalArgs: z.array(z.string()),
    command: z.literal("exec"),
    execArgs: z.array(z.string()),
    stdinOnly: z.literal(true),
    forbiddenArgs: z.array(z.string()),
  })
  .strict()
  .superRefine((codex, context) => {
    const invocationArgs = [...codex.globalArgs, codex.command, ...codex.execArgs];

    if (!matchesArguments(codex.globalArgs, EXPECTED_GLOBAL_ARGS)) {
      context.addIssue({
        code: "custom",
        path: ["globalArgs"],
        message: "Codex global arguments must match the verified read-only argument list",
      });
    }
    if (!matchesArguments(codex.execArgs, EXPECTED_EXEC_ARGS)) {
      context.addIssue({
        code: "custom",
        path: ["execArgs"],
        message: "Codex exec arguments must match the verified stdin-only argument list",
      });
    }

    for (const forbiddenArg of HARD_FORBIDDEN_CODEX_ARGS) {
      if (invocationArgs.includes(forbiddenArg)) {
        context.addIssue({
          code: "custom",
          path: ["globalArgs"],
          message: `forbidden Codex argument: ${forbiddenArg}`,
        });
      }
      if (!codex.forbiddenArgs.includes(forbiddenArg)) {
        context.addIssue({
          code: "custom",
          path: ["forbiddenArgs"],
          message: `missing required forbidden Codex argument: ${forbiddenArg}`,
        });
      }
    }

    if (!codex.globalArgs.includes("--search")) {
      context.addIssue({
        code: "custom",
        path: ["globalArgs"],
        message: "Codex native search must be enabled",
      });
    }
    if (!hasArgumentPair(codex.globalArgs, "--sandbox", "read-only")) {
      context.addIssue({
        code: "custom",
        path: ["globalArgs"],
        message: "Codex sandbox must be read-only",
      });
    }
    if (!hasArgumentPair(codex.globalArgs, "--ask-for-approval", "never")) {
      context.addIssue({
        code: "custom",
        path: ["globalArgs"],
        message: "Codex approvals must be non-interactive",
      });
    }
    if (!hasArgumentPair(codex.globalArgs, "--cd", "{projectRoot}")) {
      context.addIssue({
        code: "custom",
        path: ["globalArgs"],
        message: "Codex working directory must be the project root",
      });
    }

    for (const feature of REQUIRED_DISABLED_FEATURES) {
      if (!hasArgumentPair(codex.globalArgs, "--disable", feature)) {
        context.addIssue({
          code: "custom",
          path: ["globalArgs"],
          message: `Codex feature must be disabled: ${feature}`,
        });
      }
    }

    for (const requiredExecFlag of [
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
    ]) {
      if (!codex.execArgs.includes(requiredExecFlag)) {
        context.addIssue({
          code: "custom",
          path: ["execArgs"],
          message: `missing required Codex exec flag: ${requiredExecFlag}`,
        });
      }
    }
    if (!hasArgumentPair(codex.execArgs, "--color", "never")) {
      context.addIssue({
        code: "custom",
        path: ["execArgs"],
        message: "Codex color output must be disabled",
      });
    }
    if (
      !hasArgumentPair(
        codex.execArgs,
        "--output-schema",
        "{projectRoot}/config/digest-output.schema.json",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["execArgs"],
        message: "Codex output schema must use the project schema",
      });
    }
    if (codex.execArgs.at(-1) !== "-") {
      context.addIssue({
        code: "custom",
        path: ["execArgs"],
        message: "Codex prompt must be read from stdin",
      });
    }
  });

export const DigestConfigSchema = z
  .object({
    version: z.literal(1),
    timezone: z.literal("Asia/Shanghai"),
    language: z.literal("zh-CN"),
    windowHours: z.number().int().min(1).max(168),
    quotas: z
      .object({
        community: z.literal(3),
        news: z.literal(5),
        github: z.literal(3),
        deepReading: z.literal(2),
      })
      .strict(),
    length: z
      .object({
        unit: z.literal("chinese-characters"),
        min: z.literal(2_000),
        max: z.literal(3_000),
      })
      .strict(),
    codex: codexConfigSchema,
  })
  .strict();

export const DigestUserConfigSchema = DigestConfigSchema.omit({ codex: true });

export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;
export type RankingConfig = z.infer<typeof RankingConfigSchema>;
export type DigestConfig = z.infer<typeof DigestConfigSchema>;
export type UserConfig = z.infer<typeof DigestUserConfigSchema>;
