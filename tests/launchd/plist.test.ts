import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LaunchAgent template", () => {
  it("contains placeholders only and is generated per user at install time", () => {
    const template = readFileSync(
      resolve(process.cwd(), "launchd", "io.wechatpilot.daily-tech-digest.plist.template"),
      "utf8",
    );
    expect(template).toContain("io.wechatpilot.daily-tech-digest");
    expect(template).toContain("{{NODE_EXECUTABLE}}");
    expect(template).toContain("{{PROJECT_ROOT}}");
    expect(template).toContain("{{LOG_DIRECTORY}}");
    expect(template).not.toMatch(/\/Users\/|\/opt\/homebrew|kdnsna/iu);
    expect(template).not.toMatch(/bridge|router|approve|deny|\bshell\b|--command|--recipient|--cwd|--yolo|--add-dir|danger-full-access|dangerously-bypass/iu);
  });
});
