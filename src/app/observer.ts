import { join } from "node:path";

import {
  deliverRunReport,
  runDeliveryDisposition,
  type DeliverRunReportOptions,
  type DeliverRunReportResult,
  type RunDeliveryDisposition,
} from "../delivery/run-report-delivery.js";
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
} from "../observer/config.js";
import {
  runManagedJob,
  type ManagedJobDependencies,
  type ManagedJobOutcome,
  type RunManagedJobOptions,
} from "../observer/managed-job.js";
import {
  renderReportCard,
  type ReportCardArtifact,
} from "../observer/report-card.js";
import {
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
  type RecoverInterruptedRunsOptions,
  type RecoverInterruptedRunsResult,
} from "../observer/run-state.js";
import {
  acquireObserverTaskLock,
  ObserverTaskBusyError,
  type AcquireObserverTaskLockOptions,
  type ObserverTaskLock,
} from "../observer/task-lock.js";

const RECOVERY_SUMMARY = "任务因主机或进程中断，已在恢复后补记";
const RENDER_FAILURE_CODE = "OBSERVER_REPORT_RENDER_FAILED";

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
  readonly acquireTaskLock?: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
  readonly runJob?: (options: RunManagedJobOptions) => Promise<ManagedJobOutcome>;
  readonly normalize?: (options: BuildRunReportOptions) => RunReport;
  readonly finishRecord?: (projectRoot: string, report: RunReport) => void;
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
  readonly acquireTaskLock: (
    options: AcquireObserverTaskLockOptions,
  ) => Promise<ObserverTaskLock>;
  readonly runJob: (options: RunManagedJobOptions) => Promise<ManagedJobOutcome>;
  readonly normalize: (options: BuildRunReportOptions) => RunReport;
  readonly finishRecord: (projectRoot: string, report: RunReport) => void;
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
    acquireTaskLock: supplied?.acquireTaskLock ?? acquireObserverTaskLock,
    runJob: supplied?.runJob ?? runManagedJob,
    normalize: supplied?.normalize ?? buildRunReport,
    finishRecord: supplied?.finishRecord ?? finishRunRecord,
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
    createLogger: supplied?.createLogger ?? createJsonlLogger,
  };
}

function recoveryDraft(): RunReportDraft {
  return {
    version: 1,
    summary: [RECOVERY_SUMMARY],
    metrics: [],
    failure: null,
    artifacts: [],
  };
}

async function logRenderFailure(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
): Promise<void> {
  try {
    const logger = dependencies.createLogger({
      projectRoot: options.projectRoot,
      filePath: join(options.projectRoot, "logs", "observer.jsonl"),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await logger.error(RENDER_FAILURE_CODE);
  } catch {
    // A logging failure must not prevent the text-only audited report.
  }
}

async function deliverFinalReport(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  report: RunReport,
): Promise<void> {
  let imagePath: string | undefined;
  try {
    imagePath = dependencies.render({ projectRoot: options.projectRoot, report })
      .pngPath;
  } catch {
    await logRenderFailure(options, dependencies);
  }

  const senderOptions = {
    projectRoot: options.projectRoot,
    report,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const sendText = await dependencies.prepareText(senderOptions);
  const sendImage =
    imagePath === undefined
      ? async (): Promise<{ readonly status: "sent" }> => ({ status: "sent" })
      : await dependencies.prepareImage(senderOptions);

  await dependencies.deliver({
    projectRoot: options.projectRoot,
    report,
    sendText,
    sendImage,
    ...(imagePath === undefined ? {} : { imagePath }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function recoveredReport(
  options: RunObserverJobOptions,
  dependencies: ResolvedObserverDependencies,
  authority: RunAuthority,
): RunReport {
  const report = dependencies.normalize({
    authority,
    projectRoot: options.projectRoot,
    draft: recoveryDraft(),
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

  for (const authority of recovery.recovered) {
    const report = recoveredReport(options, dependencies, authority);
    await deliverFinalReport(options, dependencies, report);
  }

  for (const report of dependencies.listFinalReports(options.projectRoot)) {
    const disposition = dependencies.deliveryDisposition({
      projectRoot: options.projectRoot,
      report,
    });
    if (disposition === "missing" || disposition === "retryable") {
      await deliverFinalReport(options, dependencies, report);
    }
  }

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
    await deliverFinalReport(options, dependencies, report);
    return report;
  } finally {
    await lock.release();
  }
}
