import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

describe("LaunchAgent lifecycle scripts", () => {
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
