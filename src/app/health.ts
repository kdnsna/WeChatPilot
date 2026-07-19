import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  statSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import { loadConfig } from "../config/load.js";
import {
  verifyVendorWechatArtifacts,
  wechatHealth,
} from "../delivery/wechat.js";
import { readProjectText } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  createProjectPaths,
  resolveProjectPath,
} from "../lib/paths.js";

export const EXPECTED_VENDOR_HEAD =
  "75d7db9338e133080fef9914b92ceb5e3ebd0dfc";

const MAX_LOCAL_TEXT_BYTES = 256 * 1_024;

type CheckStatus = "ok" | "failed";
export type ProjectHealthStatus = "ready" | "pending" | "failed";

interface HealthConfig {
  readonly digest: {
    readonly codex: {
      readonly nodeExecutable: string;
      readonly javascriptEntrypoint: string;
    };
  };
}

export interface WechatHealthBooleans {
  readonly credentialsReady: boolean;
  readonly ownerBound: boolean;
  readonly contextReady: boolean;
}

export interface HealthExecOptions {
  readonly cwd: string;
}

export interface HealthProbes {
  readonly runtimeVersion: () => string;
  readonly loadConfig: (projectRoot: string) => HealthConfig;
  readonly readProjectText: (
    projectRoot: string,
    path: string,
    maximumBytes: number,
  ) => string | null;
  readonly fileReadable: (path: string) => boolean;
  readonly fileExecutable: (path: string) => boolean;
  readonly directoryWritable: (path: string) => boolean;
  readonly execFile: (
    executable: string,
    arguments_: readonly string[],
    options: HealthExecOptions,
  ) => string;
  readonly wechatHealth: (projectRoot: string) => WechatHealthBooleans;
  readonly verifyVendorArtifacts: (projectRoot: string) => void;
}

export interface ProjectHealthReport {
  readonly status: ProjectHealthStatus;
  readonly requiredReady: boolean;
  readonly runtime: {
    readonly status: CheckStatus;
    readonly node22: boolean;
  };
  readonly config: {
    readonly status: CheckStatus;
    readonly configValid: boolean;
    readonly promptReady: boolean;
    readonly outputSchemaReady: boolean;
  };
  readonly vendor: {
    readonly status: CheckStatus;
    readonly exactHead: boolean;
    readonly artifactIntegrity: boolean;
    readonly authModuleReady: boolean;
    readonly httpModuleReady: boolean;
    readonly cryptoModuleReady: boolean;
  };
  readonly directories: {
    readonly status: CheckStatus;
    readonly dataWritable: boolean;
    readonly outputWritable: boolean;
    readonly logsWritable: boolean;
  };
  readonly codex: {
    readonly status: CheckStatus;
    readonly nodeExecutableReady: boolean;
    readonly nodeVersion22: boolean;
    readonly javascriptEntrypointReady: boolean;
  };
  readonly wechat: {
    readonly status: ProjectHealthStatus;
    readonly credentialsReady: boolean;
    readonly ownerBound: boolean;
    readonly contextReady: boolean;
  };
  readonly diagnostics: readonly string[];
}

export interface InspectProjectHealthOptions {
  readonly projectRoot: string;
  readonly probes?: HealthProbes;
}

function defaultFileReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultFileExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultDirectoryWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const defaultProbes: HealthProbes = {
  runtimeVersion: () => process.versions.node,
  loadConfig,
  readProjectText,
  fileReadable: defaultFileReadable,
  fileExecutable: defaultFileExecutable,
  directoryWritable: defaultDirectoryWritable,
  execFile: (executable, arguments_, options) =>
    execFileSync(executable, [...arguments_], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1_024,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
    }).trim(),
  wechatHealth,
  verifyVendorArtifacts: verifyVendorWechatArtifacts,
};

function status(value: boolean): CheckStatus {
  return value ? "ok" : "failed";
}

function isNode22(value: string): boolean {
  return /^v?22(?:\.|$)/u.test(value.trim());
}

function safeLocalPath(
  projectRoot: string,
  ...segments: readonly string[]
): string {
  const path = resolveProjectPath(projectRoot, ...segments);
  return assertNoSymlinkComponents(projectRoot, path);
}

function safeProbe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

function validJsonDocument(value: string | null): boolean {
  if (value === null || value.trim() === "") {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function inspectProjectHealth(
  options: InspectProjectHealthOptions,
): ProjectHealthReport {
  const probes = options.probes ?? defaultProbes;
  const paths = createProjectPaths(options.projectRoot);
  const diagnostics: string[] = [];

  const node22 = safeProbe(() => isNode22(probes.runtimeVersion()));
  if (!node22) {
    diagnostics.push("Node 22 runtime check failed");
  }
  const runtime = { status: status(node22), node22 } as const;

  let configValue: HealthConfig | undefined;
  let configValid = false;
  try {
    for (const filename of ["sources.yaml", "ranking.yaml", "digest.yaml"] as const) {
      safeLocalPath(paths.root, "config", filename);
    }
    configValue = probes.loadConfig(paths.root);
    configValid = true;
  } catch {
    diagnostics.push("configuration check failed");
  }

  const promptPath = safeLocalPath(paths.root, "prompts", "daily-digest.md");
  const promptReady = safeProbe(() => {
    const prompt = probes.readProjectText(
      paths.root,
      promptPath,
      MAX_LOCAL_TEXT_BYTES,
    );
    return prompt !== null && prompt.trim() !== "";
  });
  if (!promptReady) {
    diagnostics.push("digest prompt check failed");
  }

  const outputSchemaPath = safeLocalPath(
    paths.root,
    "config",
    "digest-output.schema.json",
  );
  const outputSchemaReady = safeProbe(() =>
    validJsonDocument(
      probes.readProjectText(
        paths.root,
        outputSchemaPath,
        MAX_LOCAL_TEXT_BYTES,
      ),
    ),
  );
  if (!outputSchemaReady) {
    diagnostics.push("digest output schema check failed");
  }
  const configReady = configValid && promptReady && outputSchemaReady;
  const config = {
    status: status(configReady),
    configValid,
    promptReady,
    outputSchemaReady,
  } as const;

  const vendorRoot = safeLocalPath(paths.root, "vendor", "cli-in-wechat");
  const exactHead = safeProbe(
    () =>
      probes.execFile("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: vendorRoot }).trim() ===
      EXPECTED_VENDOR_HEAD,
  );
  const artifactIntegrity = safeProbe(() => {
    probes.verifyVendorArtifacts(paths.root);
    return true;
  });
  const authModuleReady = safeProbe(() =>
    probes.fileReadable(
      safeLocalPath(
        paths.root,
        "vendor",
        "cli-in-wechat",
        "dist",
        "ilink",
        "auth.js",
      ),
    ),
  );
  const httpModuleReady = safeProbe(() =>
    probes.fileReadable(
      safeLocalPath(
        paths.root,
        "vendor",
        "cli-in-wechat",
        "dist",
        "utils",
        "http.js",
      ),
    ),
  );
  const cryptoModuleReady = safeProbe(() =>
    probes.fileReadable(
      safeLocalPath(
        paths.root,
        "vendor",
        "cli-in-wechat",
        "dist",
        "utils",
        "crypto.js",
      ),
    ),
  );
  const vendorReady =
    exactHead &&
    artifactIntegrity &&
    authModuleReady &&
    httpModuleReady &&
    cryptoModuleReady;
  if (!vendorReady) {
    diagnostics.push("vendor pin or build check failed");
  }
  const vendor = {
    status: status(vendorReady),
    exactHead,
    artifactIntegrity,
    authModuleReady,
    httpModuleReady,
    cryptoModuleReady,
  } as const;

  const dataWritable = safeProbe(() => {
    assertNoSymlinkComponents(paths.root, paths.data);
    return probes.directoryWritable(paths.data);
  });
  const outputWritable = safeProbe(() => {
    assertNoSymlinkComponents(paths.root, paths.output);
    return probes.directoryWritable(paths.output);
  });
  const logsWritable = safeProbe(() => {
    assertNoSymlinkComponents(paths.root, paths.logs);
    return probes.directoryWritable(paths.logs);
  });
  const directoriesReady = dataWritable && outputWritable && logsWritable;
  if (!directoriesReady) {
    diagnostics.push("project directory write check failed");
  }
  const directories = {
    status: status(directoriesReady),
    dataWritable,
    outputWritable,
    logsWritable,
  } as const;

  let nodeExecutableReady = false;
  let nodeVersion22 = false;
  let javascriptEntrypointReady = false;
  if (configValue === undefined) {
    diagnostics.push("Codex path check unavailable");
  } else {
    const { nodeExecutable, javascriptEntrypoint } = configValue.digest.codex;
    nodeExecutableReady =
      isAbsolute(nodeExecutable) &&
      safeProbe(() => probes.fileExecutable(nodeExecutable));
    nodeVersion22 =
      nodeExecutableReady &&
      safeProbe(() =>
        isNode22(
          probes.execFile(nodeExecutable, ["--version"], { cwd: paths.root }),
        ),
      );
    javascriptEntrypointReady =
      isAbsolute(javascriptEntrypoint) &&
      safeProbe(() => probes.fileReadable(javascriptEntrypoint));
  }
  const codexReady =
    nodeExecutableReady && nodeVersion22 && javascriptEntrypointReady;
  if (configValue !== undefined && !codexReady) {
    diagnostics.push("Codex configured path check failed");
  }
  const codex = {
    status: status(codexReady),
    nodeExecutableReady,
    nodeVersion22,
    javascriptEntrypointReady,
  } as const;

  let wechatStatus: ProjectHealthStatus = "pending";
  let credentialsReady = false;
  let ownerBound = false;
  let contextReady = false;
  try {
    const readiness = probes.wechatHealth(paths.root);
    credentialsReady = readiness.credentialsReady === true;
    ownerBound = readiness.ownerBound === true;
    contextReady = readiness.contextReady === true;
    if (credentialsReady && ownerBound && contextReady) {
      wechatStatus = "ready";
    }
  } catch {
    wechatStatus = "failed";
    diagnostics.push("WeChat readiness check failed");
  }
  const wechat = {
    status: wechatStatus,
    credentialsReady,
    ownerBound,
    contextReady,
  } as const;

  const requiredReady =
    runtime.status === "ok" &&
    config.status === "ok" &&
    vendor.status === "ok" &&
    directories.status === "ok" &&
    codex.status === "ok";
  const overallStatus: ProjectHealthStatus =
    !requiredReady || wechat.status === "failed"
      ? "failed"
      : wechat.status === "pending"
        ? "pending"
        : "ready";

  return {
    status: overallStatus,
    requiredReady,
    runtime,
    config,
    vendor,
    directories,
    codex,
    wechat,
    diagnostics,
  };
}

export function healthExitCode(report: ProjectHealthReport): 0 | 1 {
  return report.status === "failed" ? 1 : 0;
}
