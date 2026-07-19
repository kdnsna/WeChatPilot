import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { assertNoSymlinkComponents } from "../lib/paths.js";
import { writeProjectTextAtomic } from "../lib/project-file.js";
import {
  ObserverJobSchema,
  type ObserverJob,
} from "./config.js";
import {
  RunAuthoritySchema,
  RunReportSchema,
  type RunAuthority,
  type RunReport,
} from "./run-report.js";

const MAXIMUM_RECORD_BYTES = 256 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_ERROR_MESSAGE = "Invalid observer run state";

const PositivePidSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const auditedAuthorityShape = {
  runId: z.uuid(),
  taskId: ObserverJobSchema.shape.id,
  taskName: ObserverJobSchema.shape.name,
  projectLabel: ObserverJobSchema.shape.projectLabel,
  startedAt: z.iso.datetime({ offset: true }),
} as const;

const RunningRunRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("running"),
    ...auditedAuthorityShape,
    runnerPid: PositivePidSchema,
    childPid: PositivePidSchema.optional(),
  })
  .strict();

const RecoveryPendingRunRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("recovery-pending"),
    ...auditedAuthorityShape,
    finishedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (record) => Date.parse(record.finishedAt) >= Date.parse(record.startedAt),
    "finishedAt must not precede startedAt",
  );

export interface RunningRunRecord {
  readonly version: 1;
  readonly status: "running";
  readonly runId: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly projectLabel: string;
  readonly runnerPid: number;
  readonly childPid?: number;
  readonly startedAt: string;
}

interface RecoveryPendingRunRecord {
  readonly version: 1;
  readonly status: "recovery-pending";
  readonly runId: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly projectLabel: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface StartRunRecordOptions {
  readonly projectRoot: string;
  readonly runId: string;
  readonly job: ObserverJob;
  readonly runnerPid: number;
  readonly startedAt: Date;
}

export interface UpdateRunChildPidOptions {
  readonly projectRoot: string;
  readonly runId: string;
  readonly childPid: number;
}

export interface RecoverInterruptedRunsOptions {
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface RecoverInterruptedRunsResult {
  readonly recovered: readonly RunAuthority[];
  readonly activeTaskIds: readonly string[];
  readonly invalidRecords: number;
}

type JournalRecord =
  | { readonly kind: "running"; readonly value: RunningRunRecord }
  | { readonly kind: "recovery-pending"; readonly value: RecoveryPendingRunRecord }
  | { readonly kind: "final"; readonly value: RunReport };

interface ScanResult {
  readonly records: readonly JournalRecord[];
  readonly invalidRecords: number;
}

function normalizedRunningRecord(
  value: z.infer<typeof RunningRunRecordSchema>,
): RunningRunRecord {
  const record = {
    version: value.version,
    status: value.status,
    runId: value.runId,
    taskId: value.taskId,
    taskName: value.taskName,
    projectLabel: value.projectLabel,
    runnerPid: value.runnerPid,
    startedAt: value.startedAt,
  } as const;
  return value.childPid === undefined
    ? record
    : { ...record, childPid: value.childPid };
}

function safeError(): Error {
  const error = new Error(SAFE_ERROR_MESSAGE);
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function stateDirectories(projectRoot: string): readonly string[] {
  const state = join(projectRoot, ".state");
  const observer = join(state, "observer");
  return [state, observer, join(observer, "runs")];
}

function createPrivateRunsDirectory(projectRoot: string): string {
  const directories = stateDirectories(projectRoot);
  for (const directory of directories) {
    assertNoSymlinkComponents(projectRoot, directory);
    try {
      mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw safeError();
    }
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
  return directories[directories.length - 1] as string;
}

function existingPrivateRunsDirectory(projectRoot: string): string | null {
  const directories = stateDirectories(projectRoot);
  const runsDirectory = directories[directories.length - 1] as string;
  assertNoSymlinkComponents(projectRoot, runsDirectory);
  try {
    lstatSync(runsDirectory);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  for (const directory of directories) {
    assertNoSymlinkComponents(projectRoot, directory);
    let metadata;
    try {
      metadata = lstatSync(directory);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw safeError();
    }
  }
  return runsDirectory;
}

function recordPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".state", "observer", "runs", `${runId}.json`);
}

function isAuditedAuthority(value: {
  readonly taskId: string;
  readonly taskName: string;
  readonly projectLabel: string;
}): boolean {
  return (
    ObserverJobSchema.shape.id.safeParse(value.taskId).success &&
    ObserverJobSchema.shape.name.safeParse(value.taskName).success &&
    ObserverJobSchema.shape.projectLabel.safeParse(value.projectLabel).success
  );
}

function parseJournalRecord(raw: unknown, expectedRunId: string): JournalRecord | null {
  const running = RunningRunRecordSchema.safeParse(raw);
  if (running.success && running.data.runId === expectedRunId) {
    return { kind: "running", value: normalizedRunningRecord(running.data) };
  }

  const pending = RecoveryPendingRunRecordSchema.safeParse(raw);
  if (pending.success && pending.data.runId === expectedRunId) {
    return { kind: "recovery-pending", value: pending.data };
  }

  const final = RunReportSchema.safeParse(raw);
  if (
    final.success &&
    final.data.runId === expectedRunId &&
    isAuditedAuthority(final.data)
  ) {
    return { kind: "final", value: final.data };
  }
  return null;
}

function readPrivateRecord(path: string, expectedRunId: string): JournalRecord | null {
  let descriptor: number | undefined;
  try {
    const pathMetadata = lstatSync(path);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      (pathMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      pathMetadata.size > MAXIMUM_RECORD_BYTES
    ) {
      return null;
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      metadata.size !== pathMetadata.size ||
      metadata.size > MAXIMUM_RECORD_BYTES ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      return null;
    }

    const content = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        return null;
      }
      offset += bytesRead;
    }
    if (fstatSync(descriptor).size !== metadata.size) {
      return null;
    }
    return parseJournalRecord(JSON.parse(content.toString("utf8")), expectedRunId);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function validRunIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) {
    return null;
  }
  const runId = fileName.slice(0, -".json".length);
  return z.uuid().safeParse(runId).success ? runId : null;
}

function scanRunState(projectRoot: string): ScanResult {
  const directory = existingPrivateRunsDirectory(projectRoot);
  if (directory === null) {
    return { records: [], invalidRecords: 0 };
  }

  const records: JournalRecord[] = [];
  let invalidRecords = 0;
  for (const fileName of readdirSync(directory).sort()) {
    const runId = validRunIdFromFileName(fileName);
    if (runId === null) {
      invalidRecords += 1;
      continue;
    }
    const record = readPrivateRecord(join(directory, fileName), runId);
    if (record === null) {
      invalidRecords += 1;
    } else {
      records.push(record);
    }
  }
  return { records, invalidRecords };
}

function writeRecord(projectRoot: string, runId: string, value: unknown): void {
  writeProjectTextAtomic(
    projectRoot,
    recordPath(projectRoot, runId),
    `${JSON.stringify(value)}\n`,
  );
}

function recordForUpdate(projectRoot: string, runId: string): JournalRecord {
  const directory = existingPrivateRunsDirectory(projectRoot);
  if (directory === null) {
    throw safeError();
  }
  const record = readPrivateRecord(recordPath(projectRoot, runId), runId);
  if (record === null) {
    throw safeError();
  }
  return record;
}

function compareAuthority(
  left: Pick<RunAuthority, "startedAt" | "runId">,
  right: Pick<RunAuthority, "startedAt" | "runId">,
): number {
  return left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function startRunRecord(options: StartRunRecordOptions): RunningRunRecord {
  try {
    const parsedJob = ObserverJobSchema.parse(options.job);
    const runId = z.uuid().parse(options.runId);
    const runnerPid = PositivePidSchema.parse(options.runnerPid);
    const startedAt = options.startedAt.toISOString();
    const record = RunningRunRecordSchema.parse({
      version: 1,
      status: "running",
      runId,
      taskId: parsedJob.id,
      taskName: parsedJob.name,
      projectLabel: parsedJob.projectLabel,
      runnerPid,
      startedAt,
    });
    createPrivateRunsDirectory(options.projectRoot);
    try {
      lstatSync(recordPath(options.projectRoot, runId));
      throw safeError();
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    writeRecord(options.projectRoot, runId, record);
    return normalizedRunningRecord(record);
  } catch {
    throw safeError();
  }
}

export function updateRunChildPid(
  options: UpdateRunChildPidOptions,
): RunningRunRecord {
  try {
    const runId = z.uuid().parse(options.runId);
    const childPid = PositivePidSchema.parse(options.childPid);
    const current = recordForUpdate(options.projectRoot, runId);
    if (current.kind !== "running") {
      throw safeError();
    }
    const updated = RunningRunRecordSchema.parse({
      ...current.value,
      childPid,
    });
    writeRecord(options.projectRoot, runId, updated);
    return normalizedRunningRecord(updated);
  } catch {
    throw safeError();
  }
}

export function finishRunRecord(projectRoot: string, report: RunReport): void {
  try {
    const final = RunReportSchema.parse(report);
    if (!isAuditedAuthority(final)) {
      throw safeError();
    }
    const current = recordForUpdate(projectRoot, final.runId);
    if (current.kind === "final") {
      throw safeError();
    }
    const authority = current.value;
    if (
      authority.runId !== final.runId ||
      authority.taskId !== final.taskId ||
      authority.taskName !== final.taskName ||
      authority.projectLabel !== final.projectLabel ||
      authority.startedAt !== final.startedAt
    ) {
      throw safeError();
    }
    if (
      current.kind === "recovery-pending" &&
      (current.value.finishedAt !== final.finishedAt ||
        final.status !== "interrupted")
    ) {
      throw safeError();
    }
    writeRecord(projectRoot, final.runId, final);
  } catch {
    throw safeError();
  }
}

export function recoverInterruptedRuns(
  options: RecoverInterruptedRunsOptions,
): RecoverInterruptedRunsResult {
  try {
    const scan = scanRunState(options.projectRoot);
    const recovered: RunAuthority[] = [];
    const activeTaskIds = new Set<string>();
    const alive = options.isProcessAlive ?? processIsAlive;
    let invalidRecords = scan.invalidRecords;

    for (const entry of scan.records) {
      if (entry.kind !== "running") {
        continue;
      }
      const record = entry.value;
      let runnerAlive = true;
      let childAlive = false;
      try {
        runnerAlive = alive(record.runnerPid);
        childAlive = record.childPid === undefined ? false : alive(record.childPid);
      } catch {
        runnerAlive = true;
      }
      if (runnerAlive || childAlive) {
        activeTaskIds.add(record.taskId);
        continue;
      }

      let finishedAt: string;
      try {
        finishedAt = (options.now?.() ?? new Date()).toISOString();
      } catch {
        invalidRecords += 1;
        continue;
      }
      const authority = RunAuthoritySchema.safeParse({
        runId: record.runId,
        taskId: record.taskId,
        taskName: record.taskName,
        projectLabel: record.projectLabel,
        status: "interrupted",
        startedAt: record.startedAt,
        finishedAt,
      });
      if (!authority.success) {
        invalidRecords += 1;
        continue;
      }
      const pending = RecoveryPendingRunRecordSchema.parse({
        version: 1,
        status: "recovery-pending",
        runId: record.runId,
        taskId: record.taskId,
        taskName: record.taskName,
        projectLabel: record.projectLabel,
        startedAt: record.startedAt,
        finishedAt,
      });
      writeRecord(options.projectRoot, record.runId, pending);
      recovered.push(authority.data);
    }

    recovered.sort(compareAuthority);
    return {
      recovered,
      activeTaskIds: [...activeTaskIds].sort(),
      invalidRecords,
    };
  } catch {
    throw safeError();
  }
}

export function listFinalRunReports(projectRoot: string): readonly RunReport[] {
  try {
    return scanRunState(projectRoot).records
      .flatMap((entry) => (entry.kind === "final" ? [entry.value] : []))
      .sort(compareAuthority);
  } catch {
    throw safeError();
  }
}

export function inspectRunState(projectRoot: string): {
  readonly recoveryPending: number;
  readonly invalidRecords: number;
} {
  try {
    const scan = scanRunState(projectRoot);
    return {
      recoveryPending: scan.records.filter(
        (entry) => entry.kind === "recovery-pending",
      ).length,
      invalidRecords: scan.invalidRecords,
    };
  } catch {
    throw safeError();
  }
}
