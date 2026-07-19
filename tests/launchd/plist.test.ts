import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());
const plistPath = resolve(
  projectRoot,
  "launchd",
  "com.kdnsna.daily-tech-digest.plist",
);

describe("LaunchAgent template", () => {
  it("uses detected absolute paths and a daily 08:00 local calendar trigger", () => {
    expect(existsSync(plistPath)).toBe(true);
    if (!existsSync(plistPath)) {
      return;
    }
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>/opt/homebrew/opt/node@22/bin/node</string>");
    expect(plist).toContain(
      "<string>/Users/kdnsna/Documents/微信 chat/dist/src/cli/scheduled.js</string>",
    );
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>/u);
    expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>0<\/integer>/u);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/u);
    expect(plist).toContain(
      "<string>/Users/kdnsna/Documents/微信 chat/logs/launchd.stdout.log</string>",
    );
    expect(plist).toContain(
      "<string>/Users/kdnsna/Documents/微信 chat/logs/launchd.stderr.log</string>",
    );
    expect(plist).not.toContain("<key>KeepAlive</key>");
    expect(plist).not.toMatch(/dangerously-bypass|danger-full-access|--yolo/u);
    expect(plist).not.toContain("${");
    expect(plist).not.toContain("~/");
  });
});
