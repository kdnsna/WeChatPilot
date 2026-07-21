import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { loadConfig } from "../config/load.js";
import {
  inspectRunDeliveryState,
} from "../delivery/run-report-delivery.js";
import {
  wechatHealth,
} from "../delivery/wechat.js";
import { WECHAT_TRANSPORT_RUNTIME_CLOSURE } from "../transport/wechat-transport.js";
import { readProjectText } from "../lib/project-file.js";
import {
  assertNoSymlinkComponents,
  createProjectPaths,
  resolveProjectPath,
} from "../lib/paths.js";
import {
  loadObserverConfig,
  type ObserverConfig,
} from "../observer/config.js";
import {
  loadEditorialConfig,
  type EditorialConfig,
} from "../observer/editorial-config.js";
import { reportImageCapabilityReady } from "../observer/report-image-capability.js";
import { inspectReportSequence } from "../observer/report-sequence.js";
import { inspectReportVisuals } from "../observer/report-visual-state.js";
import type { RunReport } from "../observer/run-report.js";
import {
  inspectRunState,
  listFinalRunReports,
} from "../observer/run-state.js";

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
  readonly loadObserverConfig: (projectRoot: string) => ObserverConfig;
  readonly rendererReady: () => boolean;
  readonly loadEditorialConfig: (projectRoot: string) => EditorialConfig;
  readonly imageCapabilityReady: (options: {
    readonly projectRoot: string;
    readonly config: EditorialConfig;
  }) => boolean;
  readonly inspectReportSequence: (projectRoot: string) => boolean;
  readonly inspectReportVisuals: (projectRoot: string) => {
    readonly pending: number;
    readonly fallback: number;
    readonly invalid: number;
  };
  readonly inspectRunState: (projectRoot: string) => {
    readonly recoveryPending: number;
    readonly invalidRecords: number;
  };
  readonly listFinalRunReports: (projectRoot: string) => readonly RunReport[];
  readonly inspectRunDeliveryState: (options: {
    readonly projectRoot: string;
    readonly reports?: readonly RunReport[];
  }) => {
    readonly pending: number;
    readonly indeterminate: number;
    readonly invalid: number;
  };
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
  readonly transport: {
    readonly status: CheckStatus;
    readonly minimalClosure: boolean;
    readonly sourceReady: boolean;
    readonly qrModuleReady: boolean;
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
  readonly observer: {
    readonly status: CheckStatus;
    readonly configValid: boolean;
    readonly rendererReady: boolean;
    readonly imageConfigValid: boolean;
    readonly imageCapabilityReady: boolean;
    readonly sequenceLedgerValid: boolean;
    readonly pendingVisuals: number;
    readonly fallbackVisuals: number;
    readonly invalidVisualRecords: number;
    readonly pendingRecoveryReports: number;
    readonly pendingDeliveries: number;
    readonly indeterminateDeliveries: number;
    readonly invalidStateRecords: number;
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

function defaultRendererReady(): boolean {
  const require = createRequire(import.meta.url);
  const { Resvg } = require("@resvg/resvg-js") as {
    readonly Resvg: new (svg: string) => {
      readonly render: () => { readonly asPng: () => Buffer };
    };
  };
  const png = new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  )
    .render()
    .asPng();
  return (
    png.length >= 8 &&
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
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
  loadObserverConfig,
  rendererReady: defaultRendererReady,
  loadEditorialConfig,
  imageCapabilityReady: reportImageCapabilityReady,
  inspectReportSequence,
  inspectReportVisuals,
  inspectRunState,
  listFinalRunReports,
  inspectRunDeliveryState,
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

function safeCount(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

  const sourceReady = probes.fileReadable(
    safeLocalPath(paths.root, "src", "transport", "wechat-transport.ts"),
  );
  const minimalClosure =
    WECHAT_TRANSPORT_RUNTIME_CLOSURE.length === 2 &&
    !WECHAT_TRANSPORT_RUNTIME_CLOSURE.some((entry) => /undici|proxy|router|adapter/iu.test(entry));
  const qrModuleReady = safeProbe(() => {
    createRequire(import.meta.url).resolve("qrcode-terminal");
    return true;
  });
  const transportReady = sourceReady && minimalClosure && qrModuleReady;
  if (!transportReady) {
    diagnostics.push("WeChat transport boundary check failed");
  }
  const transport = {
    status: status(transportReady),
    minimalClosure,
    sourceReady,
    qrModuleReady,
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

  let observerConfigValid = false;
  try {
    probes.loadObserverConfig(paths.root);
    observerConfigValid = true;
  } catch {
    diagnostics.push("observer configuration check failed");
  }

  const rendererReady = safeProbe(probes.rendererReady);
  if (!rendererReady) {
    diagnostics.push("observer renderer check failed");
  }

  let imageConfig: EditorialConfig | undefined;
  let imageConfigValid = false;
  try {
    imageConfig = probes.loadEditorialConfig(paths.root);
    imageConfigValid = true;
  } catch {
    diagnostics.push("observer image configuration check failed");
  }

  const imageCapabilityReady =
    imageConfig !== undefined &&
    safeProbe(() =>
      probes.imageCapabilityReady({
        projectRoot: paths.root,
        config: imageConfig!,
      }),
    );
  if (!imageCapabilityReady) {
    diagnostics.push("observer image capability unavailable");
  }

  const sequenceLedgerValid = safeProbe(() =>
    probes.inspectReportSequence(paths.root),
  );
  if (!sequenceLedgerValid) {
    diagnostics.push("observer sequence state check failed");
  }

  let pendingVisuals = 0;
  let fallbackVisuals = 0;
  let invalidVisualRecords = 0;
  let visualStateValid = true;
  try {
    const visual = probes.inspectReportVisuals(paths.root);
    const pending = safeCount(visual.pending);
    const fallback = safeCount(visual.fallback);
    const invalid = safeCount(visual.invalid);
    if (pending === null || fallback === null || invalid === null) {
      visualStateValid = false;
      invalidVisualRecords = 1;
    } else {
      pendingVisuals = pending;
      fallbackVisuals = fallback;
      invalidVisualRecords = invalid;
    }
  } catch {
    visualStateValid = false;
    invalidVisualRecords = 1;
  }
  if (pendingVisuals > 0) {
    diagnostics.push("observer visual pending");
  }
  if (!visualStateValid || invalidVisualRecords > 0) {
    diagnostics.push("observer visual state check failed");
  }

  let pendingRecoveryReports = 0;
  let pendingDeliveries = 0;
  let indeterminateDeliveries = 0;
  let invalidStateRecords = 0;
  let observerStateValid = true;
  let runStateScanned = false;
  let reports: readonly RunReport[] = [];
  try {
    const state = probes.inspectRunState(paths.root);
    const recoveryPending = safeCount(state.recoveryPending);
    const invalidRecords = safeCount(state.invalidRecords);
    if (recoveryPending === null || invalidRecords === null) {
      observerStateValid = false;
      invalidStateRecords += 1;
    } else {
      pendingRecoveryReports = recoveryPending;
      invalidStateRecords += invalidRecords;
      runStateScanned = true;
    }
  } catch {
    observerStateValid = false;
    invalidStateRecords += 1;
  }
  if (runStateScanned) {
    try {
      reports = probes.listFinalRunReports(paths.root);
    } catch {
      observerStateValid = false;
      invalidStateRecords += 1;
    }
  }
  try {
    const delivery = probes.inspectRunDeliveryState({
      projectRoot: paths.root,
      reports,
    });
    const pending = safeCount(delivery.pending);
    const indeterminate = safeCount(delivery.indeterminate);
    const invalid = safeCount(delivery.invalid);
    if (pending === null || indeterminate === null || invalid === null) {
      observerStateValid = false;
      invalidStateRecords += 1;
    } else {
      pendingDeliveries = pending;
      indeterminateDeliveries = indeterminate;
      invalidStateRecords += invalid;
    }
  } catch {
    observerStateValid = false;
    invalidStateRecords += 1;
  }
  if (pendingRecoveryReports > 0) {
    diagnostics.push("observer recovery pending");
  }
  if (pendingDeliveries > 0) {
    diagnostics.push("observer delivery pending");
  }
  if (indeterminateDeliveries > 0) {
    diagnostics.push("observer delivery requires review");
  }
  if (!observerStateValid || invalidStateRecords > 0) {
    diagnostics.push("observer state check failed");
  }
  const observerReady =
    observerConfigValid &&
    rendererReady &&
    imageConfigValid &&
    imageCapabilityReady &&
    sequenceLedgerValid &&
    visualStateValid &&
    invalidVisualRecords === 0 &&
    observerStateValid &&
    invalidStateRecords === 0;
  const observer = {
    status: status(observerReady),
    configValid: observerConfigValid,
    rendererReady,
    imageConfigValid,
    imageCapabilityReady,
    sequenceLedgerValid,
    pendingVisuals,
    fallbackVisuals,
    invalidVisualRecords,
    pendingRecoveryReports,
    pendingDeliveries,
    indeterminateDeliveries,
    invalidStateRecords,
  } as const;
  const observerPending =
    pendingRecoveryReports > 0 ||
    pendingVisuals > 0 ||
    pendingDeliveries > 0 ||
    indeterminateDeliveries > 0;

  const requiredReady =
    runtime.status === "ok" &&
    config.status === "ok" &&
    transport.status === "ok" &&
    directories.status === "ok" &&
    codex.status === "ok" &&
    observer.status === "ok";
  const overallStatus: ProjectHealthStatus =
    !requiredReady || wechat.status === "failed"
      ? "failed"
      : wechat.status === "pending" || observerPending
        ? "pending"
        : "ready";

  return {
    status: overallStatus,
    requiredReady,
    runtime,
    config,
    transport,
    directories,
    codex,
    wechat,
    observer,
    diagnostics,
  };
}

export function healthExitCode(report: ProjectHealthReport): 0 | 1 {
  return report.status === "failed" ? 1 : 0;
}
