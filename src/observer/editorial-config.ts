import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import {
  safeCodexEnvironment,
  type CodexInvocation,
} from "../digest/codex.js";

const EXPECTED_GLOBAL_ARGS = [
  "--sandbox",
  "read-only",
  "--ask-for-approval",
  "never",
  "--cd",
  "{projectRoot}",
  "--enable",
  "image_generation",
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
  "--json",
  "--output-schema",
  "{projectRoot}/config/report-image-output.schema.json",
  "-",
] as const;

const HARD_FORBIDDEN_ARGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--add-dir",
  "workspace-write",
  "danger-full-access",
  "--skip-git-repo-check",
] as const;

function exactArguments(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

const EditorialConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["editorial", "legacy"]),
    canvas: z
      .object({
        width: z.literal(1080),
        height: z.literal(2400),
        maximumBytes: z.literal(5_242_880),
      })
      .strict(),
    generation: z
      .object({
        maximumAttempts: z.literal(3),
        timeoutMs: z.literal(180_000),
      })
      .strict(),
    style: z
      .object({
        version: z.literal("editorial-v1"),
        heroHeight: z.literal(480),
      })
      .strict(),
    codex: z
      .object({
        version: z.literal("0.144.4"),
        nodeExecutable: z.literal("/opt/homebrew/opt/node@22/bin/node"),
        javascriptEntrypoint: z.literal(
          "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
        ),
        globalArgs: z.array(z.string()),
        command: z.literal("exec"),
        execArgs: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (!exactArguments(config.codex.globalArgs, EXPECTED_GLOBAL_ARGS)) {
      context.addIssue({
        code: "custom",
        path: ["codex", "globalArgs"],
        message: "unexpected global arguments",
      });
    }
    if (!exactArguments(config.codex.execArgs, EXPECTED_EXEC_ARGS)) {
      context.addIssue({
        code: "custom",
        path: ["codex", "execArgs"],
        message: "unexpected exec arguments",
      });
    }
    const invocation = [
      ...config.codex.globalArgs,
      config.codex.command,
      ...config.codex.execArgs,
    ];
    if (HARD_FORBIDDEN_ARGS.some((argument) => invocation.includes(argument))) {
      context.addIssue({
        code: "custom",
        path: ["codex"],
        message: "forbidden argument",
      });
    }
  });

export type EditorialConfig = z.infer<typeof EditorialConfigSchema>;

function validateOutputSchema(projectRoot: string): void {
  const path = join(projectRoot, "config", "report-image-output.schema.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const expected = {
    type: "object",
    additionalProperties: false,
    required: ["status", "imagePath"],
    properties: {
      status: { type: "string", enum: ["generated"] },
      imagePath: { type: "string", minLength: 1, maxLength: 1024 },
    },
  };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error("schema mismatch");
  }
}

export function loadEditorialConfig(projectRoot: string): EditorialConfig {
  try {
    if (!isAbsolute(projectRoot)) {
      throw new TypeError("project root must be absolute");
    }
    const path = join(projectRoot, "config", "report-visual.yaml");
    const document = parse(readFileSync(path, "utf8")) as unknown;
    const config = EditorialConfigSchema.parse(document);
    validateOutputSchema(projectRoot);
    return config;
  } catch {
    throw new Error("Invalid editorial report configuration");
  }
}

function expandProjectRoot(argument: string, projectRoot: string): string {
  return argument.replaceAll("{projectRoot}", projectRoot);
}

export function buildEditorialImageInvocation(
  config: EditorialConfig,
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): CodexInvocation {
  try {
    const validated = EditorialConfigSchema.parse(config);
    if (!isAbsolute(projectRoot)) {
      throw new TypeError("project root must be absolute");
    }
    return {
      executable: validated.codex.nodeExecutable,
      args: [
        validated.codex.javascriptEntrypoint,
        ...validated.codex.globalArgs.map((argument) =>
          expandProjectRoot(argument, projectRoot),
        ),
        validated.codex.command,
        ...validated.codex.execArgs.map((argument) =>
          expandProjectRoot(argument, projectRoot),
        ),
      ],
      cwd: projectRoot,
      env: safeCodexEnvironment(environment),
    };
  } catch {
    throw new Error("Invalid editorial report configuration");
  }
}
