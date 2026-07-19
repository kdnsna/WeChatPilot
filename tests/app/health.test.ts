import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPECTED_VENDOR_HEAD,
  healthExitCode,
  inspectProjectHealth,
  type HealthProbes,
  type ProjectHealthReport,
} from "../../src/app/health.js";
import { runHealthCli } from "../../src/cli/health.js";
import type { ObserverConfig } from "../../src/observer/config.js";

const roots: string[] = [];
const NODE_EXECUTABLE = "/approved/node-22";
const CODEX_ENTRYPOINT = "/approved/codex.js";

const OBSERVER_CONFIG: ObserverConfig = {
  version: 1,
  jobs: [
    {
      id: "daily-tech-digest",
      name: "每日科技情报",
      projectLabel: "WeChatPilot",
      executable: "/opt/homebrew/opt/node@22/bin/node",
      entrypoint: "dist/src/cli/scheduled.js",
      arguments: ["--project-root", "{projectRoot}"],
      workingDirectory: ".",
      timeoutMs: 1_000,
      resultAdapter: "scheduled-digest-json-v1",
      allowedArtifactRoot: "output",
      notify: "always",
    },
  ],
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "digest-health-"));
  roots.push(root);
  return root;
}

function healthyProbes(
  overrides: Partial<HealthProbes> = {},
): HealthProbes {
  return {
    runtimeVersion: () => "22.23.1",
    loadConfig: () => ({
      digest: {
        codex: {
          nodeExecutable: NODE_EXECUTABLE,
          javascriptEntrypoint: CODEX_ENTRYPOINT,
        },
      },
    }),
    readProjectText: (_root, path) =>
      path.endsWith("digest-output.schema.json") ? "{}" : "safe prompt",
    fileReadable: () => true,
    fileExecutable: () => true,
    directoryWritable: () => true,
    execFile: (executable, arguments_) =>
      executable === "/usr/bin/git" && arguments_[0] === "rev-parse"
        ? EXPECTED_VENDOR_HEAD
        : "v22.23.1",
    verifyVendorArtifacts: () => true,
    wechatHealth: () => ({
      credentialsReady: false,
      ownerBound: false,
      contextReady: false,
    }),
    loadObserverConfig: () => OBSERVER_CONFIG,
    rendererReady: () => true,
    inspectRunState: () => ({ recoveryPending: 0, invalidRecords: 0 }),
    listFinalRunReports: () => [],
    inspectRunDeliveryState: () => ({
      pending: 0,
      indeterminate: 0,
      invalid: 0,
    }),
    runDeliveryDisposition: () => "sent",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("project health", () => {
  it("reports healthy required checks and pre-QR WeChat as pending without exposing paths", () => {
    const root = project();
    const readPaths: string[] = [];
    const readablePaths: string[] = [];
    const executablePaths: string[] = [];
    const writablePaths: string[] = [];
    const execCalls: Array<{
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly cwd?: string;
    }> = [];
    const probes = healthyProbes({
      readProjectText: (_projectRoot, path) => {
        readPaths.push(path);
        return path.endsWith("digest-output.schema.json") ? "{}" : "safe prompt";
      },
      fileReadable: (path) => {
        readablePaths.push(path);
        return true;
      },
      fileExecutable: (path) => {
        executablePaths.push(path);
        return true;
      },
      directoryWritable: (path) => {
        writablePaths.push(path);
        return true;
      },
      execFile: (executable, arguments_, options) => {
        execCalls.push({ executable, arguments: arguments_, cwd: options.cwd });
        return executable === "/usr/bin/git"
          ? EXPECTED_VENDOR_HEAD
          : "v22.23.1";
      },
    });

    const report = inspectProjectHealth({ projectRoot: root, probes });

    expect(report).toEqual({
      status: "pending",
      requiredReady: true,
      runtime: { status: "ok", node22: true },
      config: {
        status: "ok",
        configValid: true,
        promptReady: true,
        outputSchemaReady: true,
      },
      vendor: {
        status: "ok",
        exactHead: true,
        artifactIntegrity: true,
        authModuleReady: true,
        httpModuleReady: true,
        cryptoModuleReady: true,
      },
      directories: {
        status: "ok",
        dataWritable: true,
        outputWritable: true,
        logsWritable: true,
      },
      codex: {
        status: "ok",
        nodeExecutableReady: true,
        nodeVersion22: true,
        javascriptEntrypointReady: true,
      },
      wechat: {
        status: "pending",
        credentialsReady: false,
        ownerBound: false,
        contextReady: false,
      },
      observer: {
        status: "ok",
        configValid: true,
        rendererReady: true,
        pendingRecoveryReports: 0,
        pendingDeliveries: 0,
        indeterminateDeliveries: 0,
        invalidStateRecords: 0,
      },
      diagnostics: [],
    });
    expect(healthExitCode(report)).toBe(0);
    expect(readPaths.every((path) => path.startsWith(`${root}/`))).toBe(true);
    expect(writablePaths).toEqual([
      join(root, "data"),
      join(root, "output"),
      join(root, "logs"),
    ]);
    expect(executablePaths).toEqual([NODE_EXECUTABLE]);
    expect(readablePaths).toEqual(
      expect.arrayContaining([
        CODEX_ENTRYPOINT,
        join(root, "vendor", "cli-in-wechat", "dist", "ilink", "auth.js"),
        join(root, "vendor", "cli-in-wechat", "dist", "utils", "http.js"),
        join(root, "vendor", "cli-in-wechat", "dist", "utils", "crypto.js"),
      ]),
    );
    expect(
      readablePaths.every(
        (path) => path.startsWith(`${root}/`) || path === CODEX_ENTRYPOINT,
      ),
    ).toBe(true);
    expect(execCalls).toEqual(
      expect.arrayContaining([
        {
          executable: "/usr/bin/git",
          arguments: ["rev-parse", "HEAD"],
          cwd: join(root, "vendor", "cli-in-wechat"),
        },
        {
          executable: NODE_EXECUTABLE,
          arguments: ["--version"],
          cwd: root,
        },
      ]),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(NODE_EXECUTABLE);
    expect(serialized).not.toContain(CODEX_ENTRYPOINT);
  });

  it("returns failed for required checks and a nonzero CLI exit code", () => {
    const root = project();
    const report = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes({
        runtimeVersion: () => "20.19.0",
        directoryWritable: (path) => !path.endsWith("/logs"),
        fileExecutable: () => false,
        execFile: (executable) =>
          executable === "/usr/bin/git" ? "wrong-head" : "v20.19.0",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.requiredReady).toBe(false);
    expect(report.runtime).toEqual({ status: "failed", node22: false });
    expect(report.vendor).toMatchObject({ status: "failed", exactHead: false });
    expect(report.directories).toMatchObject({
      status: "failed",
      logsWritable: false,
    });
    expect(report.codex).toMatchObject({
      status: "failed",
      nodeExecutableReady: false,
      nodeVersion22: false,
    });
    expect(healthExitCode(report)).toBe(1);
  });

  it("uses only wechatHealth booleans and sanitizes probe errors", () => {
    const root = project();
    const fakeToken = `ghp_${"s".repeat(36)}`;
    const report = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes({
        loadConfig: () => {
          throw Object.assign(new Error(`token=${fakeToken}`), {
            userId: "must-not-leak-user-id",
          });
        },
        wechatHealth: () => {
          throw new Error(`context_token=${fakeToken}`);
        },
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.config.configValid).toBe(false);
    expect(report.codex.status).toBe("failed");
    expect(report.wechat).toEqual({
      status: "failed",
      credentialsReady: false,
      ownerBound: false,
      contextReady: false,
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        "configuration check failed",
        "Codex path check unavailable",
        "WeChat readiness check failed",
      ]),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toContain("must-not-leak-user-id");
  });

  it("keeps partially initialized WeChat pending rather than a required failure", () => {
    const root = project();
    const report = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes({
        wechatHealth: () => ({
          credentialsReady: true,
          ownerBound: true,
          contextReady: false,
        }),
      }),
    });

    expect(report.status).toBe("pending");
    expect(report.requiredReady).toBe(true);
    expect(report.wechat.status).toBe("pending");
    expect(healthExitCode(report)).toBe(0);
  });

  it("reports only safe observer counts and marks pending work for operator review", () => {
    const root = project();
    const secretRunId = "019c7714-3b77-74d1-9866-e1f484aae2ab";
    const report = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes({
        wechatHealth: () => ({
          credentialsReady: true,
          ownerBound: true,
          contextReady: true,
        }),
        inspectRunState: () => ({ recoveryPending: 2, invalidRecords: 0 }),
        listFinalRunReports: () => [
          {
            runId: secretRunId,
          } as never,
        ],
        inspectRunDeliveryState: (options) => {
          expect(options).not.toHaveProperty("reports");
          return { pending: 3, indeterminate: 4, invalid: 0 };
        },
      }),
    });

    expect(report.status).toBe("pending");
    expect(report.requiredReady).toBe(true);
    expect(report.observer).toEqual({
      status: "ok",
      configValid: true,
      rendererReady: true,
      pendingRecoveryReports: 2,
      pendingDeliveries: 3,
      indeterminateDeliveries: 4,
      invalidStateRecords: 0,
    });
    expect(report.diagnostics).toEqual([
      "observer recovery pending",
      "observer delivery pending",
      "observer delivery requires review",
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secretRunId);
    expect(serialized).not.toContain(root);
    expect(healthExitCode(report)).toBe(0);
  });

  it("scans orphan ledgers and adds only missing final-report deliveries", () => {
    const root = project();
    const missingRunId = "018f514c-1a2b-7abc-8def-1234567890ac";
    const retryableRunId = "018f514c-1a2b-7abc-8def-1234567890ad";
    const indeterminateRunId = "018f514c-1a2b-7abc-8def-1234567890ae";
    const reports = [missingRunId, retryableRunId, indeterminateRunId].map(
      (runId) => ({ runId }) as never,
    );
    const inspectRunDeliveryState = vi.fn((options: { reports?: unknown }) => {
      expect(options).not.toHaveProperty("reports");
      // All ledgers: one orphan and one final retryable, one orphan and one
      // final indeterminate, plus one orphan invalid ledger.
      return { pending: 2, indeterminate: 2, invalid: 1 };
    });
    const runDeliveryDisposition = vi.fn(({ report }: { report: { runId: string } }) =>
      report.runId === missingRunId
        ? "missing" as const
        : report.runId === retryableRunId
          ? "retryable" as const
          : "indeterminate" as const,
    );

    const report = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes({
        wechatHealth: () => ({
          credentialsReady: true,
          ownerBound: true,
          contextReady: true,
        }),
        listFinalRunReports: () => reports,
        inspectRunDeliveryState,
        runDeliveryDisposition,
      }),
    });

    expect(inspectRunDeliveryState).toHaveBeenCalledOnce();
    expect(runDeliveryDisposition).toHaveBeenCalledTimes(3);
    expect(report.observer).toMatchObject({
      pendingDeliveries: 3,
      indeterminateDeliveries: 2,
      invalidStateRecords: 1,
    });
    expect(JSON.stringify(report)).not.toContain(missingRunId);
    expect(JSON.stringify(report)).not.toContain(retryableRunId);
    expect(JSON.stringify(report)).not.toContain(indeterminateRunId);
  });

  it.each([
    {
      name: "missing observer configuration",
      override: {
        loadObserverConfig: () => {
          throw new Error("missing /private/config/observer-jobs.yaml");
        },
      },
      expected: { configValid: false, rendererReady: true, invalidStateRecords: 0 },
    },
    {
      name: "unavailable report renderer",
      override: { rendererReady: () => false },
      expected: { configValid: true, rendererReady: false, invalidStateRecords: 0 },
    },
    {
      name: "invalid observer state records",
      override: {
        inspectRunState: () => ({ recoveryPending: 0, invalidRecords: 2 }),
        inspectRunDeliveryState: () => ({ pending: 0, indeterminate: 0, invalid: 3 }),
      },
      expected: { configValid: true, rendererReady: true, invalidStateRecords: 5 },
    },
  ])("fails required readiness for $name", ({ override, expected }) => {
    const report = inspectProjectHealth({
      projectRoot: project(),
      probes: healthyProbes({
        wechatHealth: () => ({
          credentialsReady: true,
          ownerBound: true,
          contextReady: true,
        }),
        ...override,
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.requiredReady).toBe(false);
    expect(report.observer).toMatchObject({ status: "failed", ...expected });
    expect(healthExitCode(report)).toBe(1);
  });

  it("writes pending health to stdout and required failures to stderr", () => {
    const root = project();
    const pending = inspectProjectHealth({
      projectRoot: root,
      probes: healthyProbes(),
    });
    const failed: ProjectHealthReport = {
      ...pending,
      status: "failed",
      requiredReady: false,
    };
    const pendingOutput: string[] = [];
    const pendingErrors: string[] = [];
    const failedOutput: string[] = [];
    const failedErrors: string[] = [];

    expect(
      runHealthCli(
        ["--project-root", root],
        {
          stdout: (value) => pendingOutput.push(value),
          stderr: (value) => pendingErrors.push(value),
        },
        { inspect: () => pending },
      ),
    ).toBe(0);
    expect(pendingOutput.join("")).toContain('"status":"pending"');
    expect(pendingErrors).toEqual([]);

    expect(
      runHealthCli(
        ["--project-root", root],
        {
          stdout: (value) => failedOutput.push(value),
          stderr: (value) => failedErrors.push(value),
        },
        { inspect: () => failed },
      ),
    ).toBe(1);
    expect(failedOutput).toEqual([]);
    expect(failedErrors.join("")).toContain('"status":"failed"');
  });
});
