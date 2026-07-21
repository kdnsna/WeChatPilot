import { join } from "node:path";

import {
  deliverRunReport,
  recordRunReportNotificationDisposition,
  runDeliveryDisposition,
  type DeliverRunReportOptions,
  type DeliverRunReportResult,
  type RunDeliveryDisposition,
} from "../delivery/run-report-delivery.js";
import {
  enqueueRunReportOutbox,
  processRunReportOutbox,
} from "../delivery/outbox.js";
import {
  prepareWechatImageSender,
  prepareWechatTextSender,
  type PreparedWechatImageSender,
  type PreparedWechatTextSender,
} from "../delivery/wechat.js";
import {
  createJsonlLogger,
  type JsonlLogger,
  type JsonlLoggerOptions,
} from "../lib/logger.js";
import {
  findObserverJob,
  loadObserverConfig,
  type ObserverConfig,
  type ObserverJob,
} from "../observer/config.js";
import {
  runManagedJob,
  type ManagedJobDependencies,
  type ManagedJobOutcome,
  type RunManagedJobOptions,
} from "../observer/managed-job.js";
import {
  renderEditorialReportCard,
  type EditorialCardArtifact,
} from "../observer/editorial-card.js";
import {
  loadEditorialConfig,
  type EditorialConfig,
} from "../observer/editorial-config.js";
import {
  renderReportCard,
  type ReportCardArtifact,
} from "../observer/report-card.js";
import {
  prepareReportVisual,
  type PreparedReportVisual,
} from "../observer/report-visual.js";
import {
  assignReportIssue,
  type ReportIssue,
} from "../observer/report-sequence.js";
import {
  attachIssue,
  buildRunReport,
  type BuildRunReportOptions,
  type RunAuthority,
  type RunReport,
  type RunReportDraft,
} from "../observer/run-report.js";
import {
  finishRunRecord,
  listFinalRunReports,
  recoverInterruptedRuns,
  replaceFinalRunReport,
  type RecoverInterruptedRunsOptions,
  type RecoverInterruptedRunsResult,
} from "../observer/run-state.js";
import {
  acquireObserverTaskLock,
  ObserverTaskBusyError,
  type AcquireObserverTaskLockOptions,
  type ObserverTaskLock,
} from "../observer/task-lock.js";
import { buildStatusEditorialReport } from "../report/editorial.js";
import { shanghaiDateKey } from "../lib/time.js";

const RECOVERY_SUMMARY = "任务因主机或进程中断，已在恢复后补记";
const RENDER_FAILURE_CODE = "OBSERVER_REPORT_RENDER_FAILED";
const SAFE_RENDER_ERROR = "Unable to prepare observer report image";
const OUTBOX_HISTORY_LIMIT = 3;

interface PrepareObserverSenderOptions {
  readonly projectRoot: string;
  readonly report: RunReport;
  readonly signal?: AbortSignal;
}

export interface ObserverDependencies {
  readonly loadConfig?: (projectRoot: string) => ObserverConfig;
  readonly recover?: (
    options: RecoverInterruptedRunsOptions,
  ) => RecoverInterruptedRunsResult;
  readonly listFinalReports?: (projectRoot: string) => readonly RunReport[];
  readonly deliveryDisposition?: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => RunDeliveryDisposition;
  readonly recordNotificationDisposition?: typeof recordRunReportNotificationDisposition;
  readonly acquireTaskLock?: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
  readonly runJob?: (options: RunManagedJobOptions) => Promise<ManagedJobOutcome>;
  readonly normalize?: (options: BuildRunReportOptions) => RunReport;
  readonly finishRecord?: (projectRoot: string, report: RunReport) => void;
  readonly loadEditorial?: typeof loadEditorialConfig;
  readonly assignIssue?: typeof assignReportIssue;
  readonly attachIssue?: typeof attachIssue;
  readonly replaceFinalRecord?: typeof replaceFinalRunReport;
  readonly prepareVisual?: typeof prepareReportVisual;
  readonly renderEditorial?: typeof renderEditorialReportCard;
  readonly render?: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => ReportCardArtifact;
  readonly prepareText?: (
    options: PrepareObserverSenderOptions,
  ) => Promise<PreparedWechatTextSender>;
  readonly prepareImage?: (
    options: PrepareObserverSenderOptions,
  ) => Promise<PreparedWechatImageSender>;
  readonly deliver?: (
    options: DeliverRunReportOptions,
  ) => Promise<DeliverRunReportResult>;
  readonly enqueueOutbox?: typeof enqueueRunReportOutbox;
  readonly processOutbox?: typeof processRunReportOutbox;
  readonly createLogger?: (options: JsonlLoggerOptions) => JsonlLogger;
}

export interface RunObserverJobOptions {
  readonly projectRoot: string;
  readonly jobId: "daily-tech-digest";
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly managedJobDependencies?: Omit<
    ManagedJobDependencies,
    "acquireTaskLock"
  >;
  readonly dependencies?: ObserverDependencies;
}

interface ResolvedObserverDependencies {
  readonly loadConfig: (projectRoot: string) => ObserverConfig;
  readonly recover: (
    options: RecoverInterruptedRunsOptions,
  ) => RecoverInterruptedRunsResult;
  readonly listFinalReports: (projectRoot: string) => readonly RunReport[];
  readonly deliveryDisposition: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => RunDeliveryDisposition;
  readonly recordNotificationDisposition: typeof recordRunReportNotificationDisposition;
  readonly acquireTaskLock: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
  readonly runJob: (options: RunManagedJobOptions) => Promise<ManagedJobOutcome>;
  readonly normalize: (options: BuildRunReportOptions) => RunReport;
  readonly finishRecord: (projectRoot: string, report: RunReport) => void;
  readonly loadEditorial: (projectRoot: string) => EditorialConfig;
  readonly assignIssue: (options: {
    readonly projectRoot: string;
    readonly runId: string;
  }) => Promise<ReportIssue>;
  readonly attachIssue: typeof attachIssue;
  readonly replaceFinalRecord: typeof replaceFinalRunReport;
  readonly prepareVisual: typeof prepareReportVisual;
  readonly renderEditorial: typeof renderEditorialReportCard;
  readonly render: (options: {
    readonly projectRoot: string;
    readonly report: RunReport;
  }) => ReportCardArtifact;
  readonly prepareText: (
    options: PrepareObserverSenderOptions,
  ) => Promise<PreparedWechatTextSender>;
  readonly prepareImage: (
    options: PrepareObserverSenderOptions,
  ) => Promise<PreparedWechatImageSender>;
  readonly deliver: (
    options: DeliverRunReportOptions,
  ) => Promise<DeliverRunReportResult>;
  readonly enqueueOutbox: typeof enqueueRunReportOutbox;
  readonly processOutbox: typeof processRunReportOutbox;
  readonly createLogger: (options: JsonlLoggerOptions) => JsonlLogger;
}

function resolvedDependencies(
  supplied: ObserverDependencies | undefined,
): ResolvedObserverDependencies {
  return {
    loadConfig: supplied?.loadConfig ?? loadObserverConfig,
    recover: supplied?.recover ?? recoverInterruptedRuns,
    listFinalReports: supplied?.listFinalReports ?? listFinalRunReports,
    deliveryDisposition:
      supplied?.deliveryDisposition ?? runDeliveryDisposition,
    recordNotificationDisposition:
      supplied?.recordNotificationDisposition ?? recordRunReportNotificationDisposition,
    acquireTaskLock: supplied?.acquireTaskLock ?? acquireObserverTaskLock,
    runJob: supplied?.runJob ?? runManagedJob,
    normalize: supplied?.normalize ?? buildRunReport,
    finishRecord: supplied?.finishRecord ?? finishRunRecord,
    loadEditorial: supplied?.loadEditorial ?? loadEditorialConfig,
    assignIssue: supplied?.assignIssue ?? assignReportIssue,
    attachIssue: supplied?.attachIssue ?? attachIssue,
    replaceFinalRecord:
      supplied?.replaceFinalRecord ?? replaceFinalRunReport,
    prepareVisual: supplied?.prepareVisual ?? prepareReportVisual,
    renderEditorial:
      supplied?.renderEditorial ?? renderEditorialReportCard,
    render: supplied?.render ?? renderReportCard,
    prepareText:
      supplied?.prepareText ??
      (async ({ projectRoot, signal }) =>
        await prepareWechatTextSender({
          projectRoot,
          ...(signal === undefined ? {} : { signal }),
        })),
    prepareImage:
      supplied?.prepareImage ??
      (async ({ projectRoot, signal }) =>
        await prepareWechatImageSender({
          projectRoot,
          ...(signal === undefined ? {} : { signal }),
        })),
    deliver: supplied?.deliver ?? deliverRunReport,
    enqueueOutbox: supplied?.enqueueOutbox ?? enqueueRunReportOutbox,
    processOutbox: supplied?.processOutbox ?? processRunReportOutbox,
    createLogger: supplied?.createLogger ?? createJsonlLogger,
  };
}

function recoveryDraft(authority: RunAuthority): RunReportDraft {
  return {
    version: 1,
    summary: [RECOVERY_SUMMARY],
    metrics: [],
    failure: null,
    artifacts: [],
    editorial: buildStatusEditorialReport({
      reason: "interrupted",
      date: shanghaiDateKey(new Date(authority.finishedAt)),
    }),
  };
}

async function logObserverEvent(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  code: string,
): Promise<void> {
  try {
    const logger = dependencies.createLogger({
      projectRoot: options.projectRoot,
      filePath: join(options.projectRoot, "logs", "observer.jsonl"),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await logger.error(code);
  } catch {
    // Logging must never replace the primary control flow.
  }
}

interface PreparedFinalReportArtifacts {
  readonly report: RunReport;
  readonly artifact?: ReportCardArtifact | EditorialCardArtifact;
  readonly imageEnabled: boolean;
}

function issueFromReport(report: RunReport): ReportIssue | null {
  if (report.issueNumber === undefined || report.issueLabel === undefined) {
    return null;
  }
  return { number: report.issueNumber, label: report.issueLabel };
}

function visualMode(
  config: EditorialConfig,
): "off" | "deterministic" | "editorial" | "legacy" {
  const mode = (config as { readonly mode?: string }).mode;
  if (
    mode === "off" ||
    mode === "deterministic" ||
    mode === "legacy" ||
    mode === "editorial"
  ) {
    return mode;
  }
  return "editorial";
}

async function prepareFinalReportArtifacts(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  report: RunReport,
  disposition: RunDeliveryDisposition,
): Promise<PreparedFinalReportArtifacts> {
  const imageConfig = dependencies.loadEditorial(options.projectRoot);
  const mode = visualMode(imageConfig);

  if (mode === "off") {
    return { report, imageEnabled: false };
  }

  if (report.editorial === undefined) {
    return {
      report,
      artifact: dependencies.render({
        projectRoot: options.projectRoot,
        report,
      }),
      imageEnabled: true,
    };
  }

  let finalReport = report;
  let issue = issueFromReport(finalReport);
  // Numbered report assignment is independent of Image-2 generation mode.
  if (issue === null) {
    if (disposition !== "missing") {
      return {
        report,
        artifact: dependencies.render({
          projectRoot: options.projectRoot,
          report,
        }),
        imageEnabled: true,
      };
    }
    issue = await dependencies.assignIssue({
      projectRoot: options.projectRoot,
      runId: report.runId,
    });
    finalReport = dependencies.attachIssue(report, issue);
    dependencies.replaceFinalRecord(options.projectRoot, finalReport);
  }

  if (mode === "legacy" || mode === "deterministic") {
    return {
      report: finalReport,
      artifact: dependencies.render({
        projectRoot: options.projectRoot,
        report: finalReport,
      }),
      imageEnabled: true,
    };
  }

  const visual: PreparedReportVisual = await dependencies.prepareVisual({
    projectRoot: options.projectRoot,
    report: finalReport,
    issue,
    config: imageConfig,
  });
  return {
    report: finalReport,
    artifact: dependencies.renderEditorial({
      projectRoot: options.projectRoot,
      report: finalReport,
      visual,
    }),
    imageEnabled: true,
  };
}

async function deliverFinalReport(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  report: RunReport,
  disposition: RunDeliveryDisposition,
): Promise<RunReport> {
  let prepared: PreparedFinalReportArtifacts;
  try {
    prepared = await prepareFinalReportArtifacts(
      options,
      dependencies,
      report,
      disposition,
    );
  } catch {
    await logObserverEvent(options, dependencies, RENDER_FAILURE_CODE);
    throw new Error(SAFE_RENDER_ERROR);
  }

  const senderOptions = {
    projectRoot: options.projectRoot,
    report: prepared.report,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const sendText = await dependencies.prepareText(senderOptions);
  const sendImage = prepared.imageEnabled
    ? await dependencies.prepareImage(senderOptions)
    : async () => ({ status: "sent" as const });

  await dependencies.deliver({
    projectRoot: options.projectRoot,
    report: prepared.report,
    sendText,
    sendImage,
    ...(prepared.artifact === undefined
      ? {}
      : { imagePath: prepared.artifact.pngPath }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return prepared.report;
}

function recoveredReport(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  authority: RunAuthority,
): RunReport {
  const report = dependencies.normalize({
    authority,
    projectRoot: options.projectRoot,
    draft: recoveryDraft(authority),
  });
  dependencies.finishRecord(options.projectRoot, report);
  return report;
}

function managedDependencies(
  options: RunObserverJobOptions,
): ManagedJobDependencies {
  return {
    ...options.managedJobDependencies,
    acquireTaskLock: async () => ({
      release: async () => undefined,
    }),
  };
}

function shouldNotify(job: ObserverJob, report: RunReport): boolean {
  if (job.notify === "always") return true;
  if (job.notify === "never") return false;
  return report.status !== "success" && report.status !== "skipped";
}

async function queueHistoricalReports(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  recovery: RecoverInterruptedRunsResult,
  config: ObserverConfig,
): Promise<void> {
  for (const authority of recovery.recovered) {
    const report = recoveredReport(options, dependencies, authority);
    let reportJob: ObserverJob;
    try {
      reportJob = findObserverJob(config, report.taskId);
    } catch {
      continue;
    }
    if (!shouldNotify(reportJob, report)) {
      continue;
    }
    const disposition = dependencies.deliveryDisposition({
      projectRoot: options.projectRoot,
      report,
    });
    if (disposition === "missing" || disposition === "retryable") {
      dependencies.enqueueOutbox({
        projectRoot: options.projectRoot,
        report,
        priority: 10,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }
  }

  for (const report of dependencies.listFinalReports(options.projectRoot)) {
    let reportJob: ObserverJob;
    try {
      reportJob = findObserverJob(config, report.taskId);
    } catch {
      continue;
    }
    if (!shouldNotify(reportJob, report)) {
      continue;
    }
    const disposition = dependencies.deliveryDisposition({
      projectRoot: options.projectRoot,
      report,
    });
    if (disposition === "missing" || disposition === "retryable") {
      dependencies.enqueueOutbox({
        projectRoot: options.projectRoot,
        report,
        priority: 20,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }
  }
}

async function drainHistoricalOutbox(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
): Promise<void> {
  // Historical failures stay in outbox and never bubble into the current job.
  try {
    await dependencies.processOutbox({
      projectRoot: options.projectRoot,
      historyLimit: OUTBOX_HISTORY_LIMIT,
      deliver: dependencies.deliver,
      prepare: async (item) => {
        const prepared = await prepareFinalReportArtifacts(
          options,
          dependencies,
          item.report,
          "retryable",
        );
        return {
          report: prepared.report,
          ...(prepared.artifact === undefined
            ? {}
            : { imagePath: prepared.artifact.pngPath }),
        };
      },
      createSenders: async (item) => {
        const senderOptions = {
          projectRoot: options.projectRoot,
          report: item.report,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        return {
          sendText: await dependencies.prepareText(senderOptions),
          sendImage: await dependencies.prepareImage(senderOptions),
        };
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch {
    await logObserverEvent(options, dependencies, "OBSERVER_OUTBOX_DRAIN_FAILED");
  }
}

export async function runObserverJob(
  options: RunObserverJobOptions,
): Promise<RunReport> {
  const dependencies = resolvedDependencies(options.dependencies);
  const config = dependencies.loadConfig(options.projectRoot);
  const job = findObserverJob(config, options.jobId);
  const recovery = dependencies.recover({
    projectRoot: options.projectRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  await queueHistoricalReports(options, dependencies, recovery, config);
  await drainHistoricalOutbox(options, dependencies);

  if (recovery.activeTaskIds.includes(job.id)) {
    throw new ObserverTaskBusyError();
  }

  const lock = await dependencies.acquireTaskLock({
    projectRoot: options.projectRoot,
    taskId: job.id,
  });
  try {
    const outcome = await dependencies.runJob({
      projectRoot: options.projectRoot,
      job,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      ...(options.now === undefined ? {} : { now: options.now }),
      dependencies: managedDependencies(options),
    });
    const report = dependencies.normalize({
      authority: outcome.authority,
      projectRoot: options.projectRoot,
      draft: outcome.draft,
    });
    dependencies.finishRecord(options.projectRoot, report);

    if (!shouldNotify(job, report)) {
      dependencies.recordNotificationDisposition({
        projectRoot: options.projectRoot,
        report,
        disposition:
          job.notify === "never" ? "notification-disabled" : "not-required",
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      return report;
    }

    try {
      return await deliverFinalReport(
        options,
        dependencies,
        report,
        "missing",
      );
    } catch (error) {
      dependencies.enqueueOutbox({
        projectRoot: options.projectRoot,
        report,
        priority: 5,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      // Current-run failures remain visible to the caller, but the durable
      // outbox entry ensures a later worker can retry without blocking recovery.
      throw error;
    }
  } finally {
    await lock.release();
  }
}
