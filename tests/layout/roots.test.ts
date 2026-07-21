import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  applicationSupportProfileRoot,
  defaultLayoutRoots,
  resolveLayoutRoots,
} from "../../src/layout/roots.js";

describe("layout roots", () => {
  it("defaults workspace and state under the project for compatibility", () => {
    const roots = defaultLayoutRoots("/tmp/wechatpilot-app");
    expect(roots.appRoot).toBe("/tmp/wechatpilot-app");
    expect(roots.workspaceRoot).toBe("/tmp/wechatpilot-app");
    expect(roots.stateRoot).toBe("/tmp/wechatpilot-app/.state");
  });

  it("supports an explicit profile root with Application Support default helper", () => {
    const profile = "/tmp/wechatpilot-profile";
    const roots = resolveLayoutRoots({
      projectRoot: "/tmp/wechatpilot-app",
      profileRoot: profile,
    });
    expect(roots.workspaceRoot).toBe(join(profile, "workspace"));
    expect(roots.stateRoot).toBe(join(profile, "state"));
    expect(applicationSupportProfileRoot()).toContain("Application Support/WeChatPilot");
  });
});
