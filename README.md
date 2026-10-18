# pi-spawn

[![Node 22+](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Subagents for pi — sessions all the way down.**

`pi-spawn` is a native Pi extension. A subagent is a pi session whose parent
is another session instead of the UI. Same verbs at every level: prompt /
steer / followup / stop / status / transcript. Async-first: `start` returns
an id immediately; completion wakes the parent with the result.

## Installation

Prereqs: Node 22+ and the [`pi` CLI](https://pi.dev).

```bash
pi install git:github.com/pi-ecosystem/pi-spawn   # or: pi install ./pi-spawn
# one-off: pi --extension ./index.ts
```

## Tools

| Tool / command | What it does |
|---|---|
| `spawn` | `start` (async, returns `{id}`), `status`, `stop`, `steer`, `followup`, `list`, `delete` |
| `/agents` | list spawned children with ids + states |
| `/agent-stop <id>` | stop a child, keep its transcript |
| `/agent-steer <id> <msg>` | redirect a live child |
| `/agent-status <id>` | peek at a child |
| `/agent-delete <id>` | stop + remove transcript files |

Children are real `pi --mode rpc` subprocesses and inherit the host's
model/thinking/tools unless overridden. See [SPAWN.md](./SPAWN.md) for the
full protocol: threads, messages, slash commands, and boundaries
(headless children, no cross-talk to the user, tree discipline).

## With pi-desktop

[pi-desktop](https://github.com/pi-ecosystem/pi-desktop) vendors this
package and loads it into every session via `--extension`, so desktop
users get subagents with no install step.

## Develop

```bash
git clone git@github.com:pi-ecosystem/pi-spawn.git
cd pi-spawn
npm install
npm run typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
