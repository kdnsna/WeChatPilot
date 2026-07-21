import { dirname, join } from "node:path";

import type { RegisteredCollector } from "../collectors/run.js";
import { loadConfig } from "../config/load.js";
import {
  buildCandidateBundle,
  buildDigestPrompt,
} from "../digest/candidates.js";
import {
  buildCodexInvocation,
  executeCodex,
  type CodexInvocation,
} from "../digest/codex.js";
import {
  parseAndValidateDigest,
  type DigestOutput,
} from "../digest/validate.js";
import {
  ensureAccessibleDigestLinks,
  type DigestLinkProbe,
  type PublicHostnameResolver,
} from "../digest/links.js";
import type { FetchLike, HttpClient } from "../lib/http.js";
import { createJsonlLogger } from "../lib/logger.js";
import { readProjectText, writeProjectTextAtomic } from "../lib/project-file.js";
import { createProjectPaths } from "../lib/paths.js";
import { shanghaiDateKey } from "../lib/time.js";
import { redactSecrets } from "../security/redact.js";
import { writeDigestHistoryManifest } from "../history/digest-manifest.js";
import {
  runDailyCollection,
  type DailyCollectionResult,
} from "./collect.js";

const MAX_PROMPT_TEMPLATE_BYTES = 128 * 1_024;
const MAX_CODEX_INPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_GENERATION_ATTEMPTS = 3;

export interface DailyDigestOptions {
  readonly projectRoot: string;
  readonly now?: Date;
  readonly githubToken?: string;
  readonly signal?: AbortSignal;
  readonly dryRun?: boolean;
  readonly fetch?: FetchLike;
  readonly httpClient?: HttpClient;
  readonly registrations?: readonly RegisteredCollector[];
  readonly minimumCoreSuccesses?: number;
  readonly executeCodex?: typeof executeCodex;
  readonly linkProbe?: DigestLinkProbe;
  readonly linkHostnameResolver?: PublicHostnameResolver;
}

interface DigestResultBase {
  readonly collection: DailyCollectionResult;
  readonly inputPath: string;
  readonly invocation: CodexInvocation;
  readonly logPath: string;
  readonly candidateCount: number;
}

export interface DigestDryRunResult extends DigestResultBase {
  readonly status: "dry-run";
}

export interface GeneratedDigestResult extends DigestResultBase {
  readonly status: "generated";
  readonly digestPath: string;
  readonly jsonPath: string;
  readonly historyManifestPath: string;
  readonly output: DigestOutput;
  readonly attempts: number;
}

export type DailyDigestResult = DigestDryRunResult | GeneratedDigestResult;

function sanitizedValidatedOutput(
  stdout: string,
  date: string,
  allowedUrls: readonly string[],
): DigestOutput {
  const firstPass = parseAndValidateDigest(stdout, { date, allowedUrls });
  const redacted = redactSecrets(firstPass);
  return parseAndValidateDigest(JSON.stringify(redacted), {
    date,
    allowedUrls,
  });
}

export async function runDailyDigest(
  options: DailyDigestOptions,
): Promise<DailyDigestResult> {
  const now = options.now ?? new Date();
  const paths = createProjectPaths(options.projectRoot);
  const date = shanghaiDateKey(now);
  const logPath = join(paths.logs, `digest-${date}.jsonl`);
  const logger = createJsonlLogger({
    projectRoot: options.projectRoot,
    filePath: logPath,
    now: () => now,
  });
  const collection = await runDailyCollection({
    projectRoot: options.projectRoot,
    now,
    ...(options.githubToken === undefined
      ? {}
      : { githubToken: options.githubToken }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.httpClient === undefined
      ? {}
      : { httpClient: options.httpClient }),
    ...(options.registrations === undefined
      ? {}
      : { registrations: options.registrations }),
    ...(options.minimumCoreSuccesses === undefined
      ? {}
      : { minimumCoreSuccesses: options.minimumCoreSuccesses }),
  });
  const config = loadConfig(options.projectRoot);
  const promptTemplatePath = join(paths.root, "prompts", "daily-digest.md");
  const promptTemplate = readProjectText(
    options.projectRoot,
    promptTemplatePath,
    MAX_PROMPT_TEMPLATE_BYTES,
  );
  if (promptTemplate === null) {
    throw new Error("Daily digest prompt template is missing");
  }
  const bundle = buildCandidateBundle(
    collection.ranked,
    collection.collection.results,
    now,
  );
  const prompt = buildDigestPrompt(promptTemplate, bundle);
  if (new TextEncoder().encode(prompt).byteLength > MAX_CODEX_INPUT_BYTES) {
    throw new RangeError("Codex digest input exceeded the configured size limit");
  }
  const inputPath = join(
    dirname(collection.artifacts.rawPath),
    `${collection.artifacts.runId}-codex-input.txt`,
  );
  writeProjectTextAtomic(options.projectRoot, inputPath, prompt);
  const invocation = buildCodexInvocation(
    config.digest.codex,
    options.projectRoot,
  );
  await logger.info("digest input prepared", {
    runId: collection.artifacts.runId,
    candidateCount: bundle.candidates.length,
    dryRun: options.dryRun === true,
  });
  const base: DigestResultBase = {
    collection,
    inputPath,
    invocation,
    logPath,
    candidateCount: bundle.candidates.length,
  };
  if (options.dryRun === true) {
    return { ...base, status: "dry-run" };
  }

  const allowedUrls = [
    ...new Set(
      bundle.candidates.flatMap((candidate) => [
        candidate.url,
        ...candidate.relatedUrls,
      ]),
    ),
  ];
  const execute = options.executeCodex ?? executeCodex;
  let attempts = 0;
  let output: DigestOutput | undefined;
  let generationPrompt = prompt;
  while (attempts < MAX_GENERATION_ATTEMPTS && output === undefined) {
    attempts += 1;
    const stdout = await execute(invocation, generationPrompt, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      output = sanitizedValidatedOutput(stdout, date, allowedUrls);
    } catch (error) {
      const validationReason =
        error instanceof Error ? error.message : "unknown validation failure";
      await logger.warn("digest output validation failed", {
        attempt: attempts,
        errorName: error instanceof Error ? error.name : "UnknownError",
        validationReason,
      });
      if (attempts >= MAX_GENERATION_ATTEMPTS) {
        throw error;
      }
      generationPrompt = `${prompt}\n上一次响应未通过本地校验，固定失败原因是：${validationReason}。请从同一候选数据重新生成完整 JSON，逐项修复该问题；不要复述上一次响应。\n`;
    }
  }
  if (output === undefined) {
    throw new Error("Digest generation produced no validated output");
  }
  const beforeLinkGate = output.sourceUrls;
  try {
    output = await ensureAccessibleDigestLinks(output, bundle.candidates, {
      date,
      allowedUrls,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.linkProbe === undefined ? {} : { probe: options.linkProbe }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.linkHostnameResolver === undefined
        ? {}
        : { resolveHostname: options.linkHostnameResolver }),
    });
    await logger.info("digest link gate completed", {
      replacements: output.sourceUrls.filter((url, index) => url !== beforeLinkGate[index]).length,
    });
  } catch (error) {
    await logger.warn("digest link gate failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
  const digestPath = join(paths.output, `${date}-digest.txt`);
  const jsonPath = join(paths.output, `${date}-digest.json`);
  writeProjectTextAtomic(options.projectRoot, digestPath, `${output.digest.trim()}\n`);
  writeProjectTextAtomic(
    options.projectRoot,
    jsonPath,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  const historyManifestPath = writeDigestHistoryManifest(
    options.projectRoot,
    output,
    bundle.candidates,
  );
  await logger.info("digest generated", {
    runId: collection.artifacts.runId,
    attempts,
    sourceUrlCount: output.sourceUrls.length,
    digestProseCharacters: [
      ...output.digest
        .replace(/https?:\/\/[^\s<>"']+/gu, "")
        .replace(/\s/gu, ""),
    ].length,
  });
  return {
    ...base,
    status: "generated",
    digestPath,
    jsonPath,
    historyManifestPath,
    output,
    attempts,
  };
}
