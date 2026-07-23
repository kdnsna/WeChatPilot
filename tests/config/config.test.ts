import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import { fakeRuntime, writeRuntimeManifest } from "../helpers/runtime.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots: string[] = [];
const requiredForbiddenCodexArgs = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--add-dir",
  "workspace-write",
  "danger-full-access",
  "--skip-git-repo-check",
] as const;

type ConfigFileName = "sources.yaml" | "ranking.yaml" | "digest.yaml" | "security-profile.yaml";

function copyConfigFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "daily-tech-digest-config-"));
  const configDirectory = join(root, "config");
  mkdirSync(configDirectory);

  for (const name of ["sources.yaml", "ranking.yaml", "digest.yaml", "security-profile.yaml"]) {
    copyFileSync(join(projectRoot, "config", name), join(configDirectory, name));
  }
  writeRuntimeManifest(root);

  temporaryRoots.push(root);
  return root;
}

function replaceInConfig(
  root: string,
  name: ConfigFileName,
  needle: string,
  replacement: string,
): void {
  const path = join(root, "config", name);
  const original = readFileSync(path, "utf8");
  expect(original).toContain(needle);
  writeFileSync(path, original.replace(needle, replacement), "utf8");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("keeps the Codex output schema within the supported basic subset", () => {
    const schema = JSON.parse(
      readFileSync(join(projectRoot, "config", "digest-output.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(schema);

    expect(serialized).not.toContain("uniqueItems");
    expect(serialized).not.toContain('"format"');
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "date", "digest", "sourceUrls", "editorial"],
    });
  });

  it("loads and validates all three project YAML configurations", () => {
    const config = loadConfig(projectRoot, fakeRuntime());

    expect(config.sources.version).toBe(1);
    expect(config.ranking.version).toBe(1);
    expect(config.digest.version).toBe(1);
    expect(config.digest.timezone).toBe("Asia/Shanghai");
    expect(config.digest.windowHours).toBe(24);
    expect(config.digest.quotas).toEqual({
      community: 3,
      news: 5,
      github: 3,
      deepReading: 2,
    });
    expect(config.digest.length).toEqual({
      unit: "chinese-characters",
      min: 2000,
      max: 3000,
    });
  });

  it("keeps ranking formula weights normalized to one", () => {
    const { weights } = loadConfig(projectRoot, fakeRuntime()).ranking.formula;
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBeCloseTo(1, 12);
    expect(weights).toEqual({
      engagement: 0.24,
      popularity: 0.2,
      velocity: 0.18,
      recency: 0.18,
      crossSource: 0.12,
      sourceQuality: 0.08,
    });
    expect(loadConfig(projectRoot, fakeRuntime()).ranking.history).toEqual({
      lookbackDays: 7,
      repeatFactor: 0.35,
    });
  });

  it("contains every required source group and keeps Reddit optional", () => {
    const { sources } = loadConfig(projectRoot, fakeRuntime()).sources;

    expect(Object.keys(sources)).toEqual([
      "hackerNews",
      "v2ex",
      "github",
      "rss",
      "reddit",
    ]);
    expect(sources.hackerNews.endpoints).toEqual({
      top: "https://hacker-news.firebaseio.com/v0/topstories.json",
      new: "https://hacker-news.firebaseio.com/v0/newstories.json",
    });
    expect(sources.v2ex.technicalNodes).toEqual(
      expect.arrayContaining([
        "programmer",
        "python",
        "javascript",
        "rust",
        "linux",
        "docker",
        "kubernetes",
        "openai",
        "claude",
        "localllm",
      ]),
    );
    expect(sources.v2ex.technicalKeywords).toEqual(
      expect.arrayContaining([
        "人工智能",
        "大模型",
        "LLM",
        "Codex",
        "开源",
        "TypeScript",
        "Kubernetes",
      ]),
    );
    expect(sources.github.query).toContain("created:>=");
    expect(sources.github).toMatchObject({
      lookbackDays: 30,
      minimumStars: 20,
      itemLimit: 50,
    });
    expect(sources.rss.feeds.map((feed) => feed.id)).toEqual([
      "techcrunch",
      "the-verge",
      "ars-technica",
      "wired",
      "mit-technology-review",
      "the-register",
      "openai",
      "deepmind",
      "google-ai",
      "microsoft-ai",
      "hugging-face",
      "mistral-ai",
      "nvidia",
    ]);
    expect(sources.reddit.kind).toBe("reddit-rss");
    expect(sources.reddit.tier).toBe("optional");
    expect(sources.reddit.url).toContain("technology+programming");
  });

  it("resolves the detected Codex runtime while preserving the verified security profile", () => {
    const { codex } = loadConfig(projectRoot, fakeRuntime()).digest;

    expect(codex.nodeExecutable).toBe(realpathSync(process.execPath));
    expect(codex.javascriptEntrypoint).toMatch(/^\//u);
    expect(codex.direct).toBe(true);
    expect(codex.version).toBe("detected");
    expect(codex.command).toBe("exec");
    expect(codex.globalArgs).toEqual([
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
    ]);
    expect(codex.execArgs).toEqual([
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--output-schema",
      "{projectRoot}/config/digest-output.schema.json",
      "-",
    ]);
    expect(codex.forbiddenArgs).toEqual(requiredForbiddenCodexArgs);
  });

  it.each(requiredForbiddenCodexArgs)("rejects forbidden Codex argument %s", (unsafeArg) => {
    const root = copyConfigFixture();
    replaceInConfig(
      root,
      "security-profile.yaml",
      "  command: exec\n",
      `    - ${unsafeArg}\n  command: exec\n`,
    );

    expect(() => loadConfig(root)).toThrowError(
      new RegExp(`forbidden Codex argument: ${unsafeArg.replaceAll("-", "\\-")}`, "i"),
    );
  });

  it("rejects an extra sandbox argument that could override read-only mode", () => {
    const root = copyConfigFixture();
    const digestPath = join(root, "config", "security-profile.yaml");
    const safeDigest = readFileSync(digestPath, "utf8");
    const unsafeDigest = safeDigest.replace(
      "    - read-only\n",
      "    - read-only\n    - --sandbox\n    - workspace-write\n",
    );
    writeFileSync(digestPath, unsafeDigest, "utf8");

    expect(() => loadConfig(root)).toThrowError(/verified read-only argument list/i);
  });

  it.each([
    {
      boundary: "sources top-level",
      name: "sources.yaml",
      needle: "version: 1\n",
      replacement: "version: 1\nunknownTopLevel: true\n",
    },
    {
      boundary: "sources group map",
      name: "sources.yaml",
      needle: "sources:\n",
      replacement: "sources:\n  unknownSource: true\n",
    },
    {
      boundary: "Hacker News source",
      name: "sources.yaml",
      needle: "    kind: hacker-news\n",
      replacement: "    kind: hacker-news\n    unknownHackerNewsField: true\n",
    },
    {
      boundary: "Hacker News endpoints",
      name: "sources.yaml",
      needle: "    endpoints:\n",
      replacement: "    endpoints:\n      unknownEndpointField: true\n",
    },
    {
      boundary: "V2EX source",
      name: "sources.yaml",
      needle: "    kind: v2ex\n",
      replacement: "    kind: v2ex\n    unknownV2exField: true\n",
    },
    {
      boundary: "RSS feed",
      name: "sources.yaml",
      needle: "        url: https://techcrunch.com/feed/\n",
      replacement:
        "        url: https://techcrunch.com/feed/\n        unknownFeedField: true\n",
    },
    {
      boundary: "ranking top-level",
      name: "ranking.yaml",
      needle: "version: 1\n",
      replacement: "version: 1\nunknownTopLevel: true\n",
    },
    {
      boundary: "ranking formula",
      name: "ranking.yaml",
      needle: "formula:\n",
      replacement: "formula:\n  unknownFormulaField: true\n",
    },
    {
      boundary: "ranking weights",
      name: "ranking.yaml",
      needle: "  weights:\n",
      replacement: "  weights:\n    unknownWeight: 0\n",
    },
    {
      boundary: "ranking recency",
      name: "ranking.yaml",
      needle: "recency:\n",
      replacement: "recency:\n  unknownRecencyField: true\n",
    },
    {
      boundary: "ranking history",
      name: "ranking.yaml",
      needle: "history:\n",
      replacement: "history:\n  unknownHistoryField: true\n",
    },
    {
      boundary: "ranking cross-source settings",
      name: "ranking.yaml",
      needle: "crossSource:\n",
      replacement: "crossSource:\n  unknownCrossSourceField: true\n",
    },
    {
      boundary: "ranking source weights",
      name: "ranking.yaml",
      needle: "sourceWeights:\n",
      replacement: "sourceWeights:\n  unknownSourceWeight: 1\n",
    },
    {
      boundary: "ranking clustering",
      name: "ranking.yaml",
      needle: "clustering:\n",
      replacement: "clustering:\n  unknownClusteringField: true\n",
    },
    {
      boundary: "digest top-level",
      name: "digest.yaml",
      needle: "version: 1\n",
      replacement: "version: 1\nunknownTopLevel: true\n",
    },
    {
      boundary: "digest quotas",
      name: "digest.yaml",
      needle: "quotas:\n",
      replacement: "quotas:\n  unknownQuota: 1\n",
    },
    {
      boundary: "digest length",
      name: "digest.yaml",
      needle: "length:\n",
      replacement: "length:\n  unknownLengthField: true\n",
    },
    {
      boundary: "digest Codex settings",
      name: "security-profile.yaml",
      needle: "digestCodex:\n",
      replacement: "digestCodex:\n  unknownCodexField: true\n",
    },
  ] as const)("rejects unknown keys at the $boundary boundary", ({ name, needle, replacement }) => {
    const root = copyConfigFixture();
    replaceInConfig(root, name, needle, replacement);

    expect(() => loadConfig(root)).toThrowError(/unrecognized key/i);
  });

  it.each(["technicalNodes", "technicalKeywords"] as const)(
    "rejects an empty V2EX %s filter",
    (field) => {
      const root = copyConfigFixture();
      const sourcesPath = join(root, "config", "sources.yaml");
      const original = readFileSync(sourcesPath, "utf8");
      const filterBlock = new RegExp(`    ${field}:\\n(?:      - .+\\n)+`);
      const invalid = original.replace(filterBlock, `    ${field}: []\n`);
      expect(invalid).not.toBe(original);
      writeFileSync(sourcesPath, invalid, "utf8");

      expect(() => loadConfig(root)).toThrowError(/too small|at least 1/i);
    },
  );
});

describe("authoritative runtime manifest", () => {
  it("fails closed when the runtime manifest is missing", () => {
    const root = copyConfigFixture();
    rmSync(join(root, ".state"), { recursive: true, force: true });
    expect(() => loadConfig(root)).toThrow(/runtime manifest|ENOENT|no such file|invalid/i);
  });

  it("fails closed when the runtime manifest mode is not 0600", () => {
    const root = copyConfigFixture();
    const manifest = join(root, ".state", "runtime.json");
    chmodSync(manifest, 0o644);
    expect(() => loadConfig(root)).toThrow(/runtime manifest/i);
  });

  it("uses the supplied runtime without PATH discovery", () => {
    const root = copyConfigFixture();
    const usable = fakeRuntime();
    const config = loadConfig(root, usable);
    expect(config.digest.codex.nodeExecutable).toBe(usable.nodeExecutable);
    expect(config.digest.codex.javascriptEntrypoint).toBe(usable.codexEntrypoint);
  });
});

