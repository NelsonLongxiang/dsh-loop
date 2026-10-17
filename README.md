<h1 align="center">loop</h1>

<p align="center"><a href="README.zh.md">中文</a> | English</p>

<p align="center">Scheduled loop plugin: `/loop` command + `loop` tool (self-adjusting by the model) + active status bar on the chat page, with support for multiple concurrent loops</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="license">
  <a href="https://dshfind.com/en/plugins/vlln/dsh-loop?ref=badge"><img src="https://dshfind.com/api/badge/vlln/dsh-loop" alt="dshfind" /></a>
  <a href="https://www.dsh.so/artifact/dsh-loop"><img src="https://www.dsh.so/badge/dsh-loop.svg" alt="dsh.so security" /></a>
</p>

Delivers a prompt to the current agent at a fixed interval — ideal for polling, PR babysitting, and build-fix-test cycles. Aligned with Claude Code's `/loop` semantics, **multiple loops can run concurrently in a single session**. Delivered as an official **bundle plugin** (`dsh.bundle` + dshClient channel), 0 patch.

## Preview

![loop status bar (real run screenshot: multiple loops collapse into a count bar, expanding lists them one by one)](https://cdn.jsdelivr.net/gh/vlln/dsh-loop@main/docs/preview/loop.png?v=3)

## Features

**Tool** (registered via `defineTool`, the model can self-adjust on every turn):

| Tool | Description |
|---|---|
| `loop` | start (start a new loop) / stop (stop a specific one or all) / pause / resume / edit (rewrite a loop's prompt & interval in place) / status / list (list loops in the current session) |

**Commands** (user side):

| Command | Description |
|---|---|
| `/loop [interval] <prompt>` | Start a new loop (interval `5m`/`30s`/`1h`/`2d` or a bare number = minutes; bare `/loop` uses the built-in maintenance prompt) |
| `/loop list` | List all loops in the current session (with ids) |
| `/loop stop <id>` / `/loop stop` | Stop a specific loop / stop all |
| `/loop pause <id>` / `/loop resume <id>` | Pause one loop (keep the definition, skip delivery and sweeps) / resume it from now |
| `/loop edit <id> [interval] <new prompt>` | Edit a running loop **in place** — new prompt takes effect on the next delivery; a new interval re-arms the timer (works on live, paused and dormant loops) |

`/loop` replies (the command-palette description, `list` / usage / stop output) follow the **UI language**: the client half relays its active locale to the plugin, so they render in Chinese or English to match the interface. Headless runs with no client in sight keep English.

**UI** (dock slot above the input box on the chat page):

| Feature | Description |
|---|---|
| Active status bar | Single loop: `● ⟳ looping · <prompt> · 5m · next in 23s`; multiple loops collapse into a count bar "N loops running · expand", click to expand the list |
| `/` menu row icon | Typing `/` in the composer shows the ⟳ icon at the left of the `/loop` row (same position and size as every other command row) |

## Settings

The plugin ships a settings card on **Settings → Plugins → this bundle's page** (official `plugins.bundle.config` slot, keyed by the bundle package name `@nelsonlongxiang/dsh-loop`; the settings namespace is `dsh-loop`, the id of the entry that exports the `Config` schema). **Each tool gets its own row with an official-looking Switch:**

| Setting | Default | Effect |
|---|---|---|
| Whether to **inject** the `loop` tool into the model | on | When off, the `loop` tool is **not registered** for agents: the model can no longer see or call it (`tools.schemas` has no `loop`). The `/loop` command (user side) and the status bar are unaffected. |

The card fields are driven by the client `LOOP_TOOL_FIELDS` table, mirrored one-to-one by the Node-side tool definition table — adding a tool means adding one entry on each side, and the settings card grows a new switch row automatically.

Changes apply as soon as you **save** (the schema's leaves are marked `.volatile()`: the host commits in place without remounting the entry and emits `loader/volatile-update`) — the plugin re-reads the snapshot and registers/unregisters the affected tools on the fly, so new sessions pick it up without a restart. Tool schemas are resolved live at every session/prompt assembly (there is no per-session snapshot): in-flight sessions also see the change from their next turn, and turning a tool off drops it from `tools.schemas` immediately, so a model that called it earlier can no longer reach it (they can only reconcile that through the turn record). The `/loop` command (user side) and the status bar are unaffected.

## Installation

**Recommended: one-line install from a git source** (build artifacts are committed, so a git source does not trigger a build):

```sh
dsh plugin --profile web add "github:NelsonLongxiang/dsh-loop#main"   # one-line git source (build artifacts committed)
# or npm source (private Gitea registry): dsh plugin --profile web add @nelsonlongxiang/dsh-loop@0.4.10
```

Or from a local directory (when you have the source): `git clone`, then `cd dsh-loop && dsh plugin --profile web add .`.

## Compatibility

| dsh version | Status |
|---|---|
| `0.2.0-rc.2` | ✅ Verified (migrated against 0.2.0 on 2026-10-03; command surface re-checked 2026-10-15) |
| Other versions | ⚠️ Unverified — if the `/loop` menu row loses its icon after a dsh upgrade (the command itself still works), upstream renamed an internal client command-surface method and the plugin silently falls back to the official fallback look |

After installing, **restart web** for it to take effect (bundles are composed at startup); afterwards you can disable/enable it from the "Plugins" panel on the settings page (takes effect at runtime + persisted).

## Usage

```sh
# User side
/loop 5m check PRs on the deploy branch   # delivered every 5 minutes
/loop list                                # loop-1: every 5m — check PRs on the deploy branch
/loop stop loop-1                         # stop a specific one
/loop stop                                # stop all
/loop edit loop-1 watch the staging branch instead   # rewrite the prompt in place
/loop edit loop-1 10m watch staging       # change interval (and prompt) without a restart

# Model side (loop tool)
loop action=start prompt="fix flaky test" interval="2m"
loop action=status
loop action=stop loop_id="loop-2"
loop action=edit loop_id="loop-2" prompt="fix the other test" interval="5m"
```

Loop definitions persist to `$DSH_HOME/plugins-data/dsh-loop/loops.json` (falling back to `~/.dsh/` when `DSH_HOME` is unset). After a restart, a loop re-attaches automatically when its host session resumes — the anchor is the `agent/created` lifecycle event (live agent objects are never serialized; only `sessionId`/`agentId`, prompt, interval and `lastDeliveredAt` are stored). Explicit stops (command, tool, or the status-bar button) delete the definition permanently. Definitions whose host never returns are evicted after 7 idle days (never sooner than twice the loop's own interval), keeping the file bounded.

- Idle polling backoff: empty responses (no active loops) back the client poll off to 5 minutes; any active loop returns it to 60s. Background tabs pause polling entirely (visibilitychange).
- Event ledger: append-only plugins-data/dsh-loop/loops.history.jsonl records created/stopped/swept/remounted/paused/resumed/edited events with loop metadata (v0.4.2).

- Pause/resume: each loop card gains a pause/resume toggle; paused loops keep their definition, skip delivery and stale sweeps, and resume from now.

- Edit in place (v0.4.8, interval field since v0.4.9): the ✎ button on the status bar (single-loop bar and each expanded row) turns the row into an inline editor with two fields — the prompt and the interval token (`5m`/`30s`/`1h`/`2d`; a bare number means minutes). Enter or ✓ commits (`POST {id, action:'edit', prompt?, interval?}`), Esc or ✕ cancels; an invalid interval token is flagged red and blocks commit. Leave a field empty to change only the other one. Editing also refreshes the idle-eviction clock, and interval edits re-arm the live timer from the existing schedule.



```sh
pnpm install
pnpm run build      # tsdown: Node half (lib/index.mjs) + client bundle (lib/client.js)
```

- Node half: `src/index.mjs` (commands/tool/loops status route `/plugins/dsh-loop/loops`)
- client: `src/client/index.tsx` (dock slot status bar)

## License

MIT License (example plugin of the DSH ecosystem).
