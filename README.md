# pi-jobs

[![Node 22+](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Persistent job scheduler for pi — any shell command, tracked per session.**

`pi-jobs` is a native Pi extension. One primitive: a **job** (detached
process, direct-to-file logs, SQLite store). Jobs survive parent
exit and reboot: dead pids reconcile to `interrupted` on next start and
relaunch per restart policy.

## Installation

Prereqs: Node 22+ and the [`pi` CLI](https://pi.dev).

```bash
pi install git:github.com/pi-ecosystem/pi-jobs   # or: pi install ./pi-jobs
# one-off: pi --extension ./index.ts
```

## Tool

| Action | What it does |
|---|---|
| `job submit` | run async (returns `{jobId, runId, logFile}`), opts: `restart: no\|on-failure\|always`, `maxRestarts`, `cwd`, `env`, `label`, `logFile` (job-owned log, e.g. pi session jsonl — `logs` reads it instead) |
| `job list` | `scope: mine\|all\|orphans` (default `mine`), optional `state` filter |
| `job get` | job or run detail (id or prefix) |
| `job logs` | last N lines of the run log (never inlined into wakes) |
| `job kill` | SIGTERM then SIGKILL, log kept |
| `job retry` | fresh run of the same job |
| `job delete` | kill + remove job/runs/files |
| `job adopt` | claim an orphan job into this session |

Slash: `/jobs [mine|all|orphans]` (default `mine`), `/job-kill`, `/job-logs`, `/job-retry`, `/job-delete`.

Storage: `~/.pi/agent/jobs/jobs.db` (SQLite WAL — safe for concurrent sessions) + `runs/<runId>/output.log`.
Detached (`detached:true`, `shell:true`) + `unref`, stdio direct to log
file. Poller (5s) settles runs the current process didn't start.

## Develop

```bash
git clone git@github.com:pi-ecosystem/pi-jobs.git
cd pi-jobs
npm install
npm run typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
