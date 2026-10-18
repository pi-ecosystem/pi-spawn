# pi-spawn

Pi extension: subagents, sessions all the way down. A subagent is a pi
session whose parent is another session instead of the UI. Same verbs at
every level: prompt / steer / followup / stop / status / transcript.

```bash
pi install ~/Projects/pi-spawn
# or: pi --extension ./index.ts
```

Registers the `spawn` tool plus `/agents`, `/agent-stop`, `/agent-steer`,
`/agent-status`, `/agent-delete`. See [SPAWN.md](./SPAWN.md) for the full
protocol (threads, messages, boundaries).

Bundled with [pi-desktop](../pi-desktop) (which passes `--extension` with
its vendored copy, so desktop users get it with no install step).
