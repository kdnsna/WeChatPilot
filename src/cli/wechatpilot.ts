import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stringify } from "yaml";

import { runDailyDigest } from "../app/digest.js";
import {
  formatProjectHealthHuman,
  inspectProjectHealth,
} from "../app/health.js";
import { inspectOutbox } from "../delivery/outbox.js";
import {
  applicationSupportProfileRoot,
  resolveLayoutRoots,
} from "../layout/roots.js";
import { loadConfig } from "../config/load.js";
import { resolveRuntime } from "../config/runtime.js";
import { loadEditorialConfig } from "../observer/editorial-config.js";
import { loadObserverConfig } from "../observer/config.js";
import { buildStabilityReview } from "../observer/stability-review.js";

const LABEL = "io.wechatpilot.daily-tech-digest";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function projectRoot(arguments_: readonly string[]): string {
  const index = arguments_.indexOf("--project-root");
  if (index < 0) return resolve(process.cwd());
  const value = arguments_[index + 1];
  if (value === undefined) throw new Error("--project-root requires a path");
  return resolve(value);
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function writeAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function initialize(root: string): object {
  const runtime = resolveRuntime();
  loadConfig(root);
  loadObserverConfig(root);
  loadEditorialConfig(root);
  const directory = join(root, ".state");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeAtomic(join(directory, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, 0o600);
  const metrics = join(directory, "stability-metrics.json");
  if (!existsSync(metrics)) writeAtomic(metrics, `${JSON.stringify({ staleLockRecoveries: 0, manualInterventions: 0 })}\n`, 0o600);
  return { ok: true, status: "initialized", nodeVersion: runtime.nodeVersion, codexVersion: runtime.codexVersion };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function inspectLocks(root: string, repair: boolean): object {
  const directory = join(root, ".state", "locks");
  if (!existsSync(directory)) return { total: 0, active: 0, stale: 0, repaired: 0, ledgerBlocked: 0 };
  let active = 0;
  let stale = 0;
  let repaired = 0;
  let ledgerBlocked = 0;
  const files = readdirSync(directory).filter((name) => /^(?:scheduled|delivery-\d{4}-\d{2}-\d{2})\.lock$/u.test(name));
  for (const name of files) {
    const path = join(directory, name);
    const before = lstatSync(path);
    let pid = 0;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
      pid = typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) ? parsed.pid : 0;
    } catch {
      // Invalid lock records fail closed unless explicit repair can prove no ledger risk.
    }
    if (pid > 0 && processAlive(pid)) { active += 1; continue; }
    stale += 1;
    const date = /^delivery-(\d{4}-\d{2}-\d{2})\.lock$/u.exec(name)?.[1];
    if (date !== undefined) {
      try {
        const ledger = JSON.parse(readFileSync(join(root, ".state", "delivery", `${date}.json`), "utf8")) as { status?: unknown };
        if (ledger.status === "sending" || ledger.status === "indeterminate") {
          ledgerBlocked += 1;
          continue;
        }
      } catch {
        // No readable ledger means repair remains explicit but is permitted.
      }
    }
    if (repair) {
      const current = lstatSync(path);
      if (current.isFile() && current.dev === before.dev && current.ino === before.ino) {
        unlinkSync(path);
        repaired += 1;
      }
    }
  }
  if (repaired > 0) {
    const metricsPath = join(root, ".state", "stability-metrics.json");
    let metrics = { staleLockRecoveries: 0, manualInterventions: 0 };
    try { metrics = { ...metrics, ...(JSON.parse(readFileSync(metricsPath, "utf8")) as object) }; } catch { /* create below */ }
    writeAtomic(metricsPath, `${JSON.stringify({
      staleLockRecoveries: Number.isSafeInteger(metrics.staleLockRecoveries) ? metrics.staleLockRecoveries : 0,
      manualInterventions: (Number.isSafeInteger(metrics.manualInterventions) ? metrics.manualInterventions : 0) + repaired,
    })}\n`, 0o600);
  }
  return { total: files.length, active, stale, repaired, ledgerBlocked };
}

function plist(root: string, hour: number, minute: number, timezone: string, logDirectory: string): string {
  const runtime = resolveRuntime();
  const entrypoint = join(root, "dist", "src", "cli", "observer.js");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array><string>${xml(runtime.nodeExecutable)}</string><string>${xml(entrypoint)}</string><string>--project-root</string><string>${xml(root)}</string><string>--job</string><string>daily-tech-digest</string></array>\n  <key>WorkingDirectory</key><string>${xml(root)}</string>\n  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ExitTimeOut</key><integer>30</integer>\n  <key>EnvironmentVariables</key><dict><key>TZ</key><string>${xml(timezone)}</string></dict>\n  <key>StandardOutPath</key><string>${xml(join(logDirectory, "launchd.stdout.log"))}</string>\n  <key>StandardErrorPath</key><string>${xml(join(logDirectory, "launchd.stderr.log"))}</string>\n</dict></plist>\n`;
}

function schedulePath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function schedule(arguments_: readonly string[], root: string): object {
  const action = arguments_[1];
  const target = schedulePath();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (action === "status") {
    try { execFileSync("/bin/launchctl", ["print", `${domain}/${LABEL}`], { stdio: "ignore" }); return { ok: true, status: "installed" }; }
    catch { return { ok: true, status: "not-installed" }; }
  }
  if (action === "remove") {
    if (existsSync(target)) {
      try { execFileSync("/bin/launchctl", ["bootout", domain, target], { stdio: "ignore" }); } catch { /* already unloaded */ }
      unlinkSync(target);
    }
    return { ok: true, status: "removed" };
  }
  if (action !== "install") throw new Error("Unknown schedule action");
  const hour = Number(option(arguments_, "--hour") ?? "8");
  const minute = Number(option(arguments_, "--minute") ?? "0");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("Invalid schedule time");
  const timezone = option(arguments_, "--timezone") ?? loadConfig(root).digest.timezone;
  const logDirectory = resolve(option(arguments_, "--log-dir") ?? join(root, "logs"));
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  writeAtomic(target, plist(root, hour, minute, timezone, logDirectory), 0o600);
  execFileSync("/usr/bin/plutil", ["-lint", target], { stdio: "ignore" });
  execFileSync("/bin/launchctl", ["bootstrap", domain, target], { stdio: "ignore" });
  return { ok: true, status: "installed", hour, minute, timezone };
}

export async function runWechatPilot(arguments_: readonly string[]): Promise<object> {
  const root = projectRoot(arguments_);
  if (!isAbsolute(root)) throw new Error("Project root must be absolute");
  if (arguments_[0] === "init") return initialize(root);
  if (arguments_[0] === "doctor") {
    const repair = arguments_.includes("--repair");
    const json = arguments_.includes("--json");
    const health = inspectProjectHealth({ projectRoot: root });
    const locks = inspectLocks(root, repair);
    const outbox = inspectOutbox(root);
    const layout = resolveLayoutRoots({ projectRoot: root });
    if (!json) {
      const human = [
        formatProjectHealthHuman(health).trimEnd(),
        `locks: total=${(locks as { total: number }).total} active=${(locks as { active: number }).active} stale=${(locks as { stale: number }).stale} repaired=${(locks as { repaired: number }).repaired}`,
        `outbox: pending=${outbox.pending} manualReview=${outbox.manualReview} blocked=${outbox.blocked}`,
        `layout: app=${layout.appRoot}`,
        `layout: workspace=${layout.workspaceRoot}`,
        `layout: state=${layout.stateRoot}`,
        `profileDefault: ${applicationSupportProfileRoot()}`,
      ].join("\n");
      return { ok: true, repair, format: "human", text: `${human}\n`, health, locks, outbox, layout };
    }
    return { ok: true, repair, locks, health, outbox, layout };
  }
  if (arguments_[0] === "config" && arguments_[1] === "validate") {
    loadConfig(root); loadObserverConfig(root); loadEditorialConfig(root);
    return { ok: true, status: "valid" };
  }
  if (arguments_[0] === "run" && arguments_[1] === "daily-tech-digest") {
    if (!arguments_.includes("--dry-run")) throw new Error("Interactive run requires --dry-run or the scheduled command");
    const result = await runDailyDigest({ projectRoot: root, dryRun: true });
    return { ok: true, status: result.status };
  }
  if (arguments_[0] === "schedule") return schedule(arguments_, root);
  if (arguments_[0] === "stability" && arguments_[1] === "review") {
    return buildStabilityReview(root);
  }
  throw new Error("Usage: wechatpilot <init|doctor|config validate|run daily-tech-digest --dry-run|schedule install|status|remove>");
}

async function main(): Promise<void> {
  try {
    const result = await runWechatPilot(process.argv.slice(2));
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      if (record.format === "human" && typeof record.text === "string") {
        process.stdout.write(record.text);
        return;
      }
    }
    process.stdout.write(`${stringify(result).trim()}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, message: "wechatpilot command failed" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
