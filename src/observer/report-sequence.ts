import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  readProjectText,
  writeProjectTextAtomic,
} from "../lib/project-file.js";
import {
  acquireObserverTaskLock,
  ObserverTaskBusyError,
  type ObserverTaskLock,
} from "./task-lock.js";

const MAXIMUM_LEDGER_BYTES = 1024 * 1024;
const RunIdSchema = z.uuid();
const ReportSequenceSchema = z
  .object({
    version: z.literal(1),
    lastIssued: z.number().int().nonnegative().max(999_999),
    assignments: z.record(z.uuid(), z.number().int().positive().max(999_999)),
  })
  .strict();

export interface ReportIssue {
  readonly number: number;
  readonly label: string;
}

function issue(number: number): ReportIssue {
  return { number, label: `WP-${String(number).padStart(6, "0")}` };
}

async function acquireSequenceLock(projectRoot: string): Promise<ObserverTaskLock> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await acquireObserverTaskLock({
        projectRoot,
        taskId: "report-sequence",
      });
    } catch (error) {
      if (!(error instanceof ObserverTaskBusyError) || attempt === 99) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new ObserverTaskBusyError();
}

export async function assignReportIssue(options: {
  readonly projectRoot: string;
  readonly runId: string;
}): Promise<ReportIssue> {
  const runId = RunIdSchema.parse(options.runId);
  const lock = await acquireSequenceLock(options.projectRoot);
  try {
    const path = join(
      options.projectRoot,
      ".state",
      "observer",
      "report-sequence.json",
    );
    const existing = readProjectText(
      options.projectRoot,
      path,
      MAXIMUM_LEDGER_BYTES,
    );
    const ledger =
      existing === null
        ? { version: 1 as const, lastIssued: 0, assignments: {} }
        : ReportSequenceSchema.parse(JSON.parse(existing) as unknown);
    const assigned = ledger.assignments[runId];
    if (assigned !== undefined) {
      return issue(assigned);
    }
    if (ledger.lastIssued >= 999_999) {
      throw new Error("Editorial report sequence exhausted");
    }
    const number = ledger.lastIssued + 1;
    writeProjectTextAtomic(
      options.projectRoot,
      path,
      `${JSON.stringify({
        version: 1,
        lastIssued: number,
        assignments: { ...ledger.assignments, [runId]: number },
      })}\n`,
    );
    chmodSync(join(options.projectRoot, ".state", "observer"), 0o700);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Invalid editorial report sequence");
    }
    return issue(number);
  } finally {
    await lock.release();
  }
}
