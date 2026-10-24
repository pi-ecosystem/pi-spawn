/**
 * jobs — generic cross-platform job scheduler for pi (pi-jobs package).
 *
 * A job is any shell command. No pi-specific runtime: no RPC, no steering,
 * no transcripts. The ONLY pi-specific bits are (1) this runs as a pi
 * extension and (2) jobs are mapped to the pi session that submitted them.
 *
 * Persistence: jobs + runs live in ONE SQLite db (WAL + busy_timeout), logs
 * per run on disk. SQLite serializes concurrent writers, so any number of
 * live pi sessions share the db safely — no last-writer-wins.
 * Reboot kills processes (true for anything) but data survives: on the next
 * `session_start` we reconcile `running` runs against live pids — dead ones
 * become `interrupted` and relaunch per their restart policy.
 *
 * Visibility: a session sees its OWN jobs by default. Cross-session
 * (`all` / `orphans`, explicit ids, adopt) is opt-in, for cleanup and whatnot.
 *
 * Portable resume = rehydrate when pi starts. True boot-without-login resume
 * needs OS hooks (systemd/launchd/Task Scheduler) — later, behind this API.
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type RestartPolicy = "no" | "on-failure" | "always";
type RunState = "running" | "done" | "failed" | "killed" | "interrupted";

interface Job {
  id: string;
  label: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  sessionId?: string;
  sessionFile?: string;
  restart: RestartPolicy;
  maxRestarts: number; // 0 = unlimited
  createdAt: number;
  updatedAt: number;
}

interface Run {
  runId: string;
  jobId: string;
  pid?: number;
  state: RunState;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  logFile: string;
  customLog?: string; // job's own log (e.g. pi session jsonl): logs reads this instead
  error?: string;
}

const POLL_MS = 5_000;
const KILL_GRACE_MS = 5_000;

function jobsRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "jobs");
}
function dbPath(): string {
  return path.join(jobsRoot(), "jobs.db");
}
function runDir(runId: string): string {
  return path.join(jobsRoot(), "runs", runId);
}

let counter = 0;
function rid(prefix: string): string {
  counter += 1;
  // pid + random: ids must be unique across concurrent pi sessions on one box.
  return `${prefix}-${Date.now().toString(36)}${process.pid.toString(36)}-${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

// --- sqlite store (single file, safe for concurrent sessions) ----------------

let _db: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.join(jobsRoot(), "runs"), { recursive: true });
  const d = new DatabaseSync(dbPath());
  d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  d.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    env TEXT,
    session_id TEXT,
    session_file TEXT,
    restart TEXT NOT NULL DEFAULT 'no',
    max_restarts INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    pid INTEGER,
    state TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    log_file TEXT NOT NULL,
    custom_log TEXT,
    error TEXT
  );`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);");
  _db = d;
  return d;
}

function rowToJob(r: any): Job {
  return {
    id: r.id,
    label: r.label,
    command: r.command,
    cwd: r.cwd,
    env: r.env ? JSON.parse(r.env) : undefined,
    sessionId: r.session_id ?? undefined,
    sessionFile: r.session_file ?? undefined,
    restart: r.restart as RestartPolicy,
    maxRestarts: r.max_restarts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRun(r: any): Run {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    pid: r.pid ?? undefined,
    state: r.state as RunState,
    exitCode: r.exit_code ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    logFile: r.log_file,
    customLog: r.custom_log ?? undefined,
    error: r.error ?? undefined,
  };
}

function getJob(id: string): Job | undefined {
  const row = db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
  return row ? rowToJob(row) : undefined;
}

function getRun(runId: string): Run | undefined {
  const row = db().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
  return row ? rowToRun(row) : undefined;
}

function runsOf(jobId: string, limit?: number): Run[] {
  const rows = db()
    .prepare(`SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC${limit ? ` LIMIT ${limit}` : ""}`)
    .all(jobId) as any[];
  return rows.map(rowToRun);
}

function latestRun(jobId: string): Run | undefined {
  return runsOf(jobId, 1)[0];
}

// Live handles only exist for runs started by THIS process. Anything else
// (previous boot, other session) is managed by pid + log file only.
const live = new Map<string, { proc: ChildProcess; fd: number }>();
const stopping = new Set<string>(); // runIds being killed -> settle as killed
let pollTimer: NodeJS.Timeout | undefined;
let tuiCtx: ExtensionContext | undefined;

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentSession(ctx: ExtensionContext | undefined): { id?: string; file?: string } {
  try {
    const sm = ctx?.sessionManager as any;
    const file = typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined;
    const id =
      typeof sm?.getSessionId === "function"
        ? sm.getSessionId()
        : file
          ? path.basename(file, path.extname(file))
          : undefined;
    return { id: typeof id === "string" ? id : undefined, file: typeof file === "string" ? file : undefined };
  } catch {
    return {};
  }
}

// --- process helpers (cross-platform) ----------------------------------------

function killTree(proc: ChildProcess, pid: number | undefined, sig: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else try { proc.kill("SIGKILL" as any); } catch { /* ignore */ }
    return;
  }
  if (pid) {
    try { process.kill(-pid, sig); return; } catch { /* not a group leader; fall through */ }
    try { process.kill(pid, sig); return; } catch { /* already dead */ }
  }
  try { proc.kill(sig); } catch { /* ignore */ }
}

function killPidOnly(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(pid, sig); } catch { /* already dead */ }
}

// --- job lifecycle -------------------------------------------------------------

function effLog(run: Run): string {
  return run.customLog ?? run.logFile;
}

function fmtElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function runSummary(r: Run): string {
  const label = getJob(r.jobId)?.label ?? r.jobId;
  const exit = r.exitCode != null ? ` · exit ${r.exitCode}` : "";
  const err = r.error ? ` — ${r.error.slice(0, 200)}` : "";
  return `${r.runId} [${label}] ${r.state} · ${fmtElapsed(r.startedAt, r.endedAt)}${exit}${err}\nLogs: ${effLog(r)}`;
}

function jobSummary(j: Job): string {
  const runs = runsOf(j.id);
  const last = runs[0];
  const sess = j.sessionId ? ` · session ${j.sessionId.slice(0, 12)}` : "";
  return `${j.id} [${j.label}] restart=${j.restart}${sess} · ${runs.length} run${runs.length === 1 ? "" : "s"}${last ? ` · last: ${last.state}` : ""}`;
}

function listJobs(sessionId: string | undefined, scope: string, state?: string): Job[] {
  const d = db();
  let rows: any[];
  if (scope === "mine") {
    if (!sessionId) return [];
    rows = d.prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as any[];
  } else if (scope === "orphans") {
    rows = (sessionId
      ? d.prepare("SELECT * FROM jobs WHERE session_id IS NULL OR session_id != ? ORDER BY created_at DESC").all(sessionId)
      : d.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()) as any[];
  } else {
    rows = d.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as any[];
  }
  let jobs = rows.map(rowToJob);
  if (state) {
    const withState = new Set(
      (d.prepare("SELECT DISTINCT job_id AS id FROM runs WHERE state = ?").all(state) as any[]).map((r) => r.id as string),
    );
    jobs = jobs.filter((j) => withState.has(j.id));
  }
  return jobs;
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
function errResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true as const };
}

function refreshWidget() {
  try {
    if (!tuiCtx || tuiCtx.mode !== "tui") return;
    const sess = currentSession(tuiCtx)?.id;
    const n = sess
      ? (db().prepare(`SELECT COUNT(*) AS n FROM runs JOIN jobs ON jobs.id = runs.job_id
          WHERE runs.state = 'running' AND jobs.session_id = ?`).get(sess) as any)?.n ?? 0
      : (db().prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'running'").get() as any)?.n ?? 0;
    tuiCtx.ui.setWidget("jobs", n ? [`◌ ${n} job${n === 1 ? "" : "s"} running`, ""] : undefined);
  } catch { /* headless host */ }
}

function restartsUsed(jobId: string): number {
  const n = (db().prepare("SELECT COUNT(*) AS n FROM runs WHERE job_id = ?").get(jobId) as any)?.n ?? 1;
  return Math.max(0, n - 1); // runs beyond the first
}

/** Atomically claim a running run into a terminal state. Returns the settled
 *  run, or undefined if another session already settled it. */
function settleRun(runId: string, state: RunState, fields: { endedAt: number; exitCode?: number; error?: string }): Run | undefined {
  const d = db();
  const info = d.prepare(`UPDATE runs SET state = ?, ended_at = ?,
      exit_code = COALESCE(?, exit_code), error = COALESCE(?, error)
      WHERE run_id = ? AND state = 'running'`)
    .run(state, fields.endedAt, fields.exitCode ?? null, fields.error ?? null, runId);
  if (info.changes !== 1) return undefined;
  return getRun(runId);
}

function launchRun(pi: ExtensionAPI, job: Job, run: Run): void {
  const outFd = fs.openSync(run.logFile, "a");
  try {
    fs.appendFileSync(outFd, `$ ${job.command}\n# job ${job.id} run ${run.runId} · ${new Date().toISOString()}\n`);
  } catch { /* ignore */ }
  const proc = nodeSpawn(job.command, {
    cwd: job.cwd,
    detached: true, // survive parent exit; adopted/killed explicitly
    shell: true, // /bin/sh on posix, cmd.exe on win
    stdio: ["ignore", outFd, outFd], // direct-to-file so logs survive parent death
    env: { ...process.env, ...(job.env ?? {}) } as NodeJS.ProcessEnv,
  });
  try { (proc as any).unref?.(); } catch { /* ignore */ }
  try { fs.closeSync(outFd); } catch { /* child holds its own dup */ }
  live.set(run.runId, { proc, fd: outFd });
  db().prepare("UPDATE runs SET pid = ? WHERE run_id = ?").run(proc.pid ?? null, run.runId);
  run.pid = proc.pid;

  proc.on("exit", (code) => {
    const wasStopping = stopping.has(run.runId);
    stopping.delete(run.runId);
    live.delete(run.runId);
    const state: RunState = wasStopping ? "killed" : code === 0 ? "done" : "failed";
    const settled = settleRun(run.runId, state, {
      endedAt: Date.now(),
      exitCode: code ?? undefined,
      error: wasStopping ? "killed by parent" : undefined,
    });
    refreshWidget();
    if (!settled) return; // settled elsewhere (poller/kill); announcement already sent
    const type = state === "done" ? "job-done" : state === "killed" ? "job-killed" : "job-failed";
    try {
      pi.sendMessage(
        {
          customType: type,
          content: `**${job.label}** (${run.runId}) ${state}${settled.exitCode != null ? ` exit ${settled.exitCode}` : ""}\nLogs: ${effLog(settled)}`,
          display: false,
          details: { jobId: job.id, runId: run.runId, label: job.label, status: state, exitCode: settled.exitCode, logFile: effLog(settled), durationMs: (settled.endedAt ?? Date.now()) - settled.startedAt },
        },
        { triggerTurn: true },
      );
    } catch { /* parent gone; db keeps the result */ }
    // Auto-restart per policy.
    if (!wasStopping && (job.restart === "always" || (job.restart === "on-failure" && state === "failed"))) {
      if (job.maxRestarts === 0 || restartsUsed(job.id) < job.maxRestarts) {
        try { rerun(pi, undefined, job.id, "auto-restart"); } catch { /* ignore */ }
      }
    }
  });
  proc.on("error", (e: any) => {
    stopping.delete(run.runId);
    live.delete(run.runId);
    settleRun(run.runId, "failed", { endedAt: Date.now(), error: `launch failed: ${e.message ?? e}` });
    refreshWidget();
  });
}

function submit(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  opts: { command: string; label?: string; cwd?: string; env?: Record<string, string>; restart?: RestartPolicy; maxRestarts?: number; logFile?: string },
): { job: Job; run: Run } {
  if (!opts.command?.trim()) throw new Error("submit requires a non-empty command");
  const cwd = opts.cwd || (ctx as any)?.cwd || process.cwd();
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (e: any) {
    throw new Error(`cwd unavailable (${cwd}): ${e.message ?? e}`);
  }
  const sess = currentSession(ctx);
  const id = rid("job");
  const runId = rid("run");
  const now = Date.now();
  const job: Job = {
    id,
    label: opts.label?.slice(0, 80) || opts.command.split(/\s+/).slice(0, 6).join(" ").slice(0, 48),
    command: opts.command,
    cwd,
    env: opts.env,
    sessionId: sess.id,
    sessionFile: sess.file,
    restart: opts.restart ?? "no",
    maxRestarts: opts.maxRestarts ?? 10,
    createdAt: now,
    updatedAt: now,
  };
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  // Job-owned log (e.g. pi session jsonl): scheduler never writes here,
  // just reads it for logs/wakes. Resolve abs now; the job creates it.
  let customLog: string | undefined;
  if (opts.logFile?.trim()) {
    let p = opts.logFile.trim().replace(/^~(?=\/|$)/, os.homedir());
    if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
    customLog = p;
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* job owns it */ }
  }
  const run: Run = { runId, jobId: id, state: "running", startedAt: now, logFile: path.join(dir, "output.log"), ...(customLog ? { customLog } : {}) };
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare(`INSERT INTO jobs (id, label, command, cwd, env, session_id, session_file, restart, max_restarts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.label, job.command, job.cwd, job.env ? JSON.stringify(job.env) : null,
        job.sessionId ?? null, job.sessionFile ?? null, job.restart, job.maxRestarts, job.createdAt, job.updatedAt);
    d.prepare(`INSERT INTO runs (run_id, job_id, pid, state, exit_code, started_at, ended_at, log_file, custom_log, error)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run(run.runId, run.jobId, null, null, run.startedAt, null, run.logFile, run.customLog ?? null, null);
    d.exec("COMMIT;");
  } catch (e) {
    try { d.exec("ROLLBACK;"); } catch { /* ignore */ }
    throw e;
  }
  launchRun(pi, job, run);
  refreshWidget();
  try {
    pi.sendMessage({
      customType: "job-started",
      content: `Started **${job.label}** (${id})\nLogs: ${effLog(run)}`,
      display: true,
      details: { jobId: id, runId, label: job.label, logFile: effLog(run), startedAt: run.startedAt, pid: run.pid },
    });
  } catch { /* ignore */ }
  return { job, run };
}

function rerun(pi: ExtensionAPI, ctx: ExtensionContext | undefined, jobId: string, reason = "manual"): Run {
  const job = getJob(jobId);
  if (!job) throw new Error(`no such job '${jobId}'`);
  const runId = rid("run");
  fs.mkdirSync(runDir(runId), { recursive: true });
  const prevLog = latestRun(jobId)?.customLog;
  const now = Date.now();
  const run: Run = { runId, jobId, state: "running", startedAt: now, logFile: path.join(runDir(runId), "output.log"), error: reason === "manual" ? undefined : reason,
    ...(prevLog ? { customLog: prevLog } : {}) };
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(now, jobId);
    d.prepare(`INSERT INTO runs (run_id, job_id, pid, state, exit_code, started_at, ended_at, log_file, custom_log, error)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run(run.runId, run.jobId, null, null, run.startedAt, null, run.logFile, run.customLog ?? null, run.error ?? null);
    d.exec("COMMIT;");
  } catch (e) {
    try { d.exec("ROLLBACK;"); } catch { /* ignore */ }
    throw e;
  }
  launchRun(pi, { ...job, updatedAt: now }, run);
  refreshWidget();
  return run;
}

async function killRun(pi: ExtensionAPI, runId: string, reason = "killed by parent"): Promise<Run> {
  const run = getRun(runId);
  if (!run) throw new Error(`no such run '${runId}'`);
  if (run.state !== "running") return run;
  const h = live.get(runId);
  if (h) {
    stopping.add(runId);
    if (!run.error) db().prepare("UPDATE runs SET error = ? WHERE run_id = ? AND state = 'running'").run(reason, runId);
    killTree(h.proc, run.pid, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    for (;;) {
      const cur = getRun(runId);
      if (!cur || cur.state !== "running") return cur ?? run;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 200));
      if (!pidAlive(getRun(runId)?.pid)) break;
    }
    const cur = getRun(runId);
    if (cur?.state === "running" && pidAlive(cur.pid)) killTree(h.proc, cur.pid, "SIGKILL");
    return getRun(runId) ?? run;
  }
  // Adopted/dead-handle run: signal by pid, settle on next poll.
  if (pidAlive(run.pid)) {
    stopping.add(runId);
    if (!run.error) db().prepare("UPDATE runs SET error = ? WHERE run_id = ? AND state = 'running'").run(reason, runId);
    if (run.pid) killPidOnly(run.pid, "SIGTERM");
  }
  return getRun(runId) ?? run;
}

async function deleteJobOrRun(pi: ExtensionAPI, key: string): Promise<string> {
  const target = resolve(key);
  if (!target) throw new Error(`no such job or run '${key}'`);
  if (target.kind === "run") {
    const runId = target.runId as string;
    if (getRun(runId)?.state === "running") await killRun(pi, runId, "deleted by parent");
    db().prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    try { fs.rmSync(runDir(runId), { recursive: true, force: true }); } catch { /* ignore */ }
    refreshWidget();
    return runId;
  }
  const jobId = target.jobId;
  for (const r of runsOf(jobId)) {
    if (r.state === "running") await killRun(pi, r.runId, "deleted by parent");
  }
  const gone = runsOf(jobId).map((r) => r.runId);
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    const del = d.prepare("DELETE FROM runs WHERE run_id = ?");
    for (const runId of gone) del.run(runId);
    d.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    d.exec("COMMIT;");
  } catch (e) {
    try { d.exec("ROLLBACK;"); } catch { /* ignore */ }
    throw e;
  }
  for (const runId of gone) {
    try { fs.rmSync(runDir(runId), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  refreshWidget();
  try {
    pi.sendMessage({ customType: "job-note", content: `Deleted ${jobId}.`, display: false, details: { jobId, deleted: true } });
  } catch { /* ignore */ }
  return jobId;
}

/** Resolve a job id, run id, or unambiguous prefix to a concrete target.
 *  Explicit ids always search globally (cross-session opt-in). */
function resolve(key: string): { kind: "job" | "run"; jobId: string; runId?: string } | undefined {
  if (!key) return undefined;
  const d = db();
  const job = d.prepare("SELECT * FROM jobs WHERE id = ?").get(key) as any;
  if (job) return { kind: "job", jobId: job.id };
  const run = d.prepare("SELECT * FROM runs WHERE run_id = ?").get(key) as any;
  if (run) return { kind: "run", jobId: run.job_id, runId: run.run_id };
  const jHits = d.prepare("SELECT id FROM jobs WHERE id LIKE ? || '%'").all(key) as any[];
  const rHits = d.prepare("SELECT run_id, job_id FROM runs WHERE run_id LIKE ? || '%'").all(key) as any[];
  if (jHits.length + rHits.length > 1) throw new Error(`'${key}' matches multiple jobs/runs; use a longer id`);
  if (jHits.length === 1) return { kind: "job", jobId: jHits[0].id };
  if (rHits.length === 1) return { kind: "run", jobId: rHits[0].job_id, runId: rHits[0].run_id };
  return undefined;
}

function readTail(logFile: string, maxLines = 50): string {
  try {
    const raw = fs.readFileSync(logFile, "utf8");
    const lines = raw.split("\n");
    return lines.slice(-maxLines).join("\n").slice(-8000);
  } catch (e: any) {
    return `(unreadable log: ${e.message ?? e})`;
  }
}

// --- reconcile + poll (reboot survival) ---------------------------------------

function reconcile(pi: ExtensionAPI): string[] {
  const notes: string[] = [];
  const dead: string[] = [];
  for (const row of db().prepare("SELECT * FROM runs WHERE state = 'running'").all() as any[]) {
    const run = rowToRun(row);
    if (live.has(run.runId)) continue;
    if (pidAlive(run.pid)) continue; // alive from before; pid-only tracking until poll confirms death
    dead.push(run.runId);
  }
  if (!dead.length) {
    refreshWidget();
    return notes;
  }
  const now = Date.now();
  const claimed: string[] = [];
  for (const runId of dead) {
    if (settleRun(runId, "interrupted", { endedAt: now, error: "process gone (reboot or parent exit); pid not alive" })) {
      claimed.push(runId);
      notes.push(`${runId} interrupted`);
    }
  }
  for (const runId of claimed) {
    const run = getRun(runId);
    const job = run ? getJob(run.jobId) : undefined;
    if (job && (job.restart === "always" || job.restart === "on-failure")) {
      if (job.maxRestarts === 0 || restartsUsed(job.id) < job.maxRestarts) {
        try {
          const nr = rerun(pi, undefined, job.id, "auto-restart after interrupt");
          notes.push(`${job.id} relaunched as ${nr.runId}`);
        } catch (e: any) {
          notes.push(`${job.id} relaunch failed: ${e.message ?? e}`);
        }
      }
    }
  }
  refreshWidget();
  return notes;
}

function startPoller(pi: ExtensionAPI) {
  stopPoller();
  pollTimer = setInterval(() => {
    const now = Date.now();
    const settled: { runId: string; jobId: string; state: RunState; logFile: string; label: string }[] = [];
    for (const row of db().prepare("SELECT * FROM runs WHERE state = 'running'").all() as any[]) {
      const run = rowToRun(row);
      if (live.has(run.runId)) continue;
      if (pidAlive(run.pid)) continue;
      const s = settleRun(run.runId, stopping.has(run.runId) ? "killed" : "interrupted",
        { endedAt: now, error: "process exited while untracked (pid gone)" });
      stopping.delete(run.runId);
      if (s) settled.push({ runId: s.runId, jobId: s.jobId, state: s.state, logFile: effLog(s), label: getJob(s.jobId)?.label ?? s.jobId });
    }
    for (const s of settled) {
      try {
        pi.sendMessage(
          {
            customType: s.state === "killed" ? "job-killed" : "job-failed",
            content: `**${s.label}** (${s.runId}) ${s.state}\nLogs: ${s.logFile}`,
            display: false,
            details: { jobId: s.jobId, runId: s.runId, status: s.state, logFile: s.logFile },
          },
          { triggerTurn: true },
        );
      } catch { /* ignore */ }
      const job = getJob(s.jobId);
      if (job && (job.restart === "always" || (job.restart === "on-failure" && s.state === "interrupted"))) {
        if (job.maxRestarts === 0 || restartsUsed(job.id) < job.maxRestarts) {
          try { rerun(pi, undefined, job.id, "auto-restart after interrupt"); } catch { /* ignore */ }
        }
      }
    }
    if (settled.length) refreshWidget();
  }, POLL_MS);
  try { (pollTimer as any).unref?.(); } catch { /* ignore */ }
}
function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

// --- extension ------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  db(); // open + migrate

  const JobParams = Type.Object({
    action: StringEnum(["submit", "list", "get", "logs", "kill", "retry", "delete", "adopt"] as const, {
      description: "submit: run async (returns ids immediately). list/get/logs/kill/retry/delete/adopt take id (job or run id, prefix ok).",
    }),
    command: Type.Optional(Type.String({ description: "submit: shell command to run" })),
    id: Type.Optional(Type.String({ description: "job or run id for get/logs/kill/retry/delete/adopt" })),
    label: Type.Optional(Type.String({ description: "submit: short label" })),
    cwd: Type.Optional(Type.String({ description: "submit: working dir, else session cwd" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "submit: extra env vars" })),
    restart: Type.Optional(Type.String({ description: "submit: restart policy no|on-failure|always (default no)" })),
    maxRestarts: Type.Optional(Type.Number({ description: "submit: cap on auto-restarts, 0=unlimited (default 10)" })),
    logFile: Type.Optional(Type.String({ description: "submit: job-owned log path (e.g. pi session jsonl) — logs reads this instead of captured stdout" })),
    scope: Type.Optional(Type.String({ description: "list: mine|all|orphans (default mine)" })),
    state: Type.Optional(Type.String({ description: "list: filter by run state" })),
    tail: Type.Optional(Type.Number({ description: "logs: last N lines (default 50, max 200)" })),
  });

  const tool = defineTool({
    name: "job",
    label: "Job",
    description:
      "Persistent cross-platform job scheduler. submit runs any shell command async as a detached process (returns job+run ids immediately, survives parent exit); completion wakes you with exit code + log path — read the log yourself, output is never inlined. NEVER sleep/wait/block for a job — end your turn and the wake will find you. list/get/logs peek without blocking (list defaults to your session; all/orphans opt in). kill stops (SIGTERM then SIGKILL, log kept). retry launches a fresh run. delete removes job+runs+files. Jobs persist across reboots (dead pids become interrupted and relaunch per restart policy). logFile: if the command writes its own log, pass its path — logs/wakes read it instead of captured stdout (scheduler never writes there). Recipe — pi subagent: submit `pi --session <path>.jsonl -p \"<task>\"` with logFile set to the same path for live structured visibility via logs; continue it later with a new submit reusing the same --session path.",
    parameters: JobParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ectx = ctx as ExtensionToolContext;
      try {
        switch (params.action) {
          case "submit": {
            if (signal?.aborted) return errResult("job submit aborted before start");
            const restart = (params.restart ?? "no") as RestartPolicy;
            if (!["no", "on-failure", "always"].includes(restart)) return errResult("restart must be no|on-failure|always");
            const { job, run } = submit(pi, ectx, {
              command: params.command ?? "",
              label: params.label,
              cwd: params.cwd,
              env: params.env as Record<string, string> | undefined,
              restart,
              maxRestarts: params.maxRestarts,
              logFile: params.logFile,
            });
            return textResult(`Started **${job.label}** job=${job.id} run=${run.runId}. Logs: ${effLog(run)}. Async — completion wakes you.`, { jobId: job.id, runId: run.runId, logFile: effLog(run) });
          }
          case "list": {
            const sess = currentSession(ectx);
            const jobs = listJobs(sess.id, params.scope ?? "mine", params.state);
            if (!jobs.length) return textResult("No jobs.", { count: 0 });
            return textResult(jobs.map(jobSummary).join("\n"), { count: jobs.length, jobs: jobs.map((j) => ({ id: j.id, label: j.label })) });
          }
          case "get": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            if (t.kind === "run") {
              const r = getRun(t.runId!);
              if (!r) return errResult(`no such run '${params.id ?? ""}'`);
              return textResult(runSummary(r), { jobId: r.jobId, runId: r.runId, status: r.state });
            }
            const j = getJob(t.jobId);
            if (!j) return errResult(`no such job '${params.id ?? ""}'`);
            const runs = runsOf(j.id, 5);
            return textResult(`${jobSummary(j)}\ncommand: ${j.command}\ncwd: ${j.cwd}` + (runs.length ? `\n${runs.map(runSummary).join("\n")}` : ""), { jobId: j.id });
          }
          case "logs": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            const run = t.kind === "run" ? getRun(t.runId!) : latestRun(t.jobId);
            if (!run) return errResult(`no runs for '${params.id}' yet`);
            const tail = Math.min(Math.max(params.tail ?? 50, 1), 200);
            return textResult(`${run.runId} (${run.state})\n${readTail(effLog(run), tail)}`, { jobId: run.jobId, runId: run.runId, status: run.state, logFile: effLog(run) });
          }
          case "kill": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            if (t.kind === "job") {
              const targets = runsOf(t.jobId).filter((r) => r.state === "running");
              if (!targets.length) return textResult(`${t.jobId} has no running runs.`, { jobId: t.jobId });
              for (const r of targets) await killRun(pi, r.runId);
              return textResult(`Killed ${targets.length} run(s) of ${t.jobId}. Logs kept.`, { jobId: t.jobId });
            }
            const r = await killRun(pi, t.runId!);
            return textResult(`${r.runId} ${r.state}. Logs: ${effLog(r)}`, { runId: r.runId, status: r.state });
          }
          case "retry": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            const run = rerun(pi, ectx, t.jobId);
            return textResult(`Relaunched ${t.jobId} as ${run.runId}. Logs: ${effLog(run)}`, { jobId: t.jobId, runId: run.runId });
          }
          case "delete": {
            const id = await deleteJobOrRun(pi, params.id ?? "");
            return textResult(`Deleted ${id}. Files removed.`, { id, deleted: true });
          }
          case "adopt": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            const sess = currentSession(ectx);
            db().prepare("UPDATE jobs SET session_id = ?, session_file = ?, updated_at = ? WHERE id = ?")
              .run(sess.id ?? null, sess.file ?? null, Date.now(), t.jobId);
            return textResult(`Adopted ${t.jobId} into this session.`, { jobId: t.jobId });
          }
        }
      } catch (e: any) {
        return errResult(`job ${params.action} failed: ${e.message ?? e}`);
      }
    },
  });
  pi.registerTool(tool);

  pi.registerMessageRenderer("job-started", (m) => new Text(`◌ ${(m as any).details?.label ?? "job"} (${(m as any).details?.jobId ?? ""}) — running`, 0, 0));
  pi.registerMessageRenderer("job-done", (m) => new Text(`● ${(m as any).details?.label ?? "job"} (${(m as any).details?.runId ?? ""}) — done`, 0, 0));
  pi.registerMessageRenderer("job-failed", (m) => new Text(`■ ${(m as any).details?.label ?? "job"} (${(m as any).details?.runId ?? ""}) — ${(m as any).details?.status ?? "failed"}`, 0, 0));
  pi.registerMessageRenderer("job-killed", (m) => new Text(`■ ${(m as any).details?.label ?? "job"} (${(m as any).details?.runId ?? ""}) — killed`, 0, 0));

  const note = (content: string, details?: unknown) =>
    pi.sendMessage({ customType: "job-note", content, display: true, details });

  pi.registerCommand("jobs", {
    description: "List jobs (scope: /jobs [mine|all|orphans], default mine)",
    handler: async (args, ctx) => {
      const scope = args.trim().split(/\s+/)[0] || "mine";
      const sess = currentSession(ctx as ExtensionContext);
      const jobs = listJobs(sess.id, scope);
      note(jobs.length ? jobs.map(jobSummary).join("\n") : "No jobs.", { count: jobs.length });
    },
  });
  pi.registerCommand("job-kill", {
    description: "Kill a job/run: /job-kill <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) { note("Usage: /job-kill <id>"); return; }
      try {
        const t = resolve(id);
        if (!t) { note(`no such job or run '${id}'`); return; }
        if (t.kind === "job") {
          for (const r of runsOf(t.jobId).filter((r) => r.state === "running")) await killRun(pi, r.runId);
          note(`Killed running runs of ${t.jobId}.`);
        } else {
          await killRun(pi, t.runId!);
          note(`Kill signaled on ${t.runId!}.`);
        }
      } catch (e: any) { note(e.message ?? String(e)); }
    },
  });
  pi.registerCommand("job-logs", {
    description: "Show job/run logs: /job-logs <id> [lines]",
    handler: async (args) => {
      const [id, n] = args.trim().split(/\s+/);
      if (!id) { note("Usage: /job-logs <id> [lines]"); return; }
      try {
        const t = resolve(id);
        if (!t) { note(`no such job or run '${id}'`); return; }
        const run = t.kind === "run" ? getRun(t.runId!) : latestRun(t.jobId);
        if (!run) { note(`no runs for '${id}'`); return; }
        note(`${run.runId} (${run.state})\n${readTail(effLog(run), Math.min(Number(n) || 50, 200))}`);
      } catch (e: any) { note(e.message ?? String(e)); }
    },
  });
  pi.registerCommand("job-retry", {
    description: "Relaunch a job: /job-retry <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) { note("Usage: /job-retry <id>"); return; }
      try {
        const t = resolve(id);
        if (!t) { note(`no such job or run '${id}'`); return; }
        const run = rerun(pi, undefined, t.jobId);
        note(`Relaunched as ${run.runId}. Logs: ${effLog(run)}`);
      } catch (e: any) { note(e.message ?? String(e)); }
    },
  });
  pi.registerCommand("job-delete", {
    description: "Delete a job/run and its files: /job-delete <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) { note("Usage: /job-delete <id>"); return; }
      try { note(`Deleted ${await deleteJobOrRun(pi, id)}.`); }
      catch (e: any) { note(e.message ?? String(e)); }
    },
  });

  pi.on("session_start", (_ev, ctx) => {
    tuiCtx = ctx;
    db();
    const notes = reconcile(pi);
    startPoller(pi);
    refreshWidget();
    if (notes.length) {
      try {
        pi.sendMessage({ customType: "job-note", content: `Reconciled after restart:\n${notes.join("\n")}`, display: true, details: { reconciled: notes } });
      } catch { /* ignore */ }
    }
  });
  pi.on("session_shutdown", () => {
    // Jobs SURVIVE shutdown: detached + direct-to-file logs, every mutation
    // is already in SQLite. Nothing to persist; just stop polling.
    stopPoller();
    live.clear();
    stopping.clear();
    refreshWidget();
  });
}
