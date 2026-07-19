import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runSendRunReportTestCli } from "../../src/cli/send-run-report-test.js";

const projectRoot = resolve(process.cwd());

describe("LaunchAgent lifecycle scripts", () => {
  it("routes the scheduled script through the fixed observer job without remote control", () => {
    const path = resolve(projectRoot, "scripts", "run-scheduled.sh");
    const script = readFileSync(path, "utf8");
    expect(script).toContain(
      'PROJECT_ROOT="/Users/kdnsna/Documents/微信 chat"',
    );
    expect(script).not.toContain("SCRIPT_DIR=");
    expect(script).toContain('NODE22="/opt/homebrew/opt/node@22/bin/node"');
    expect(script).toContain('"${PROJECT_ROOT}/dist/src/cli/observer.js"');
    expect(script).toContain('--job "daily-tech-digest"');
    expect(script).not.toContain("scheduled.js");
    expect(script).not.toMatch(
      /bridge|router|approve|deny|\bshell\b|--command|--recipient|--cwd|--yolo|--add-dir|danger-full-access|dangerously-bypass/iu,
    );
  });

  it("provides an explicit fixed test-card script using the local project root", () => {
    const path = resolve(projectRoot, "scripts", "send-run-report-test.sh");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) {
      return;
    }
    expect(statSync(path).mode & 0o111).not.toBe(0);
    const script = readFileSync(path, "utf8");
    expect(script).toContain('SCRIPT_DIR="$(cd "$(/usr/bin/dirname');
    expect(script).toContain('PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.."');
    expect(script).toContain('NODE22="/opt/homebrew/opt/node@22/bin/node"');
    expect(script).toContain("--import tsx");
    expect(script).toContain("src/cli/send-run-report-test.ts");
    expect(script).not.toMatch(
      /--user|--recipient|--command|--attachment|--status|--message|--path|--add-dir|--yolo|danger-full-access|dangerously-bypass/iu,
    );
  });

  it.each([
    ["--recipient", "owner"],
    ["--user", "owner"],
    ["--command", "id"],
    ["--attachment", "/private/tmp/file"],
    ["--status", "failed"],
    ["--message", "override"],
    ["--path", "/private/tmp/card.png"],
    ["--project-root", "relative"],
    ["--project-root", projectRoot, "--extra"],
  ])("rejects fixed test-card CLI arguments: %s", async (...arguments_) => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const send = vi.fn(async () => ({
      status: "sent" as const,
      textChunks: 1,
      image: "sent" as const,
      textAttempt: 1,
      imageAttempt: 1,
    }));

    await expect(
      runSendRunReportTestCli(arguments_, { stdout, stderr }, { send }),
    ).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      `${JSON.stringify({
        error: "SendRunReportTestUsageError",
        message: "inspect project logs",
      })}\n`,
    );
    expect(stderr.mock.calls.flat().join("")).not.toContain(
      arguments_.at(-1),
    );
  });

  it("requires explicit confirmation before loading", () => {
    const path = resolve(projectRoot, "scripts", "install-launchd.sh");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) {
      return;
    }
    const script = readFileSync(path, "utf8");
    expect(script).toContain("--confirm-load");
    expect(script).toContain("/bin/launchctl bootstrap");
    expect(script).toContain(
      "/Users/kdnsna/Library/LaunchAgents/com.kdnsna.daily-tech-digest.plist",
    );
    expect(script).not.toContain("sudo");
  });

  it("unloads and removes only the exact installed plist", () => {
    const path = resolve(projectRoot, "scripts", "uninstall-launchd.sh");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) {
      return;
    }
    const script = readFileSync(path, "utf8");
    expect(script).toContain("/bin/launchctl bootout");
    expect(script).toContain(
      "/Users/kdnsna/Library/LaunchAgents/com.kdnsna.daily-tech-digest.plist",
    );
    expect(script).not.toContain("sudo");
    expect(script).not.toMatch(/rm\s+-r/u);
  });
});
