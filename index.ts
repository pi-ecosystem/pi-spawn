/**
 * jobs — generic cross-platform job scheduler for pi (pi-jobs package).
 *
 * A job is any shell command. No pi-specific runtime: no RPC, no steering,
 * no transcripts. The ONLY pi-specific bits are (1) this runs as a pi
 * extension and (2) jobs are mapped to the pi session that submitted them.
 *
 * Persistence: registry (jobs + runs) lives on disk as JSON, logs per run.
 * Reboot kills processes (true for anything) but data survives: on the next
 * `session_start` we reconcile `running` runs against live pids — dead ones
 * become `interrupted` and relaunch per their restart policy.
 *
 * Portable resume = rehydrate when pi starts. True boot-without-login resume
 * needs OS hooks (systemd/launchd/Task Scheduler) — later, behind this API.
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

interface Registry {
  version: 1;
  jobs: Record<string, Job>;
  runs: Record<string, Run>;
}

const POLL_MS = 5_000;
const KILL_GRACE_MS = 5_000;

function jobsRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "jobs");
}
function registryPath(): string {
  return path.join(jobsRoot(), "registry.json");
}
function runDir(runId: string): string {
  return path.join(jobsRoot(), "runs", runId);
}

let counter = 0;
function rid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
// --- registry (disk = source of truth) -------------------------------------

let reg: Registry = { version: 1, jobs: {}, runs: {} };

// Live handles only exist for runs started by THIS process. Anything else
// (previous boot, other session) is managed by pid + log file only.
const live = new Map<string, { proc: ChildProcess; fd: number }>();
const stopping = new Set<string>(); // runIds being killed -> settle as killed
let pollTimer: NodeJS.Timeout | undefined;
let tuiCtx: ExtensionContext | undefined;

function load(): void {
  try {
    fs.mkdirSync(path.join(jobsRoot(), "runs"), { recursive: true });
  } catch { /* ignore */ }
  try {
    const raw = fs.readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (parsed && parsed.jobs && parsed.runs) reg = parsed;
  } catch { /* first run: start empty */ }
}

function save(): void {
  try {
    fs.mkdirSync(jobsRoot(), { recursive: true });
    const tmp = path.join(jobsRoot(), `registry.tmp.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, registryPath());
  } catch { /* best effort; memory still works this session */ }
}

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
  const j = reg.jobs[r.jobId];
  const label = j?.label ?? r.jobId;
  const exit = r.exitCode != null ? ` · exit ${r.exitCode}` : "";
  const err = r.error ? ` — ${r.error.slice(0, 200)}` : "";
  return `${r.runId} [${label}] ${r.state} · ${fmtElapsed(r.startedAt, r.endedAt)}${exit}${err}\nLogs: ${effLog(r)}`;
}

function jobSummary(j: Job): string {
  const runs = Object.values(reg.runs).filter((r) => r.jobId === j.id);
  const last = runs.sort((a, b) => b.startedAt - a.startedAt)[0];
  const sess = j.sessionId ? ` · session ${j.sessionId.slice(0, 12)}` : "";
  return `${j.id} [${j.label}] restart=${j.restart}${sess} · ${runs.length} run${runs.length === 1 ? "" : "s"}${last ? ` · last: ${last.state}` : ""}`;
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
    const n = Object.values(reg.runs).filter((r) => r.state === "running").length;
    tuiCtx.ui.setWidget("jobs", n ? [`◌ ${n} job${n === 1 ? "" : "s"} running`, ""] : undefined);
  } catch { /* headless host */ }
}

function restartsUsed(jobId: string): number {
  return Object.values(reg.runs).filter((r) => r.jobId === jobId).length - 1; // runs beyond the first
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
  run.pid = proc.pid;
  run.state = "running";
  live.set(run.runId, { proc, fd: outFd });

  proc.on("exit", (code) => {
    const wasStopping = stopping.has(run.runId);
    stopping.delete(run.runId);
    live.delete(run.runId);
    run.endedAt = Date.now();
    run.exitCode = code ?? undefined;
    run.state = wasStopping ? "killed" : code === 0 ? "done" : "failed";
    if (wasStopping && !run.error) run.error = "killed by parent";
    save();
    refreshWidget();
    const type = run.state === "done" ? "job-done" : run.state === "killed" ? "job-killed" : "job-failed";
    try {
      pi.sendMessage(
        {
          customType: type,
          content: `**${job.label}** (${run.runId}) ${run.state}${run.exitCode != null ? ` exit ${run.exitCode}` : ""}\nLogs: ${effLog(run)}`,
          display: false,
          details: { jobId: job.id, runId: run.runId, label: job.label, status: run.state, exitCode: run.exitCode, logFile: effLog(run), durationMs: run.endedAt - run.startedAt },
        },
        { triggerTurn: true },
      );
    } catch { /* parent gone; registry keeps the result */ }
    // Auto-restart per policy.
    if (!wasStopping && (job.restart === "always" || (job.restart === "on-failure" && run.state === "failed"))) {
      if (job.maxRestarts === 0 || restartsUsed(job.id) < job.maxRestarts) {
        try { rerun(pi, undefined, job.id, "auto-restart"); } catch { /* ignore */ }
      }
    }
  });
  proc.on("error", (e: any) => {
    stopping.delete(run.runId);
    live.delete(run.runId);
    run.endedAt = Date.now();
    run.state = "failed";
    run.error = `launch failed: ${e.message ?? e}`;
    save();
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
  const run: Run = { runId, jobId: id, state: "running", startedAt: Date.now(), logFile: path.join(dir, "output.log"), ...(customLog ? { customLog } : {}) };
  reg.jobs[id] = job;
  reg.runs[runId] = run;
  save();
  launchRun(pi, job, run);
  save();
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
  const job = reg.jobs[jobId];
  if (!job) throw new Error(`no such job '${jobId}'`);
  const runId = rid("run");
  fs.mkdirSync(runDir(runId), { recursive: true });
  const prevLog = Object.values(reg.runs).filter((r) => r.jobId === jobId).sort((a, b) => b.startedAt - a.startedAt)[0]?.customLog;
  const run: Run = { runId, jobId, state: "running", startedAt: Date.now(), logFile: path.join(runDir(runId), "output.log"), error: reason === "manual" ? undefined : reason,
    ...(prevLog ? { customLog: prevLog } : {}) };
  job.updatedAt = Date.now();
  reg.runs[runId] = run;
  save();
  launchRun(pi, job, run);
  save();
  refreshWidget();
  return run;
}

async function killRun(pi: ExtensionAPI, runId: string, reason = "killed by parent"): Promise<Run> {
  const run = reg.runs[runId];
  if (!run) throw new Error(`no such run '${runId}'`);
  if (run.state !== "running") return run;
  const h = live.get(runId);
  if (h) {
    stopping.add(runId);
    run.error = reason;
    killTree(h.proc, run.pid, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && run.state === "running") {
      await new Promise((r) => setTimeout(r, 200));
      if (!pidAlive(run.pid)) break;
    }
    if (run.state === "running" && pidAlive(run.pid)) killTree(h.proc, run.pid, "SIGKILL");
    save();
    return run;
  }
  // Adopted/dead-handle run: signal by pid, settle on next poll.
  if (pidAlive(run.pid)) {
    stopping.add(runId);
    run.error = reason;
    killPidOnly(run.pid!, "SIGTERM");
    save();
  }
  return run;
}

async function deleteJobOrRun(pi: ExtensionAPI, key: string): Promise<string> {
  const target = resolve(key);
  if (!target) throw new Error(`no such job or run '${key}'`);
  if (target.kind === "run") {
    const run = reg.runs[target.runId as string]!;
    if (run.state === "running") await killRun(pi, run.runId, "deleted by parent");
    delete reg.runs[run.runId];
    try { fs.rmSync(runDir(run.runId), { recursive: true, force: true }); } catch { /* ignore */ }
    save();
    refreshWidget();
    return run.runId;
  }
  const job = reg.jobs[target.jobId]!;
  for (const r of Object.values(reg.runs).filter((r) => r.jobId === job.id && r.state === "running")) {
    await killRun(pi, r.runId, "deleted by parent");
  }
  for (const r of Object.values(reg.runs).filter((r) => r.jobId === job.id)) {
    delete reg.runs[r.runId];
    try { fs.rmSync(runDir(r.runId), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete reg.jobs[job.id];
  save();
  refreshWidget();
  try {
    pi.sendMessage({ customType: "job-note", content: `Deleted ${job.id}.`, display: false, details: { jobId: job.id, deleted: true } });
  } catch { /* ignore */ }
  return job.id;
}

/** Resolve a job id, run id, or unambiguous prefix to a concrete target. */
function resolve(key: string): { kind: "job" | "run"; jobId: string; runId?: string } | undefined {
  if (!key) return undefined;
  if (reg.jobs[key]) return { kind: "job", jobId: key };
  if (reg.runs[key]) return { kind: "run", jobId: reg.runs[key].jobId, runId: key };
  const jHits = Object.keys(reg.jobs).filter((id) => id.startsWith(key));
  const rHits = Object.keys(reg.runs).filter((id) => id.startsWith(key));
  if (jHits.length + rHits.length > 1) throw new Error(`'${key}' matches multiple jobs/runs; use a longer id`);
  if (jHits.length === 1) return { kind: "job", jobId: jHits[0] };
  if (rHits.length === 1) return { kind: "run", jobId: reg.runs[rHits[0]].jobId, runId: rHits[0] };
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
  for (const run of Object.values(reg.runs)) {
    if (run.state !== "running" || live.has(run.runId)) continue;
    if (pidAlive(run.pid)) continue; // alive from before; pid-only tracking until poll confirms death
    run.state = "interrupted";
    run.endedAt = Date.now();
    run.error = "process gone (reboot or parent exit); pid not alive";
    notes.push(`${run.runId} interrupted`);
    const job = reg.jobs[run.jobId];
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
  if (notes.length) save();
  refreshWidget();
  return notes;
}

function startPoller(pi: ExtensionAPI) {
  stopPoller();
  pollTimer = setInterval(() => {
    let changed = false;
    for (const run of Object.values(reg.runs)) {
      if (run.state !== "running" || live.has(run.runId)) continue;
      if (pidAlive(run.pid)) continue;
      run.state = stopping.has(run.runId) ? "killed" : "interrupted";
      stopping.delete(run.runId);
      run.endedAt = Date.now();
      if (!run.error) run.error = "process exited while untracked (pid gone)";
      changed = true;
      const job = reg.jobs[run.jobId];
      try {
        pi.sendMessage(
          {
            customType: run.state === "killed" ? "job-killed" : "job-failed",
            content: `**${job?.label ?? run.jobId}** (${run.runId}) ${run.state}\nLogs: ${effLog(run)}`,
            display: false,
            details: { jobId: run.jobId, runId: run.runId, status: run.state, logFile: effLog(run) },
          },
          { triggerTurn: true },
        );
      } catch { /* ignore */ }
      if (job && (job.restart === "always" || (job.restart === "on-failure" && run.state === "interrupted"))) {
        if (job.maxRestarts === 0 || restartsUsed(job.id) < job.maxRestarts) {
          try { rerun(pi, undefined, job.id, "auto-restart after interrupt"); } catch { /* ignore */ }
        }
      }
    }
    if (changed) { save(); refreshWidget(); }
  }, POLL_MS);
  try { (pollTimer as any).unref?.(); } catch { /* ignore */ }
}
function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

// --- extension ------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  load();

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
    scope: Type.Optional(Type.String({ description: "list: mine|all|orphans (default all)" })),
    state: Type.Optional(Type.String({ description: "list: filter by run state" })),
    tail: Type.Optional(Type.Number({ description: "logs: last N lines (default 50, max 200)" })),
  });

  const tool = defineTool({
    name: "job",
    label: "Job",
    description:
      "Persistent cross-platform job scheduler. submit runs any shell command async as a detached process (returns job+run ids immediately, survives parent exit); completion wakes you with exit code + log path — read the log yourself, output is never inlined. NEVER sleep/wait/block for a job — end your turn and the wake will find you. list/get/logs peek without blocking. kill stops (SIGTERM then SIGKILL, log kept). retry launches a fresh run. delete removes job+runs+files. Jobs persist on disk and resume tracking across reboots (dead pids become interrupted and relaunch per restart policy). logFile: if the command writes its own log, pass its path — logs/wakes read it instead of captured stdout (scheduler never writes there). Recipe — pi subagent: submit `pi --session <path>.jsonl -p \"<task>\"` with logFile set to the same path for live structured visibility via logs; continue it later with a new submit reusing the same --session path.",
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
            const scope = params.scope ?? "all";
            const sess = currentSession(ectx);
            let jobs = Object.values(reg.jobs);
            if (scope === "mine") jobs = jobs.filter((j) => j.sessionId && j.sessionId === sess.id);
            else if (scope === "orphans") jobs = jobs.filter((j) => !j.sessionId || j.sessionId !== sess.id);
            if (params.state) {
              jobs = jobs.filter((j) => Object.values(reg.runs).some((r) => r.jobId === j.id && r.state === params.state));
            }
            if (!jobs.length) return textResult("No jobs.", { count: 0 });
            return textResult(jobs.map(jobSummary).join("\n"), { count: jobs.length, jobs: jobs.map((j) => ({ id: j.id, label: j.label })) });
          }
          case "get": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            if (t.kind === "run") {
              const r = reg.runs[t.runId!]!;
              return textResult(runSummary(r), { jobId: r.jobId, runId: r.runId, status: r.state });
            }
            const j = reg.jobs[t.jobId]!;
            const runs = Object.values(reg.runs).filter((r) => r.jobId === j.id).sort((a, b) => b.startedAt - a.startedAt);
            return textResult(`${jobSummary(j)}\ncommand: ${j.command}\ncwd: ${j.cwd}` + (runs.length ? `\n${runs.slice(0, 5).map(runSummary).join("\n")}` : ""), { jobId: j.id });
          }
          case "logs": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            const runId = t.kind === "run" ? t.runId! : Object.values(reg.runs).filter((r) => r.jobId === t.jobId).sort((a, b) => b.startedAt - a.startedAt)[0]?.runId;
            if (!runId || !reg.runs[runId]) return errResult(`no runs for '${params.id}' yet`);
            const run = reg.runs[runId];
            const tail = Math.min(Math.max(params.tail ?? 50, 1), 200);
            return textResult(`${runId} (${run.state})\n${readTail(effLog(run), tail)}`, { jobId: run.jobId, runId, status: run.state, logFile: effLog(run) });
          }
          case "kill": {
            const t = resolve(params.id ?? "");
            if (!t) return errResult(`no such job or run '${params.id ?? ""}'`);
            if (t.kind === "job") {
              const targets = Object.values(reg.runs).filter((r) => r.jobId === t.jobId && r.state === "running");
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
            const job = reg.jobs[t.jobId]!;
            const sess = currentSession(ectx);
            job.sessionId = sess.id;
            job.sessionFile = sess.file;
            job.updatedAt = Date.now();
            save();
            return textResult(`Adopted ${job.id} into this session.`, { jobId: job.id });
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
    description: "List jobs (scope: /jobs [mine|all|orphans])",
    handler: async (args, ctx) => {
      const scope = args.trim().split(/\s+/)[0] || "all";
      const sess = currentSession(ctx as ExtensionContext);
      let jobs = Object.values(reg.jobs);
      if (scope === "mine") jobs = jobs.filter((j) => j.sessionId && j.sessionId === sess.id);
      else if (scope === "orphans") jobs = jobs.filter((j) => !j.sessionId || j.sessionId !== sess.id);
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
          for (const r of Object.values(reg.runs).filter((r) => r.jobId === t.jobId && r.state === "running")) await killRun(pi, r.runId);
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
        const runId = t.kind === "run" ? t.runId! : Object.values(reg.runs).filter((r) => r.jobId === t.jobId).sort((a, b) => b.startedAt - a.startedAt)[0]?.runId;
        if (!runId || !reg.runs[runId]) { note(`no runs for '${id}'`); return; }
        note(`${runId} (${reg.runs[runId].state})\n${readTail(effLog(reg.runs[runId]), Math.min(Number(n) || 50, 200))}`);
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
    load();
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
    // Jobs SURVIVE shutdown: detached + direct-to-file logs. Just persist + stop polling.
    stopPoller();
    save();
    live.clear();
    stopping.clear();
    refreshWidget();
  });
}
