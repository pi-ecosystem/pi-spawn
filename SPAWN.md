# spawn — subagents + background processes for pi (pi-spawn)

Two primitives, one registry: **a pi session** (subagent) and **a shell
process** (bg proc). A subagent is a session whose parent is another
session instead of the UI. A bg proc is a shell command whose logs live
in a file. Same verbs at every level for lifecycle:
start / status / stop / list / delete.

## Tool: `spawn_agent`

Single tool, `action` param. Async-first: `start` always returns
immediately with `{ id }`; completion wakes the parent via message.

| action | params | result |
|---|---|---|
| `start` | `task`, `label?`, `model?`, `thinking?`, `tools?`, `excludeTools?`, `cwd?`, `nested=true`, `isolated=false`, `continueFrom?` | `{ id }` immediately |
| `status` | `id` | state, elapsed, tail of last output |
| `stop` | `id` | stops run, keeps transcript |
| `steer` | `id`, `message` | redirects the live run |
| `followup` | `id`, `message` | queued for child's next turn |
| `list` | — | all children this session |
| `delete` | `id` | stops if running, removes transcript files, drops from list |

Children are real `pi --mode rpc` subprocesses, driven over RPC.
Unset `model`/`thinking`/`tools` inherit host defaults (same as parent).

## Tool: `spawn_bg`

Single tool, `action` param. A proc is a shell command, not a session:
no steering, no transcript — stdout+stderr append to `output.log` and
the parent reads it with its own tools. No `output` action by design.

| action | params | result |
|---|---|---|
| `start` | `command`, `label?`, `cwd?` | `{ id, logFile }` immediately |
| `status` | `id` | state, elapsed, exit code, log path (never content) |
| `stop` | `id` | SIGTERM, SIGKILL after 5s grace, keeps log |
| `list` | — | all bg procs this session |
| `delete` | `id` | stops if running, removes log files, drops from list |

Procs spawn detached (`bash -c`) with the full parent environment, so
dev servers and watchers get what they need. Kills target the whole
process group. Completion wakes the parent via `spawn-bg-done` with
`details{id,label,status,exitCode,logFile,durationMs,command}` — id +
exit + path only, never log bytes.

## Slash

- `/procs` — list bg procs (via `spawn-note`)
- `/proc-stop <id>` — same as `stop`
- `/proc-status <id>` — same as `status`
- `/proc-delete <id>` — same as `delete`

## Messages (additions for bg procs)

| customType | display | content |
|---|---|---|
| `spawn-bg-started` | true | one line: label + id + log path; the proc's ONLY card |
| `spawn-bg-done` | false | id + exit code + log path + `details{...logFile,exitCode}` — wakes parent, renders nothing new |
| `spawn-bg-stopped` | false | one line: label + id + reason (same silent treatment) |

## Threads: one row per conversation

`continueFrom` reopens the SAME conversation: same run dir, same session
file appended, same UI row. Only the run id is new. Every message carries
both: `details.id` (this run) and `details.thread` (the conversation).
The UI groups by thread — follow-ups never spawn new rows. Actions
(status/stop/steer/followup) accept run ids, prefixes, or thread ids
(threads retarget to the live run).
`tools` is a `--tools` allowlist passthrough; `isolated` adds
`--no-extensions --no-skills --no-mcp --no-context-files`.
`nested:false` omits the extension from the child, so it cannot spawn.
Depth cap 3, max 8 live children per session, enforced by env + counters.

## Messages (the entire UI contract)

| customType | display | content |
|---|---|---|
| `spawn-started` | true | one line: label + id; the conversation's ONLY card (expandable; answer morphs in) |
| `spawn-done` | false | full final report + `details{id,thread,label,status,durationMs,task}` — wakes parent AND feeds UI, renders nothing new |
| `spawn-stopped` | false | one line: label + id + reason (same silent treatment) |
| `spawn-note` | true | `/agents` list output (slash path) |

No other types. The Agents panel renders these; nothing else to parse.

## Slash (same code paths, for UI buttons and typing)

- `/agents` — list with ids + states (via `spawn-note`)
- `/agent-stop <id>` — same as `stop`
- `/agent-steer <id> <message>` — same as `steer`
- `/agent-status <id>` — same as `status`
- `/agent-delete <id>` — same as `delete`

## Boundaries (agreed, non-negotiable)

1. Host-level stays host-level: no installing extensions/providers,
   no foreign models. Children get what's loaded — never more.
2. Tree discipline: children are headless. Anything needing the user
   routes child → parent → UI. No child-to-user dialogs.
3. No TUI chrome for children. No session-file repointing (spawn fresh).
4. Extension scoping is selection from loaded, not independent install.
5. Children die with the parent session (`session_shutdown` kills all).
   Crash-orphans are still possible (dead parent, live child): a backend
   reboot reaps stragglers, and the desktop UI marks rows no completion
   can reach as lost instead of "running" forever. No cross-reload
   adoption — a new host never drives an old child (foreground-first).
