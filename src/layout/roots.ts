import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LayoutRoots {
  readonly appRoot: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(path);
}

export function defaultLayoutRoots(projectRoot: string): LayoutRoots {
  const appRoot = absolute(projectRoot, "appRoot");
  // Compatibility default: keep workspace and state under the project until
  // users migrate to an explicit profile root.
  return {
    appRoot,
    workspaceRoot: appRoot,
    stateRoot: join(appRoot, ".state"),
  };
}

export function resolveLayoutRoots(options: {
  readonly projectRoot?: string;
  readonly appRoot?: string;
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
  readonly profileRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): LayoutRoots {
  const environment = options.environment ?? process.env;
  const profile =
    options.profileRoot ??
    environment.WECHATPILOT_PROFILE_ROOT ??
    undefined;
  if (profile !== undefined) {
    const root = absolute(profile, "profileRoot");
    return {
      appRoot: absolute(options.appRoot ?? options.projectRoot ?? process.cwd(), "appRoot"),
      workspaceRoot: absolute(options.workspaceRoot ?? join(root, "workspace"), "workspaceRoot"),
      stateRoot: absolute(options.stateRoot ?? join(root, "state"), "stateRoot"),
    };
  }
  const project = absolute(
    options.projectRoot ?? options.appRoot ?? process.cwd(),
    "projectRoot",
  );
  const defaults = defaultLayoutRoots(project);
  const support = join(homedir(), "Library", "Application Support", "WeChatPilot");
  return {
    appRoot: absolute(options.appRoot ?? defaults.appRoot, "appRoot"),
    workspaceRoot: absolute(
      options.workspaceRoot ?? environment.WECHATPILOT_WORKSPACE_ROOT ?? defaults.workspaceRoot,
      "workspaceRoot",
    ),
    stateRoot: absolute(
      options.stateRoot ??
        environment.WECHATPILOT_STATE_ROOT ??
        defaults.stateRoot,
      "stateRoot",
    ),
    // Keep the macOS Application Support default discoverable for docs/tests.
    ...(support.length > 0 ? {} : {}),
  };
}

export function applicationSupportProfileRoot(): string {
  return join(homedir(), "Library", "Application Support", "WeChatPilot");
}
