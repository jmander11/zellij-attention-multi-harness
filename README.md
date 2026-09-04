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

[opencode](https://opencode.ai) supports native JS plugins, so no zj-radar CLI is needed. Drop the bundled plugin into opencode's global (or project) plugin directory — it is loaded automatically at opencode startup:

```bash
mkdir -p ~/.config/opencode/plugins
cp opencode/zellij-attention.js ~/.config/opencode/plugins/
# or: curl -L https://raw.githubusercontent.com/jmander11/zellij-attention-multi-harness/main/opencode/zellij-attention.js \
#     -o ~/.config/opencode/plugins/zellij-attention.js
```

What it broadcasts (verified end-to-end):

| opencode event | zj-radar status | Tab icon |
|---|---|---|
| `session.idle` — turn finished (initial idle on startup is suppressed) | `done` | ✅ |
| `session.error` | `error` | ⏳ |
| `permission.asked` / `permission.updated` — still unanswered after a 300 ms debounce | `pending` | ⏳ |

Notes:

- No-op outside zellij (requires `ZELLIJ_PANE_ID`, which zellij sets automatically in pane environments)
- Subagent (e.g. explore) sessions are filtered out, so icons reflect the main session only
- Reads `$ZELLIJ_PANE_ID` at event time, so tab kill/recreate renumbering is handled
- Activity log: `/tmp/opencode-zellij-attention.log`
- Takes effect on the next opencode start (plugins are not hot-reloaded)

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
