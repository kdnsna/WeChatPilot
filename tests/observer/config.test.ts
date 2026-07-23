import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  findObserverJob,
  loadObserverConfig,
} from "../../src/observer/config.js";
import { fakeRuntime, writeRuntimeManifest } from "../helpers/runtime.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots: string[] = [];

const validJob = {
  id: "daily-tech-digest",
  name: "每日科技情报",
  projectLabel: "WeChatPilot",
  executable: "/path/to/node",
  entrypoint: "dist/src/cli/scheduled.js",
  arguments: ["--project-root", "{projectRoot}"],
  workingDirectory: ".",
  timeoutMs: 1_200_000,
  resultAdapter: "scheduled-digest-json-v1",
  allowedArtifactRoot: "output",
  notify: "always",
} as const;

function writeConfig(value: unknown): string {
  return writeRawConfig(stringify(value));
}

function writeRawConfig(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "wechatpilot-observer-config-"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "observer-jobs.yaml"), contents, "utf8");
  writeRuntimeManifest(root);
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadObserverConfig", () => {
  it("loads the single audited observer job from the real configuration", () => {
    const config = loadObserverConfig(projectRoot, fakeRuntime());

    expect(config.version).toBe(1);
    expect(config.jobs).toHaveLength(1);
    expect(config.jobs[0]).toMatchObject({
      id: "daily-tech-digest",
      entrypoint: "dist/src/cli/scheduled.js",
      resultAdapter: "scheduled-digest-json-v1",
    });
  });

  it("rejects an absolute entrypoint", () => {
    const root = writeConfig({
      version: 1,
      jobs: [{ ...validJob, entrypoint: "/tmp/evil.js" }],
    });

    expect(() => loadObserverConfig(root)).toThrow();
  });

  it("rejects a parent-directory traversal entrypoint", () => {
    const root = writeConfig({
      version: 1,
      jobs: [{ ...validJob, entrypoint: "../evil.js" }],
    });

    expect(() => loadObserverConfig(root)).toThrow();
  });

  it("rejects a second v1 job", () => {
    const root = writeConfig({
      version: 1,
      jobs: [validJob, validJob],
    });

    expect(() => loadObserverConfig(root)).toThrow();
  });

  it("rejects command overrides and every undeclared field", () => {
    const commandOverrideRoot = writeConfig({
      version: 1,
      jobs: [{ ...validJob, command: "arbitrary-command" }],
    });
    const topLevelOverrideRoot = writeConfig({
      version: 1,
      jobs: [validJob],
      command: "arbitrary-command",
    });

    expect(() => loadObserverConfig(commandOverrideRoot)).toThrow();
    expect(() => loadObserverConfig(topLevelOverrideRoot)).toThrow();
  });

  it("accepts timeout boundaries and rejects values outside them", () => {
    for (const timeoutMs of [1_000, 1_800_000]) {
      const root = writeConfig({ version: 1, jobs: [{ ...validJob, timeoutMs }] });
      expect(loadObserverConfig(root).jobs[0].timeoutMs).toBe(timeoutMs);
    }

    for (const timeoutMs of [999, 1_800_001]) {
      const root = writeConfig({ version: 1, jobs: [{ ...validJob, timeoutMs }] });
      expect(() => loadObserverConfig(root)).toThrow();
    }
  });

  it("throws only a stable public error without preserving raw parser details", () => {
    const privateMarker = ["PRIVATE", "CONFIG", "SENTINEL"].join("_");
    const root = writeRawConfig(
      `version: 1\njobs:\n  - name: [${privateMarker}\n`,
    );

    let thrown: unknown;
    try {
      loadObserverConfig(root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toBe("Invalid observer configuration");
    expect("cause" in error).toBe(false);

    const visibleProperties = Object.fromEntries(
      Object.getOwnPropertyNames(error).map((name) => [
        name,
        String((error as unknown as Record<string, unknown>)[name]),
      ]),
    );
    const serialized = JSON.stringify(visibleProperties);
    expect(serialized.includes(privateMarker)).toBe(false);
    expect(serialized.includes(root)).toBe(false);
    expect(serialized.includes("/Users/")).toBe(false);
    expect(serialized.includes("/var/folders/")).toBe(false);
  });
});

describe("findObserverJob", () => {
  it("returns the audited job by id", () => {
    const config = loadObserverConfig(projectRoot, fakeRuntime());

    expect(findObserverJob(config, "daily-tech-digest")).toBe(config.jobs[0]);
  });

  it("throws a fixed message without echoing an unknown id", () => {
    const config = loadObserverConfig(projectRoot, fakeRuntime());

    expect(() => findObserverJob(config, "private-user-input")).toThrow(
      /^Unknown observer job$/u,
    );
  });
});
