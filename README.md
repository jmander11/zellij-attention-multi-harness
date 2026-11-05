# zellij-agent-attention

Know which Zellij tab needs your attention — without checking each one.

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

A standalone Zellij WASM plugin that adds notification icons directly to tab names. Works with both the default Zellij tab bar and [zjstatus](https://github.com/dj95/zjstatus). When an external process (like Claude Code) needs your attention, the tab is renamed with an indicator — e.g., `terminal` becomes `terminal ⏳`. Focusing the pane clears the notification automatically.

https://github.com/user-attachments/assets/646effc0-1c24-413d-bef3-3d85591cd89b

## Features

- **Tab-level notifications** — icons appended to tab names, visible at a glance
- **Auto-clear on focus** — switch to the pane and the notification disappears
- **Two notification states** — ⏳ waiting (needs input) and ✅ completed (task done)
- **Memory-only state** — lightweight, no disk I/O; stale icons cleaned up automatically on restart
- **Configurable icons** — use any character or emoji as notification indicator
- **Standalone plugin** — works independently, no zjstatus or other status bar plugins needed
- **zj-radar integration** — accepts `zj_radar.status.v1` broadcasts from Claude Code, Cursor, Copilot, and opencode

## Documentation

- **Local setup** (opencode in a zellij pane on the same host as the zellij server):
  the [Quick start](#quick-start-opencode-same-host) below — two steps, no WASM plugin,
  no zj-radar, no ssh.
- **pi** (Earendil's coding agent): the [pi](#pi) section — a bundled extension that shows
  ✅/⏳ on pi's own tab, same producer-side mechanism as the opencode plugin.
- **Remote setup** (opencode on another machine over `ssh`, zellij server local):
  [SSH-SETUP.md](SSH-SETUP.md) — socket forwarding, `ZELLIJ_PANE_ID`/`ZELLIJ_SOCKET_DIR`,
  and the `zssh`/`zssh2` shell functions.
- **WASM / pipe setup** (Claude Code, Cursor, Copilot via `zj_radar.status.v1`): the
  full [Installation](#installation) steps below.
- **Troubleshooting**: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Quick start (opencode, same host)

If opencode runs in a zellij pane on the **same machine** as the zellij server, this is
the whole setup — no WASM plugin, no zj-radar, no config.kdl changes:

```bash
# 1. Install the opencode plugin (global; or use .opencode/plugins/ for a single project)
mkdir -p ~/.config/opencode/plugins
cp opencode/zellij-attention.js ~/.config/opencode/plugins/

# 2. Restart opencode (plugins load at startup, not hot)
```

That's it. The plugin finds its own tab, appends ⏳/✅ to the tab name, and clears the
icon when you focus the tab. Verify with `tail -f /tmp/opencode-zellij-attention.log`
(you should see a `plugin loaded (pane=… tab=… zellij=…)` line on the next opencode
start). See the [opencode](#opencode) section for the event→icon table and notes.

## Prerequisites

- **Zellij** ≥ 0.44.3
- **zj-radar** CLI (recommended, see below) — provides self-limiting pipe sends and smart status derivation

## Installation

### Step 1: Install the Plugin

**Pre-built WASM:**

```bash
mkdir -p ~/.config/zellij/plugins
curl -L https://github.com/KiryuuLight/zellij-agent-attention/releases/latest/download/zellij-agent-attention.wasm \
  -o ~/.config/zellij/plugins/zellij-agent-attention.wasm
```

**Or build from source** (requires Rust toolchain):

```bash
cargo install --git https://github.com/KiryuuLight/zellij-agent-attention zellij-agent-attention
# or
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/zellij-agent-attention.wasm ~/.config/zellij/plugins/
```

### Step 2: Add to Zellij Config

Add to `~/.config/zellij/config.kdl`:

```kdl
load_plugins {
    "file:~/.config/zellij/plugins/zellij-agent-attention.wasm" {
        // All options are optional — defaults shown
        enabled "true"
        waiting_icon "⏳"
        completed_icon "✅"
    }
}
```

The plugin loads in the background with no visible pane — it won't consume any screen space.

### Step 3: Install zj-radar (Recommended)

zj-radar provides robust producer hooks with self-limiting pipe sends, smart status derivation, and edge-case handling. Install it:

**With Cargo:**

```bash
cargo install zj-radar
```

**Or from releases** (no Rust toolchain needed):

```bash
curl -L https://github.com/KiryuuLight/zj-radar/releases/latest/download/zj-radar-installer.sh | sh
```

Verify installation:

```bash
which zj-radar
```

### Step 4: Set Up Your Agent

#### Claude Code

```bash
zj-radar setup claude
```

This installs hooks into `~/.claude/settings.json` that broadcast `zj_radar.status.v1` on agent lifecycle events (tool use, notifications, session start/stop).

#### Cursor

Create `.cursor/hooks.json` in your project root (or `~/.cursor/hooks.json` for global):

```json
{
  "hooks": {
    "sessionStart": [{"command": "zj-radar notify generic --status running --source cursor"}],
    "stop": [{"command": "zj-radar notify generic --status done --source cursor"}],
    "postToolUseFailure": [{"command": "zj-radar notify generic --status error --source cursor"}]
  }
}
```

#### GitHub Copilot CLI

Create `.github/hooks/zj-radar.json` in your repository (or `~/.copilot/hooks/zj-radar.json` for personal):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{"command": "zj-radar notify generic --status running --source copilot"}],
    "agentStop": [{"command": "zj-radar notify generic --status done --source copilot"}],
    "errorOccurred": [{"command": "zj-radar notify generic --status error --source copilot"}],
    "notification": [{"command": "zj-radar notify generic --status pending --source copilot"}]
  }
}
```

#### opencode

[opencode](https://opencode.ai) supports native JS plugins, so no zj-radar CLI **and no WASM plugin** are needed — instead of broadcasting a pipe message, the plugin renames its own Zellij tab by id and clears on focus. Drop the bundled plugin into opencode's global (or project) plugin directory — it is loaded automatically at opencode startup:

```bash
mkdir -p ~/.config/opencode/plugins
cp opencode/zellij-attention.js ~/.config/opencode/plugins/
# or: curl -L https://raw.githubusercontent.com/jmander11/zellij-attention-multi-harness/main/opencode/zellij-attention.js \
#     -o ~/.config/opencode/plugins/zellij-attention.js
```

What it does (verified end-to-end):

- On load it captures its own tab id, so it renames exactly the tab the opencode pane lives in.
- The icon is cleared automatically by the tab-focus poll (every 1.5 s) — switch to that tab and the icon disappears — or by the matching event when the action is done.

| opencode event | Tab icon |
|---|---|
| `session.idle` — turn finished (only after a real turn ran; suppressed on the active tab). Shows ✅ even if the turn hit a transient error along the way | ✅ |
| `session.error` — a real error needs attention. Overwritten by ✅ if the turn recovers and completes; stays if the turn fails (never goes idle) | ⏳ |
| `question.asked` — a `question`-tool prompt is waiting for an answer | ⏳ |
| `question.replied` | clears ⏳ |
| `permission.asked` / `permission.updated` — still unanswered after a 300 ms debounce | ⏳ |
| `permission.replied` | clears ⏳ |

Notes:

- No-op outside zellij (requires `ZELLIJ_PANE_ID`, which zellij sets automatically in pane environments)
- Subagent (e.g. explore) sessions are filtered out, so icons reflect the main session only
- ✅ is only shown for a turn that actually ran (a `busy`→`idle` transition); a resumed session's first turn is not swallowed
- A **completed** turn shows ✅ even if it hit a transient error (opencode fires `session.error` for retried rate-limits/timeouts too). Only a turn that genuinely **failed** (never goes idle) keeps the ⏳
- The `zellij` CLI is resolved from `~/.local/bin/zellij` or `/usr/local/bin/zellij` before falling back to `PATH`, so it works even when the remote shell's `PATH` omits it
- Activity log: `/tmp/opencode-zellij-attention.log`
- Takes effect on the next opencode start (plugins are not hot-reloaded)
- **Running opencode on a remote host over `ssh`?** See [SSH-SETUP.md](SSH-SETUP.md) — it covers forwarding the local zellij socket to the remote and wiring up `ZELLIJ_PANE_ID` / `ZELLIJ_SOCKET_DIR`.

#### pi

[pi](https://pi.dev) (Earendil's `@earendil-works/pi-coding-agent`) loads TypeScript/JS **extensions**, so no zj-radar CLI **and no WASM plugin** are needed — the extension renames its own Zellij tab by id and clears on focus, exactly like the opencode plugin. Drop the bundled extension into pi's user (or project) extensions directory — it is loaded automatically at pi startup:

```bash
mkdir -p ~/.pi/agent/extensions
cp pi/zellij-attention.js ~/.pi/agent/extensions/
# or: curl -L https://raw.githubusercontent.com/jmander11/zellij-attention-multi-harness/main/pi/zellij-attention.js \
#     -o ~/.pi/agent/extensions/zellij-attention.js
```

| pi event | Tab icon |
|---|---|
| `agent_settled` — a run finished and Pi is idle (not aborted, last turn not an error; only after a run started; suppressed on the active tab) | ✅ |
| `turn_end` with `outcome: "error"` — a turn failed. Overwritten by ✅ if a later turn recovers and the run settles; stays if the run ends errored | ⏳ |
| `ui_prompt_start` — a blocking UI prompt (an extension's confirm/input) is open, after a 300 ms debounce | ⏳ |
| `ui_prompt_end` | clears the prompt ⏳ (only if the icon came from a prompt) |
| `session_compact_failed` — a compaction failed and won't be retried (context stuck) | ⏳ |
| `agent_settled` with `aborted: true` — the user aborted (e.g. Escape) | clears the icon |

Notes:

- No-op outside zellij (requires `ZELLIJ_PANE_ID`, which zellij sets automatically in pane environments / `zssh` forwards)
- ✅ is only shown for a run that actually started (`agent_start`→`agent_settled`); a settle with no run is ignored
- A **completed** run shows ✅ even if an earlier turn hit a transient error (a later successful settle overwrites the ⏳). Only a run that ends errored keeps the ⏳
- The ⏳-on-prompt only appears if your pi loads a UI-prompt-based extension (e.g. a permission gate); pi has **no built-in** permission prompt
- The `zellij` CLI is resolved from `~/.local/bin/zellij` or `/usr/local/bin/zellij` before falling back to `PATH`, and resolves the session socket from `ZELLIJ_SOCKET_DIR` (set by `zssh`), so no `--socket` flag is needed
- Activity log: `/tmp/pi-zellij-attention.log`
- Takes effect on the next pi start (extensions are not hot-reloaded)
- **Running pi on a remote host over `ssh`?** `pi` lives in the shared home (`~/.local/bin/pi` → `~/.pi/agent/...`), so it's already present on the remote — no separate install. `zssh` exports `ZELLIJ_PANE_ID`/`ZELLIJ_SOCKET_DIR` and prepends `~/.local/bin` to the remote PATH, so both `pi` and the icons work with no extra setup (see [SSH-SETUP.md](SSH-SETUP.md)).
- **Two pi in one tab** (a split pane, or a local pi + a `zssh`-remote pi): both would otherwise race on the same tab name (one strips the icon while the other re-applies it, wedging it). The extension coordinates via a shared per-(session,tab) file `~/.zellij-attention/<session>/<tabId>.panes` (on shared NFS, so a local and a remote pi in the same tab agree); each line is `<paneId>\t<icon>\t<lastSeen>`. The **lowest fresh pane id** is the leader and the only instance that renames the tab; it renders the **worst** fresh icon across all instances (⏳ > ✅ > none), so a non-leader's attention still shows. A line is fresh for ~3 poll ticks; older lines (a killed/exited instance) are auto-pruned, so a dropped `ssh` (which kills the remote pi, not a clean shutdown) no longer wedges the tab. Writes are atomic (temp file + rename). The file is released on a clean `session_shutdown`. **Requirement:** both instances must derive the *same* session key — a local pi gets `ZELLIJ_SESSION_NAME` from zellij, but a `zssh`-remote pi only has it if `zssh` forwards it (the `zssh` in [SSH-SETUP.md](SSH-SETUP.md) exports `ZELLIJ_SESSION_NAME` = the local socket's basename). If a remote pi lacks it, it falls back to `basename(ZELLIJ_SOCKET_DIR)` and would use a *different* file than the local pi → the race returns.

### Step 5: Restart Zellij and Test

Restart Zellij, then send a test notification from inside a Zellij pane:

```bash
# zj-radar format
zellij pipe --name zj_radar.status.v1 -- '{"pane":{"id":'$ZELLIJ_PANE_ID'},"status":"pending"}'

# Legacy format (also works)
zellij pipe --name "zellij-attention::waiting::$ZELLIJ_PANE_ID"
```

Switch to the tab — the ⏳ icon should appear. Focus the pane to clear it.

## Status Mapping

| zj-radar status | Tab icon | Meaning |
|---|---|---|
| `pending` | ⏳ | Agent needs user input |
| `error` | ⏳ | Agent encountered an error |
| `done` | ✅ | Agent finished the task |
| `running` | (none) | Agent is working — no action needed |
| `idle` | (none) | Agent is idle — no action needed |

## Legacy Claude Code Integration (No zj-radar)

If you don't want to install zj-radar, Claude Code can send notifications directly. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "zellij pipe --name \"zellij-attention::waiting::$ZELLIJ_PANE_ID\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "zellij pipe --name \"zellij-attention::completed::$ZELLIJ_PANE_ID\""
          }
        ]
      }
    ]
  }
}
```

> **Note:** If migrating from zellij-attention's native Claude hooks to zj-radar, remove the above `Notification` and `Stop` sections from `~/.claude/settings.json`, then run `zj-radar setup claude`. Leaving both creates harmless but wasteful dual broadcasts.

## Configuration

All configuration is optional — the plugin works out of the box.

| Option           | Default  | Description                     |
| ---------------- | -------- | ------------------------------- |
| `enabled`        | `"true"` | Enable or disable notifications |
| `waiting_icon`   | `"⏳"`   | Icon for waiting state          |
| `completed_icon` | `"✅"`   | Icon for completed state        |

Icons are appended to the end of tab names (e.g., `terminal ⏳`).

## Pipe Message Format

### Legacy format

```
zellij-attention::EVENT_TYPE::PANE_ID
```

- `EVENT_TYPE` — `waiting` or `completed` (case-insensitive)
- `PANE_ID` — numeric pane ID from `$ZELLIJ_PANE_ID`

### zj-radar format

Pipe name: `zj_radar.status.v1`

Payload (JSON):

```json
{"pane":{"type":"terminal","id":12},"status":"pending"}
```

- `pane.id` — numeric pane ID
- `status` — `pending`, `error`, `done`, `running`, or `idle`

> **Important:** Always use `--name` (broadcast pipe), never `--plugin` (targeted). Targeted pipes create new plugin instances instead of reaching existing ones.

## Shell Functions

For manual testing or integration with other tools, add to your shell profile:

```bash
notify-waiting() {
    [ -z "$ZELLIJ_PANE_ID" ] && echo "Not in Zellij" && return 1
    zellij pipe --name "zellij-attention::waiting::$ZELLIJ_PANE_ID"
}

notify-completed() {
    [ -z "$ZELLIJ_PANE_ID" ] && echo "Not in Zellij" && return 1
    zellij pipe --name "zellij-attention::completed::$ZELLIJ_PANE_ID"
}
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Icons not appearing | Verify plugin is loaded: check Zellij log for `zellij-agent-attention: v0.4.0 loaded` |
| Parse errors | Check `/tmp/zellij-attention.log` |
| zj-radar not found | Verify `which zj-radar` returns a path; reinstall if needed |
| Wrong Zellij version | Ensure `zellij --version` ≥ 0.44.3 |
| Stale icons after rebuild | Clear Zellij cache: `find ~/.cache/zellij -path "*zellij-agent-attention*" -exec rm -f {} \;` |

## Development

```bash
# Build
cargo build --target wasm32-wasip1 --release

# Install
cp target/wasm32-wasip1/release/zellij-agent-attention.wasm ~/.config/zellij/plugins/

# Debug build (enables verbose logging)
cargo build --target wasm32-wasip1
tail -f /tmp/zellij-*/zellij-log-*/zellij.log | grep "zellij-agent-attention"
```

## License

MIT
