# jobs — persistent scheduler for pi (pi-jobs)

One primitive: a **job** (any shell command) mapped to the pi session that
submitted it. No pi-specific runtime: no RPC, no steering, no transcripts.

## Tool: `job`

Single tool, `action` param. Async-first: `submit` returns `{jobId, runId,
logFile}` immediately; completion wakes the parent via message (id + exit +
log path only, never log bytes).

| action | params | result |
|---|---|---|
| `submit` | `command`, `label?`, `cwd?`, `env?`, `restart=no\|on-failure\|always`, `maxRestarts?=10 (0=unlimited)`, `logFile?` (job-owned log path — `logs`/wakes read it instead of captured stdout; scheduler never writes there) | `{jobId, runId, logFile}` immediately |
| `list` | `scope=mine\|all\|orphans` (default `mine`), `state?` | jobs + last run state |
| `get` | `id` (job/run id or prefix) | detail |
| `logs` | `id`, `tail?=50` | last N lines |
| `kill` | `id` | stops runs, keeps logs |
| `retry` | `id` | fresh run |
| `delete` | `id` | kills + removes files + db entries |
| `adopt` | `id` | claim orphan into this session |

## Waiting on completion (do NOT sleep-poll)

`submit` is fire-and-forget. The `job-done` / `job-failed` / `job-killed`
wake IS the notification. `get`/`logs` are spot-checks, never loops.

## Persistence + reboot

- Disk: `~/.pi/agent/jobs/jobs.db` (SQLite WAL, concurrent-session safe) + `runs/<runId>/output.log`.
- Processes are detached + unref'd, stdio direct to file.
- `session_shutdown` does NOT kill jobs — every mutation is already in SQLite; it only stops polling.
- `session_start` opens the db, reconciles `running` runs with dead pids
  → `interrupted`, relaunches per `restart` policy, restarts the 5s poller.
- Poller settles runs this process didn't start (exit code unknown, log
  tail is the record) and emits the wake.

Portable resume = rehydrate when pi starts. True boot-without-login resume
needs OS hooks (systemd/launchd/Task Scheduler) — later, behind this API.

## Recipe: pi subagent (convention, not special-cased)

The scheduler treats a pi run like any other command. The pattern:

1. `submit` command `pi --session /tmp/<name>/session.jsonl -p "<task>"` with `logFile` = same path.
2. Peek mid-run with `logs` — jsonl entries give live structured visibility.
3. Continue later: new `submit` reusing the same `--session` path (appends).
4. `retry` reuses the recorded `logFile` automatically.

## Messages

| customType | display | content |
|---|---|---|
| `job-started` | true | label + jobId + log path |
| `job-done` | false | label + runId + exit + log path + `details{jobId,runId,exitCode,logFile}` — wakes parent |
| `job-failed` | false | same shape, non-zero exit or launch error |
| `job-killed` | false | same shape, killed by parent |
| `job-note` | true/false | list output, reconcile notes, tombstones |

## Slash

- `/jobs [mine|all|orphans]`
- `/job-kill <id>`, `/job-logs <id> [lines]`, `/job-retry <id>`, `/job-delete <id>`
