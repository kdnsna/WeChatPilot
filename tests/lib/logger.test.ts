import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createJsonlLogger } from "../../src/lib/logger.js";

const temporaryRoots: string[] = [];

function temporaryLog(): { projectRoot: string; filePath: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "daily-tech-digest-logger-"));
  temporaryRoots.push(sandbox);
  const projectRoot = join(sandbox, "project");
  mkdirSync(projectRoot);
  return {
    projectRoot,
    filePath: join(projectRoot, "nested", "digest.jsonl"),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("JSONL logger", () => {
  it("appends structured records with an injected clock", async () => {
    const { projectRoot, filePath } = temporaryLog();
    const logger = createJsonlLogger({
      projectRoot,
      filePath,
      now: () => new Date("2026-07-18T12:00:00.000Z"),
    });

    await logger.info("collection started", { sourceId: "hacker-news" });
    await logger.warn("collection stale", { ageHours: 25 });

    const lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        timestamp: "2026-07-18T12:00:00.000Z",
        level: "info",
        message: "collection started",
        context: { sourceId: "hacker-news" },
      },
      {
        timestamp: "2026-07-18T12:00:00.000Z",
        level: "warn",
        message: "collection stale",
        context: { ageHours: 25 },
      },
    ]);
  });

  it("redacts Error, Headers, Buffer, and embedded secrets before persistence", async () => {
    const { projectRoot, filePath } = temporaryLog();
    const bearerToken = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const error = Object.assign(
      new Error(`request failed: Authorization: Bearer ${bearerToken}`),
      {
        statusCode: 401,
        contextToken: "error-context-secret",
      },
    );
    const headers = new Headers({
      Authorization: "Bearer header-secret-value",
      "X-Request-Id": "request-123",
    });
    const logger = createJsonlLogger({ projectRoot, filePath });

    await logger.error("token=message-secret", {
      error,
      headers,
      bytes: Buffer.from("buffer-secret-value"),
      password: "context-password-secret",
    });

    const persisted = readFileSync(filePath, "utf8");
    expect(persisted).not.toContain(bearerToken);
    expect(persisted).not.toContain("message-secret");
    expect(persisted).not.toContain("error-context-secret");
    expect(persisted).not.toContain("header-secret-value");
    expect(persisted).not.toContain("buffer-secret-value");
    expect(persisted).not.toContain("context-password-secret");
    expect(JSON.parse(persisted)).toMatchObject({
      level: "error",
      message: "token=[REDACTED]",
      context: {
        error: {
          name: "Error",
          message: "request failed: Authorization: Bearer [REDACTED]",
          statusCode: 401,
          contextToken: "[REDACTED]",
        },
        headers: {
          authorization: "[REDACTED]",
          "x-request-id": "request-123",
        },
        bytes: "[REDACTED]",
        password: "[REDACTED]",
      },
    });
  });

  it("creates the parent directory and log file with restrictive modes", async () => {
    const { projectRoot, filePath } = temporaryLog();
    const logger = createJsonlLogger({ projectRoot, filePath });

    await logger.debug("mode check");

    expect(statSync(join(filePath, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects a parent-directory symlink escape without creating an outside log", async () => {
    const { projectRoot } = temporaryLog();
    const outside = join(projectRoot, "..", "outside-parent");
    mkdirSync(outside);
    symlinkSync(outside, join(projectRoot, "linked-logs"));
    const outsideLog = join(outside, "digest.jsonl");
    const logger = createJsonlLogger({
      projectRoot,
      filePath: join(projectRoot, "linked-logs", "digest.jsonl"),
    });

    await expect(logger.info("must stay local")).rejects.toThrow(/safely|project|symlink/i);
    expect(existsSync(outsideLog)).toBe(false);
  });

  it("rejects a final log-file symlink without changing its outside target", async () => {
    const { projectRoot } = temporaryLog();
    const logs = join(projectRoot, "logs");
    const outside = join(projectRoot, "..", "outside-final");
    mkdirSync(logs);
    mkdirSync(outside);
    const outsideTarget = join(outside, "target.jsonl");
    writeFileSync(outsideTarget, "sentinel\n", { mode: 0o600 });
    const linkedLog = join(logs, "digest.jsonl");
    symlinkSync(outsideTarget, linkedLog);
    const logger = createJsonlLogger({ projectRoot, filePath: linkedLog });

    await expect(logger.error("must not follow")).rejects.toThrow(/safely|project|symlink/i);
    expect(readFileSync(outsideTarget, "utf8")).toBe("sentinel\n");
  });
});
