/**
 * spawn — subagents for pi (pi-spawn package).
 *
 * Install as a Pi package (`pi install <this-dir>`) or load directly:
 * `pi --extension ./index.ts`.
 *
 * One primitive: a pi session. A subagent is a real `pi --mode rpc`
 * child process driven over RPC (prompt / steer / followUp / abort /
 * set_model / set_thinking_level / get_last_assistant_text). Async-first:
 * `start` returns an id immediately; completion wakes the parent with a
 * `spawn-done` message. Children die with the parent session. No orphans.
 *
 * Boundaries (see SPAWN.md): host-level stays host-level, children are
 * headless, no TUI chrome, extension scoping is selection-from-loaded.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const MAX_DEPTH = 3;
const CMD_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

type ChildState = "running" | "done" | "stopped" | "failed";

interface Child {
  id: string;
  thread: string;
  kind: "agent" | "proc";
  label: string;
  task: string;
  command?: string;
  logFile?: string;
  logStream?: fs.WriteStream;
  exitCode?: number;
  stopping?: string;
  proc: ChildProcess;
  state: ChildState;
  startedAt: number;
  endedAt?: number;
  error?: string;
  finalText?: string;
  seq: number;
  pending: Map<string, { res: (v: any) => void; rej: (e: any) => void; timer: any }>;
  buf: string;
}

const children = new Map<string, Child>();
let counter = 0;

function piBin(): string {
  return process.env.PI_BIN || "pi";
}

function spawnRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "spawn-sessions");
}

function validRunId(id: string): boolean {
  return !!id && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

function sessionFileFor(runId: string): string {
  if (!validRunId(runId)) throw new Error(`invalid run id '${runId}'`);
  const dir = path.join(spawnRoot(), runId);
  let found: string | null = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    if (found) throw new Error(`ambiguous spawn dir for '${runId}'`);
    found = path.join(dir, f);
  }
  if (!found) throw new Error(`no session file for '${runId}'`);
  return found;
}

function thisFile(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

function depth(): number {
  return Number.parseInt(process.env.PI_SPAWN_DEPTH || "0", 10) || 0;
}

function rid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError: true as const,
  };
}

function fmtElapsed(c: Child): string {
  const ms = (c.endedAt ?? Date.now()) - c.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function summary(c: Child): string {
  if (c.kind === "proc") {
    const exit = c.exitCode != null ? ` · exit ${c.exitCode}` : "";
    const err = c.error ? ` — error: ${c.error.slice(0, 300)}` : "";
    const log = c.logFile ? `\nLogs: ${c.logFile}` : "";
    return `${c.id} [proc ${c.label}] ${c.state} · ${fmtElapsed(c)}${exit}${err}${log}`;
  }
  const tail = c.finalText ? ` — ${c.finalText.slice(0, 200)}` : "";
  const err = c.error ? ` — error: ${c.error.slice(0, 300)}` : "";
  return `${c.id} [${c.label}] ${c.state} · ${fmtElapsed(c)}${tail}${err}`;
}

// --- terminal (TUI) rendering ------------------------------------------------
// The desktop app draws its own cards; the interactive CLI would otherwise
// show every spawn message as a generic purple box. These one-line status
// renderers give it the same at-a-glance state. Static text by design:
// the TUI re-renders on updates, so no ticking or morphing is needed.
// spawn-note keeps the default box (lists read fine as markdown).

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusElapsed(d: any): string {
  const ms = typeof d.durationMs === "number" ? d.durationMs
    : typeof d.startedAt === "number" ? Date.now() - d.startedAt : -1;
  return ms < 0 ? "" : ` · ${fmtMs(ms)}`;
}

function idLabel(d: any): { id: string; label: string } {
  const id = typeof d.id === "string" ? d.id : "";
  const label = typeof d.label === "string" && d.label ? d.label : id;
  return { id, label };
}

function agentLine(state: string, d: any): string {
  const { id, label } = idLabel(d);
  if (state === "running") return `◌ ${label} (${id}) — subagent running${statusElapsed(d)}`;
  if (state === "done") return `● ${label} (${id}) — done${statusElapsed(d)}`;
  return `■ ${label} (${id}) — ${state}${statusElapsed(d)}`;
}

function procLine(state: string, d: any): string {
  const { id, label } = idLabel(d);
  const exit = typeof d.exitCode === "number" ? ` · exit ${d.exitCode}` : "";
  if (state === "running") return `◌ ${label} (${id}) — proc running${statusElapsed(d)}`;
  if (state === "done") return `● ${label} (${id}) — done${exit}${statusElapsed(d)}`;
  return `■ ${label} (${id}) — ${state}${exit}${statusElapsed(d)}`;
}

function statusOf(d: any, fallback: string): string {
  return typeof d.status === "string" ? d.status : fallback;
}

// --- editor widget: live counts ------------------------------------------------
// The CLI equivalent of the desktop badge: one quiet line above the
// editor while anything runs, gone when idle. TUI-only by design
// (mode guard); other modes never see it.
let tuiCtx: ExtensionContext | undefined;

function refreshWidget() {
  try {
    if (!tuiCtx || tuiCtx.mode !== "tui") return;
    const rs = [...children.values()].filter((c) => c.state === "running");
    if (!rs.length) {
      tuiCtx.ui.setWidget("spawn", undefined);
      return;
    }
    const na = rs.filter((c) => c.kind !== "proc").length;
    const np = rs.length - na;
    const bits: string[] = [];
    if (na) bits.push(`${na} agent${na === 1 ? "" : "s"}`);
    if (np) bits.push(`${np} proc${np === 1 ? "" : "es"}`);
    tuiCtx.ui.setWidget("spawn", [`◌ ${bits.join(" · ")} running`]);
  } catch { /* headless host or torn-down UI */ }
}

// --- minimal RPC client over the child process ----------------------------

function sendCmd(c: Child, obj: any, timeoutMs = CMD_TIMEOUT_MS): Promise<any> {
  const id = `s${++c.seq}`;
  obj.id = id;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      rej(new Error(`child ${c.id}: command timed out (${obj.type})`));
    }, timeoutMs);
    c.pending.set(id, { res, rej, timer });
    try {
      c.proc.stdin!.write(JSON.stringify(obj) + "\n");
    } catch (e: any) {
      clearTimeout(timer);
      c.pending.delete(id);
      rej(new Error(`child ${c.id}: write failed: ${e.message ?? e}`));
    }
  });
}

function routeLine(c: Child, line: string, onSettled: () => void) {
  if (!line.trim()) return;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return; // diagnostics go to stderr, stdout is protocol
  }
  if (rec && rec.type === "response" && typeof rec.id === "string") {
    const p = c.pending.get(rec.id);
    if (!p) return;
    c.pending.delete(rec.id);
    clearTimeout(p.timer);
    if (rec.success) p.res(rec.data);
    else p.rej(new Error(rec.error ?? "child command failed"));
    return;
  }
  if (rec && rec.type === "agent_settled") {
    onSettled();
  }
}

// --- child lifecycle -------------------------------------------------------

async function startChild(
  pi: ExtensionAPI,
  parentCwd: string,
  opts: {
    task: string;
    label?: string;
    model?: string;
    thinking?: string;
    tools?: string;
    excludeTools?: string;
    cwd?: string;
    nested?: boolean;
    isolated?: boolean;
    continueFrom?: string;
  },
): Promise<{ child: Child; continuedFrom?: string }> {
  const d = depth();
  if (d >= MAX_DEPTH) {
    throw new Error(`spawn depth limit reached (${MAX_DEPTH}); refusing to nest deeper`);
  }
  if (!opts.task?.trim()) throw new Error("spawn start requires a non-empty task");

  const cwd = opts.cwd || parentCwd;
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (e: any) {
    throw new Error(`spawn cwd unavailable (${cwd}): ${e.message ?? e}`);
  }

  const id = rid("spawn");
  const continuedFrom = opts.continueFrom?.trim() || undefined;
  let label = opts.label?.slice(0, 80) || "";
  // Threads: a continuation reopens the SAME conversation — same run
  // dir, same session file appended, same UI row. Only the run id is new.
  // The original is never copied or moved; history just grows.
  let dir: string;
  let thread = id;
  let resumeFile: string | null = null;
  if (continuedFrom) {
    const prev = resolveChild(continuedFrom);
    if (prev && prev.state === "running") {
      throw new Error(`${continuedFrom} is still running; steer or follow up instead of continuing`);
    }
    resumeFile = sessionFileFor(continuedFrom);
    dir = path.dirname(resumeFile);
    thread = continuedFrom;
    if (!label) label = prev?.label ?? continuedFrom;
  } else {
    dir = path.join(spawnRoot(), id);
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!label) label = opts.task.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);

  const args = ["--mode", "rpc", "--session-dir", dir];
  if (resumeFile) args.push("--session", resumeFile);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.tools) args.push("--tools", opts.tools);
  if (opts.excludeTools) args.push("--exclude-tools", opts.excludeTools);
  // Desktop app prompt transport: pi-desktop sets PI_DESKTOP_APP_PROMPT_TEXT
  // in the parent env (CLI flags don't propagate to grandchildren; env does).
  // Explicit flag, so it applies even to --isolated children. Inherited
  // further down automatically since every level spreads process.env.
  const appPrompt = process.env.PI_DESKTOP_APP_PROMPT_TEXT;
  if (appPrompt && appPrompt.trim()) args.push("--append-system-prompt", appPrompt);
  if (opts.isolated) args.push("--no-extensions", "--no-skills", "--no-mcp", "--no-context-files");
  const self = thisFile();
  if (opts.nested !== false && self) args.push("--extension", self);

  const proc = nodeSpawn(piBin(), args, {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PI_SPAWN_DEPTH: String(d + 1) },
  });

  const c: Child = {
    id, thread, kind: "agent", label, task: opts.task, proc,
    state: "running", startedAt: Date.now(),
    seq: 0, pending: new Map(), buf: "",
  };

  const onSettled = () => void finishChild(pi, c, "done").catch(() => {});
  proc.stdout!.on("data", (chunk: Buffer) => {
    c.buf += chunk.toString("utf8");
    const lines = c.buf.split("\n");
    c.buf = lines.pop() ?? "";
    for (const line of lines) {
      // Split strictly on LF (U+2028/29 are legal inside JSON strings).
      routeLine(c, line.replace(/\r$/, ""), onSettled);
    }
  });
  proc.on("exit", () => {
    if (c.state === "running") void finishChild(pi, c, "failed", "child process exited").catch(() => {});
  });
  proc.on("error", (e: any) => {
    if (c.state === "running") void finishChild(pi, c, "failed", `spawn failed: ${e.message ?? e}`).catch(() => {});
  });

  children.set(id, c);
  try {
    await sendCmd(c, { type: "prompt", message: opts.task });
  } catch (e: any) {
    children.delete(id);
    try { proc.kill(); } catch { /* ignore */ }
    // Don't litter an empty run dir (continuations reuse their thread's
    // dir, so only remove directories this start created).
    if (!continuedFrom) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    throw new Error(`spawn ${id}: prompt rejected: ${e.message ?? e}`);
  }

  try {
    pi.sendMessage(
      {
        customType: "spawn-started",
        content: continuedFrom ? `Continued **${label}**` : `Spawned **${label}** (${id})`,
        display: true,
        // pid lets the desktop UI probe process liveness later: rows for
        // children orphaned by a crash/reboot would otherwise read
        // "running" forever, since no completion can ever arrive.
        details: { id, thread, label, startedAt: Date.now(), pid: proc.pid ?? undefined },
      },
    );
  } catch { /* host without message channel; status still works */ }
  refreshWidget();
  return { child: c, continuedFrom };
}

async function finishChild(pi: ExtensionAPI, c: Child, state: ChildState, error?: string) {
  if (c.state !== "running") return;
  c.state = state;
  c.endedAt = Date.now();
  if (error) c.error = error;
  refreshWidget();
  for (const [, p] of c.pending) {
    clearTimeout(p.timer);
    p.rej(new Error(`child ${c.id} finished`));
  }
  c.pending.clear();
  if (state === "done") {
    try {
      const data: any = await sendCmd(c, { type: "get_last_assistant_text" }, 15_000);
      const t = typeof data?.text === "string" ? data.text : JSON.stringify(data ?? "").slice(0, 20000);
      c.finalText = t;
    } catch {
      c.finalText = "";
    }
  }
  // Orderly shutdown: closing stdin asks pi to dispose and exit.
  try { c.proc.stdin!.end(); } catch { /* ignore */ }
  setTimeout(() => { try { c.proc.kill("SIGKILL"); } catch { /* already out */ } }, STOP_GRACE_MS);

  const type = state === "done" ? "spawn-done" : "spawn-stopped";
  const body =
    state === "done"
      ? (c.finalText || "(no output)")
      : `**${c.label}** (${c.id}) ${state}${c.error ? `: ${c.error}` : ""}`;
  // Silent by design (display:false): one card per conversation, living
  // on the dispatch message. The completion still wakes the parent
  // (triggerTurn) and still feeds UI tracking — it just renders nothing
  // new. The parent's own reply carries the human-visible summary.
  try {
    await pi.sendMessage(
      {
        customType: type,
        content: body,
        display: false,
        details: { id: c.id, thread: c.thread, label: c.label, status: state, durationMs: c.endedAt - c.startedAt, task: c.task },
      },
      { triggerTurn: true },
    );
  } catch { /* parent gone; record keeps the result for status/list */ }
}

// --- background processes (spawn_bg) ----------------------------------------
// A proc is a raw shell command, not a pi session: no RPC, no steering,
// no transcript. Stdout+stderr append to output.log; the ONLY thing the
// parent ever gets pushed is the id, the exit code, and the log path.
// Reading the log is the parent's own job (read/grep/bash) — this tool
// never parses, tails, filters, or rotates it.

function killTree(c: Child, sig: NodeJS.Signals) {
  const pid = c.proc.pid;
  if (!pid) {
    try { c.proc.kill(sig); } catch { /* already out */ }
    return;
  }
  // Procs spawn detached, so the child is a process-group leader:
  // a negative pid kills the whole tree (dev servers, watchers).
  if (process.platform !== "win32") {
    try { process.kill(-pid, sig); return; } catch { /* fall through */ }
  }
  try { c.proc.kill(sig); } catch { /* already out */ }
}

async function startProc(
  pi: ExtensionAPI,
  parentCwd: string,
  opts: { command: string; label?: string; cwd?: string },
): Promise<Child> {
  if (!opts.command?.trim()) throw new Error("spawn_bg start requires a non-empty command");
  const cwd = opts.cwd || parentCwd;
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (e: any) {
    throw new Error(`spawn_bg cwd unavailable (${cwd}): ${e.message ?? e}`);
  }
  const id = rid("proc");
  const dir = path.join(spawnRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const label = opts.label?.slice(0, 80) || opts.command.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
  const logFile = path.join(dir, "output.log");
  try {
    fs.appendFileSync(logFile, `$ ${opts.command}\n# cwd: ${cwd} · started: ${new Date().toISOString()}\n`);
  } catch (e: any) {
    throw new Error(`spawn_bg log unavailable (${logFile}): ${e.message ?? e}`);
  }
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  // Full environment inherit (same strategy as agents: everything,
  // limit only on request). No PI_SESSION_* stripping — a dev server
  // gets what it needs.
  const proc = nodeSpawn("bash", ["-c", opts.command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const c: Child = {
    id, thread: id, kind: "proc", label, task: opts.command,
    command: opts.command, logFile, logStream,
    proc, state: "running", startedAt: Date.now(),
    seq: 0, pending: new Map(), buf: "",
  };
  proc.stdout!.pipe(logStream, { end: false });
  proc.stderr!.pipe(logStream, { end: false });
  proc.on("exit", (code) => {
    c.exitCode = code ?? undefined;
    // A stop in progress owns the outcome: the TERM-induced exit must
    // read "stopped", not "done".
    if (c.stopping) void finishProc(pi, c, "stopped", c.stopping).catch(() => {});
    else void finishProc(pi, c, "done").catch(() => {});
  });
  proc.on("error", (e: any) => {
    void finishProc(pi, c, "failed", `spawn failed: ${e.message ?? e}`).catch(() => {});
  });
  children.set(id, c);
  try {
    pi.sendMessage({
      customType: "spawn-bg-started",
      content: `Started **${label}** (${id})\nLogs: ${logFile}`,
      display: true,
      details: { id, thread: id, kind: "proc", label, command: opts.command, logFile, startedAt: Date.now(), pid: proc.pid ?? undefined },
    });
  } catch { /* host without message channel; status still works */ }
  refreshWidget();
  return c;
}

async function finishProc(pi: ExtensionAPI, c: Child, state: ChildState, error?: string) {
  if (c.state !== "running") return;
  c.state = state;
  c.endedAt = Date.now();
  if (error) c.error = error;
  refreshWidget();
  try { c.logStream?.end(); } catch { /* ignore */ }
  const type = state === "done" ? "spawn-bg-done" : "spawn-bg-stopped";
  const exit = c.exitCode != null ? `exit ${c.exitCode}` : state;
  // Deliberately content-free: id + exit + log path only. The parent
  // reads the log itself; we never push log bytes into its context.
  const body = `**${c.label}** (${c.id}) ${exit}${c.error ? `: ${c.error}` : ""}\nLogs: ${c.logFile}`;
  try {
    await pi.sendMessage(
      {
        customType: type,
        content: body,
        display: false,
        details: { id: c.id, thread: c.thread, kind: "proc", label: c.label, status: state, exitCode: c.exitCode, logFile: c.logFile, durationMs: c.endedAt - c.startedAt, command: c.command },
      },
      { triggerTurn: true },
    );
  } catch { /* parent gone; record keeps the result for status/list */ }
}

async function stopProc(pi: ExtensionAPI, c: Child, reason = "stopped by parent"): Promise<Child> {
  if (c.state !== "running") return c;
  c.stopping = reason;
  killTree(c, "SIGTERM");
  await waitExit(c, STOP_GRACE_MS);
  if (c.state === "running") {
    killTree(c, "SIGKILL");
    await waitExit(c, 3000);
  }
  // The exit handler normally settles this; this is the backstop.
  await finishProc(pi, c, "stopped", reason);
  return c;
}

// Resolve a run id, id prefix, or thread id to a live record.
// Exact ids and threads first; id prefixes only when unambiguous — a
// shared prefix across runs must never silently pick one (steer/stop
// the wrong child). Throws on ambiguity so callers report it instead.
function resolveChild(key: string): Child | undefined {
  if (!key) return undefined;
  const direct = children.get(key);
  if (direct) return direct;
  // Threads retarget: prefer the running run, else the latest started.
  let latest: Child | undefined;
  for (const c of children.values()) {
    if (c.thread === key) {
      if (c.state === "running") return c;
      if (!latest || c.startedAt > latest.startedAt) latest = c;
    }
  }
  if (latest) return latest;
  const hits = [...children.values()].filter((c) => c.id.startsWith(key));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`'${key}' matches ${hits.length} children (${hits.map((c) => c.id).join(", ")}); use a longer id`);
  }
  return undefined;
}


function noChild(id: string): string {
  return `no live child '${id}' in this process (a restart ends live runs; reopen a finished one with start + continueFrom)`;
}

// Resolves when the child process actually exits (cap: never hang delete).
function waitExit(c: Child, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (c.proc.exitCode !== null || c.proc.signalCode !== null) return resolve();
    const cleanup = () => {
      clearTimeout(t);
      c.proc.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    c.proc.on("exit", onExit);
  });
}

async function deleteChild(pi: ExtensionAPI, id: string): Promise<{ id: string; label: string }> {
  if (!validRunId(id)) throw new Error(`invalid run id '${id}'`);
  // Stop the live run, not just the named record: threads retarget to
  // the running continuation, which lives under a NEWER run id after a
  // continue. Stopping only the requested id orphaned the live child
  // (record miss) while deleting its transcript dir from under it.
  let c: Child | undefined;
  try {
    c = resolveChild(id);
  } catch {
    c = undefined; // ambiguous prefix: fall through to id-not-found below
  }
  if (!c) c = children.get(id);
  if (c && c.state === "running") {
    await stopChild(pi, c.id, "deleted by parent");
  }
  // The child gets a SIGKILL grace in finishChild and may still be
  // flushing its transcript: removing the dir underneath it races that
  // shutdown (torn writes, resurrect-on-flush). Wait for the exit first.
  if (c) await waitExit(c, 6000);
  const label = c?.label ?? id;
  // Scoped delete: resolve and confirm containment, never above root.
  const root = path.resolve(spawnRoot());
  const dir = path.resolve(root, id);
  if (dir !== path.join(root, id) || path.basename(dir) !== id) throw new Error(`invalid run id '${id}'`);
  let dirExists = false;
  try {
    dirExists = fs.statSync(dir).isDirectory();
  } catch { /* already gone */ }
  // Neither a live record nor transcript files (failed starts clean their
  // dir; restarts clear live runs): already gone is already gone. Converge
  // with a silent tombstone so the UI buries the row instead of flashing
  // a `no live child` error into chat for a delete the user just asked
  // for. Ambiguous prefixes still throw above in resolveChild; typo'd ids
  // converge to a buried row keyed by that id, never a chat error.
  if (!c && !dirExists) {
    try {
      pi.sendMessage({
        customType: "spawn-note",
        content: `Deleted ${id} (already gone).`,
        display: false,
        details: { id, deleted: true },
      });
    } catch { /* parent gone; nothing to converge */ }
    return { id, label: id };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  children.delete(id);
  // A continuation's record lives under its newer run id: drop that too
  // or list/status keeps showing a stopped child for a deleted thread.
  if (c && c.id !== id) children.delete(c.id);
  refreshWidget();
  // Silent by design (display:false): the row vanishing IS the feedback.
  // The entry persists in history purely as the tombstone, so rebuilds
  // re-bury it without ever rendering anything in chat. Fire-and-forget:
  // a dead parent channel must not turn a completed delete into an error.
  try {
    pi.sendMessage({
      customType: "spawn-note",
      content: `Deleted ${id}.`,
      display: false,
      details: { id, deleted: true },
    });
  } catch { /* parent gone; deletion itself succeeded */ }
  return { id, label };
}

async function stopChild(pi: ExtensionAPI, id: string, reason = "stopped by parent"): Promise<Child> {
  const c = children.get(id);
  if (!c) throw new Error(`'${noChild(id)}'`);
  if (c.state !== "running") return c;
  if (c.kind === "proc") return stopProc(pi, c, reason);
  try {
    await sendCmd(c, { type: "abort" }, 10_000);
  } catch { /* fall through to kill */ }
  await finishChild(pi, c, "stopped", reason);
  return c;
}

// --- extension -------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const SpawnParams = Type.Object({
    action: StringEnum(["start", "status", "stop", "steer", "followup", "list", "delete"] as const, {
      description: "start: launch async (returns id immediately). status/stop/steer/followup/delete take id. list: all children.",
    }),
    task: Type.Optional(Type.String({ description: "start: the job for the child session" })),
    id: Type.Optional(Type.String({ description: "child id for status/stop/steer/followup" })),
    message: Type.Optional(Type.String({ description: "steer/followup: message to the child" })),
    label: Type.Optional(Type.String({ description: "start: short label shown in UI" })),
    model: Type.Optional(Type.String({ description: "start: model (provider/id), else inherits host default" })),
    thinking: Type.Optional(Type.String({ description: "start: off|minimal|low|medium|high|xhigh|max" })),
    tools: Type.Optional(Type.String({ description: "start: --tools allowlist passthrough, else all defaults" })),
    excludeTools: Type.Optional(Type.String({ description: "start: --exclude-tools denylist passthrough" })),
    cwd: Type.Optional(Type.String({ description: "start: working dir, else parent cwd" })),
    nested: Type.Optional(Type.Boolean({ description: "start: allow grandchildren (default true)" })),
    isolated: Type.Optional(Type.Boolean({ description: "start: no ambient extensions/skills/mcp/context (default false)" })),
    continueFrom: Type.Optional(Type.String({ description: "start: continue a finished child by id — relaunches attached to a copy of its transcript" })),
  });

  const tool = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Run a subagent: a full pi session as a child of this session. start launches async and returns an id immediately (never blocks); completion wakes you with the result. continueFrom relaunches a finished child attached to a copy of its transcript (refuse while it is running — steer instead). status peeks, steer redirects the live run, followup queues for its next turn, stop ends it (transcript kept), delete stops it and removes its transcript files, list shows all children. Children inherit host defaults unless model/thinking/tools/cwd override them.",
    parameters: SpawnParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      try {
        switch (params.action) {
          case "start": {
            if (signal?.aborted) return errResult("spawn aborted before start");
            const { child: c, continuedFrom } = await startChild(pi, cwd, {
              task: params.task ?? "",
              label: params.label,
              model: params.model,
              thinking: params.thinking,
              tools: params.tools,
              excludeTools: params.excludeTools,
              cwd: params.cwd,
              nested: params.nested,
              isolated: params.isolated,
              continueFrom: params.continueFrom,
            });
            signal?.addEventListener("abort", () => {
              void stopChild(pi, c.id, "parent aborted the spawn").catch(() => {});
            });
            return textResult(
              continuedFrom
                ? `Continued **${c.label}** (${c.id}) from ${continuedFrom}. Running async — its result will wake you on completion.`
                : `Spawned **${c.label}** (${c.id}). Running async — its result will wake you on completion. status/stop/steer/followup take the id.`,
              { id: c.id, label: c.label, status: c.state, ...(continuedFrom ? { continuedFrom } : {}) },
            );
          }
          case "status": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            let tail = "";
            if (c.state === "running") {
              try {
                const data: any = await sendCmd(c, { type: "get_last_assistant_text" }, 15_000);
                tail = typeof data?.text === "string" ? `\nLatest output:\n${data.text.slice(-1000)}` : "";
              } catch { /* busy; report state only */ }
            }
            return textResult(summary(c) + tail, { id: c.id, label: c.label, status: c.state });
          }
          case "stop": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            if (c.state !== "running") {
              return textResult(`${c.id} [${c.label}] is already ${c.state} (ran ${fmtElapsed(c)}). Transcript kept; use status to review.`, { id: c.id, status: c.state });
            }
            await stopChild(pi, c.id);
            return textResult(`Stopped ${c.id} [${c.label}] after ${fmtElapsed(c)}. Transcript kept; use status to review.`, { id: c.id, status: c.state });
          }
          case "steer": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            if (c.state !== "running") return errResult(`${c.id} is ${c.state}; cannot steer a finished child`);
            if (!params.message?.trim()) return errResult("steer requires a message");
            await sendCmd(c, { type: "steer", message: params.message });
            return textResult(`Steered ${c.id}: message injected into its live run.`, { id: c.id });
          }
          case "followup": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            if (c.state !== "running") return errResult(`${c.id} is ${c.state}; cannot follow up a finished child`);
            if (!params.message?.trim()) return errResult("followup requires a message");
            await sendCmd(c, { type: "follow_up", message: params.message });
            return textResult(`Queued follow-up on ${c.id}: it lands on its next turn.`, { id: c.id });
          }
          case "delete": {
            const key = params.id ?? "";
            try {
              const r = await deleteChild(pi, key);
              return textResult(`Deleted ${r.id} [${r.label}]. Transcript files removed.`, { id: r.id, deleted: true });
            } catch (e: any) {
              return errResult(`spawn delete failed: ${e.message ?? e}`);
            }
          }
          case "list": {
            const all = [...children.values()].filter((c) => c.kind !== "proc");
            if (!all.length) return textResult("No spawned subagents this session.", { count: 0 });
            return textResult(
              all.map(summary).join("\n"),
              { count: all.length, children: all.map((c) => ({ id: c.id, label: c.label, status: c.state })) },
            );
          }
        }
      } catch (e: any) {
        return errResult(`spawn ${params.action} failed: ${e.message ?? e}`);
      }
    },
  });
  pi.registerTool(tool);

  // --- background processes: spawn_bg --------------------------------------
  // A proc is a shell command, not a session. start returns {id, logFile}
  // immediately; stdout+stderr append to the log; completion wakes the
  // parent with id + exit code + log path (never log bytes). The parent
  // reads the log with its own tools. No output action by design.
  const BgParams = Type.Object({
    action: StringEnum(["start", "status", "stop", "list", "delete"] as const, {
      description: "start: launch async (returns id + log path immediately). status/stop/delete take id. list: all background processes.",
    }),
    command: Type.Optional(Type.String({ description: "start: shell command to run (bash -c)" })),
    id: Type.Optional(Type.String({ description: "proc id for status/stop/delete" })),
    label: Type.Optional(Type.String({ description: "start: short label shown in UI" })),
    cwd: Type.Optional(Type.String({ description: "start: working dir, else parent cwd" })),
  });

  const bgTool = defineTool({
    name: "spawn_bg",
    label: "Spawn BG",
    description:
      "Run a background process: a shell command as a child of this session. start launches async and returns an id plus a log file path immediately (never blocks, never streams output); stdout+stderr append to that file. Completion wakes you with the exit code and the log path — read the log with your own tools. status peeks (state + exit code + log path, never content), stop ends it (SIGTERM then SIGKILL, log kept), delete stops it and removes its log files, list shows all background processes.",
    parameters: BgParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      try {
        switch (params.action) {
          case "start": {
            if (signal?.aborted) return errResult("spawn_bg aborted before start");
            const c = await startProc(pi, cwd, {
              command: params.command ?? "",
              label: params.label,
              cwd: params.cwd,
            });
            signal?.addEventListener("abort", () => {
              void stopChild(pi, c.id, "parent aborted the spawn").catch(() => {});
            });
            return textResult(
              `Started **${c.label}** (${c.id}). Logs: ${c.logFile}. Running async — completion will wake you with the exit code. Read the log with your own tools.`,
              { id: c.id, logFile: c.logFile, label: c.label, status: c.state },
            );
          }
          case "status": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            if (c.kind !== "proc") return errResult(`${c.id} is a subagent, not a background process; use spawn_agent status`);
            return textResult(summary(c), { id: c.id, label: c.label, status: c.state, exitCode: c.exitCode, logFile: c.logFile });
          }
          case "stop": {
            const c = resolveChild(params.id ?? "");
            if (!c) return errResult(`'${noChild(params.id ?? "")}'`);
            if (c.kind !== "proc") return errResult(`${c.id} is a subagent, not a background process; use spawn_agent stop`);
            if (c.state !== "running") {
              return textResult(`${c.id} [${c.label}] is already ${c.state}${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}. Logs: ${c.logFile}`, { id: c.id, status: c.state });
            }
            await stopChild(pi, c.id);
            return textResult(`Stopped ${c.id} [${c.label}]. Logs kept: ${c.logFile}`, { id: c.id, status: c.state });
          }
          case "delete": {
            const key = params.id ?? "";
            try {
              const r = await deleteChild(pi, key);
              return textResult(`Deleted ${r.id} [${r.label}]. Log files removed.`, { id: r.id, deleted: true });
            } catch (e: any) {
              return errResult(`spawn_bg delete failed: ${e.message ?? e}`);
            }
          }
          case "list": {
            const all = [...children.values()].filter((c) => c.kind === "proc");
            if (!all.length) return textResult("No background processes this session.", { count: 0 });
            return textResult(
              all.map(summary).join("\n"),
              { count: all.length, procs: all.map((c) => ({ id: c.id, label: c.label, status: c.state })) },
            );
          }
        }
      } catch (e: any) {
        return errResult(`spawn_bg ${params.action} failed: ${e.message ?? e}`);
      }
    },
  });
  pi.registerTool(bgTool);

  // Terminal rendering for the interactive CLI: one-line status where
  // the desktop draws cards. RPC/desktop hosts never consult these.
  // spawn-note keeps the default box (lists read fine as markdown).
  pi.registerMessageRenderer("spawn-started", (m) => new Text(agentLine("running", (m as any).details ?? {})));
  pi.registerMessageRenderer("spawn-done", (m) => new Text(agentLine("done", (m as any).details ?? {})));
  pi.registerMessageRenderer("spawn-stopped", (m) => new Text(agentLine(statusOf((m as any).details ?? {}, "stopped"), (m as any).details ?? {})));
  pi.registerMessageRenderer("spawn-bg-started", (m) => new Text(procLine("running", (m as any).details ?? {})));
  pi.registerMessageRenderer("spawn-bg-done", (m) => new Text(procLine("done", (m as any).details ?? {})));
  pi.registerMessageRenderer("spawn-bg-stopped", (m) => new Text(procLine(statusOf((m as any).details ?? {}, "stopped"), (m as any).details ?? {})));

  // Messages, not ui.notify: notify is fire-and-forget over RPC and
  // desktop surfaces messages. Errors ride the same channel.
  const note = (content: string, details?: unknown) =>
    pi.sendMessage({ customType: "spawn-note", content, display: true, details });

  async function cmdStatus(id: string | undefined) {
    const all = [...children.values()].filter((c) => c.kind !== "proc");
    if (id) {
      let c: Child | undefined;
      try {
        c = resolveChild(id);
      } catch (e: any) {
        note(e.message ?? String(e)); // ambiguous prefix, not a crash
        return;
      }
      if (!c) {
        note(`'${noChild(id)}'`);
        return;
      }
      note(summary(c), { id: c.id });
      return;
    }
    note(
      all.length ? all.map(summary).join("\n") : "No spawned subagents this session.",
      { count: all.length },
    );
  }

  async function cmdProcStatus(id: string | undefined) {
    const all = [...children.values()].filter((c) => c.kind === "proc");
    if (id) {
      let c: Child | undefined;
      try {
        c = resolveChild(id);
      } catch (e: any) {
        note(e.message ?? String(e));
        return;
      }
      if (!c || c.kind !== "proc") {
        note(`'${noChild(id)}'`);
        return;
      }
      note(summary(c), { id: c.id });
      return;
    }
    note(
      all.length ? all.map(summary).join("\n") : "No background processes this session.",
      { count: all.length },
    );
  }

  pi.registerCommand("agents", {
    description: "List spawned subagent sessions with ids and states",
    handler: async () => {
      await cmdStatus(undefined);
    },
  });
  pi.registerCommand("agent-stop", {
    description: "Stop a spawned subagent: /agent-stop <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        note("Usage: /agent-stop <id>");
        return;
      }
      try {
        const key = resolveChild(id)?.id ?? id;
        const cur = children.get(key);
        if (!cur) {
          note(`'${noChild(id)}'`);
          return;
        }
        if (cur.state !== "running") {
          note(`${cur.id} [${cur.label}] is already ${cur.state}.`, { id: cur.id });
          return;
        }
        const c = await stopChild(pi, key);
        note(`Stopped ${c.id} [${c.label}].`, { id: c.id });
      } catch (e: any) {
        note(e.message ?? String(e));
      }
    },
  });
  pi.registerCommand("agent-steer", {
    description: "Steer a live spawned subagent: /agent-steer <id> <message>",
    handler: async (args) => {
      const m = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        note("Usage: /agent-steer <id> <message>");
        return;
      }
      let c: Child | undefined;
      try {
        c = children.get(resolveChild(m[1])?.id ?? m[1]);
      } catch (e: any) {
        note(e.message ?? String(e)); // ambiguous prefix, not a crash
        return;
      }
      if (!c) {
        note(`'${noChild(m[1])}'`);
        return;
      }
      if (c.state !== "running") {
        note(`${c.id} is ${c.state}; cannot steer a finished child`);
        return;
      }
      try {
        await sendCmd(c, { type: "steer", message: m[2] });
        note(`Steered ${c.id}.`);
      } catch (e: any) {
        note(e.message ?? String(e));
      }
    },
  });
  pi.registerCommand("agent-status", {
    description: "Show a spawned subagent: /agent-status <id>",
    handler: async (args) => {
      await cmdStatus(args.trim().split(/\s+/)[0]);
    },
  });
  pi.registerCommand("agent-delete", {
    description: "Delete a spawned subagent and its transcript files: /agent-delete <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        note("Usage: /agent-delete <id>");
        return;
      }
      try {
        const key = resolveChild(id)?.id ?? id;
        await deleteChild(pi, key);
      } catch (e: any) {
        note(e.message ?? String(e));
      }
    },
  });
  pi.registerCommand("procs", {
    description: "List background processes with ids and states",
    handler: async () => {
      await cmdProcStatus(undefined);
    },
  });
  pi.registerCommand("proc-stop", {
    description: "Stop a background process: /proc-stop <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        note("Usage: /proc-stop <id>");
        return;
      }
      try {
        const c = resolveChild(id);
        if (!c || c.kind !== "proc") {
          note(`'${noChild(id)}'`);
          return;
        }
        if (c.state !== "running") {
          note(`${c.id} [${c.label}] is already ${c.state}.`, { id: c.id });
          return;
        }
        await stopChild(pi, c.id);
        note(`Stopped ${c.id} [${c.label}].`, { id: c.id });
      } catch (e: any) {
        note(e.message ?? String(e));
      }
    },
  });
  pi.registerCommand("proc-status", {
    description: "Show a background process: /proc-status <id>",
    handler: async (args) => {
      await cmdProcStatus(args.trim().split(/\s+/)[0]);
    },
  });
  pi.registerCommand("proc-delete", {
    description: "Delete a background process and its log files: /proc-delete <id>",
    handler: async (args) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        note("Usage: /proc-delete <id>");
        return;
      }
      try {
        const key = resolveChild(id)?.id ?? id;
        await deleteChild(pi, key);
      } catch (e: any) {
        note(e.message ?? String(e));
      }
    },
  });

  pi.on("session_start", (_ev, ctx) => {
    tuiCtx = ctx;
    refreshWidget();
  });
  pi.on("session_shutdown", () => {
    for (const c of children.values()) {
      if (c.state === "running") {
        c.state = "stopped";
        c.endedAt = Date.now();
        c.error = "parent session ended";
        try { c.logStream?.end(); } catch { /* ignore */ }
        killTree(c, "SIGKILL");
      }
    }
    children.clear();
    refreshWidget();
  });
}
