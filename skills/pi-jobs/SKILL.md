---
name: pi-jobs
description: Persistent background jobs via the job tool. Use when running anything async (dev servers, agents, scripts) that must survive and report back.
---

# pi-jobs

One tool (`job`), fully generic — a job is any shell command. Async-first:
`submit` returns `{jobId, runId, logFile}` immediately; completion wakes you.
Never sleep-poll — end your turn, the wake finds you. `get`/`logs` are for
spot-checks only.

- `submit {command, label?, cwd?, env?, restart?, maxRestarts?, logFile?}`
- `list {scope?: mine|all|orphans, state?}`, `get {id}`, `logs {id, tail?}`
- `kill {id}`, `retry {id}`, `delete {id}`, `adopt {id}`
- Ids accept exact, run, or unambiguous prefix.
- `list` scopes: `mine` (this session), `all`, `orphans` (other sessions').
  `adopt` claims an orphan into this session.
- `restart`: `no` (default), `on-failure` (rerun if exit != 0), `always`.
  `maxRestarts` caps auto-reruns (default 10, 0 = unlimited).
- Reboot survival: jobs persist on disk; dead runs become `interrupted`
  and relaunch per `restart` policy when pi next starts. Use
  `restart: always` for anything that must come back after a reboot.
  No sleep-polling: `submit` is fire-and-forget, the wake IS the signal.

`logFile`: if the command writes its own log, pass its path — `logs` and
wakes read it instead of captured stdout. The scheduler never writes there.

## Recipe: pi subagent (convention, not special-cased)

1. `submit` command `pi --session /tmp/<name>/session.jsonl -p "<task>"`
   with `logFile` set to the same path.
2. Peek mid-run with `logs` — jsonl entries give live structured visibility
   (thinking, tool calls, everything).
3. Continue later: new `submit` reusing the same `--session` path (appends
   to the same conversation).
4. `retry` reuses the recorded `logFile` automatically.
