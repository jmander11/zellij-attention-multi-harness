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
- **zj-radar integration** — accepts `zj_radar.status.v1` broadcasts from Claude Code, Cursor, and Copilot

## Installation

### Pre-built WASM

```bash
mkdir -p ~/.config/zellij/plugins
curl -L https://github.com/KiryuuLight/zellij-agent-attention/releases/latest/download/zellij-agent-attention.wasm \
  -o ~/.config/zellij/plugins/zellij-agent-attention.wasm
```

### Source Build

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/zellij-agent-attention.wasm ~/.config/zellij/plugins/
```

### Config

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

## Quick Start

After installing, restart Zellij and test with a pipe command:

```bash
# Send a waiting notification to the current pane (legacy format)
zellij pipe --name "zellij-attention::waiting::$ZELLIJ_PANE_ID"

# Send a completed notification
zellij pipe --name "zellij-attention::completed::$ZELLIJ_PANE_ID"

# Send via zj-radar format
zellij pipe --name zj_radar.status.v1 -- '{"pane":{"id":'$ZELLIJ_PANE_ID'},"status":"pending"}'
```

Switch to the tab — the icon should appear. Focus the pane to clear it.

## Producer Setup

The plugin accepts `zj_radar.status.v1` broadcasts. Set up producers with [zj-radar](https://github.com/KiryuuLight/zj-radar):

```bash
cargo install zj-radar
```

### Claude Code

```bash
zj-radar setup claude
```

This installs clean hooks that broadcast `zj_radar.status.v1` on agent lifecycle events.

### Cursor CLI

Create `.cursor/hooks.json`:

```json
{
  "hooks": {
    "sessionStart": [
      {"type": "command", "command": "zj-radar notify generic --status running --source cursor"}
    ],
    "stop": [
      {"type": "command", "command": "zj-radar notify generic --status done --source cursor"}
    ],
    "postToolUseFailure": [
      {"type": "command", "command": "zj-radar notify generic --status error --source cursor"}
    ]
  }
}
```

### GitHub Copilot CLI

Create `.github/hooks/zj-radar.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {"type": "command", "command": "zj-radar notify generic --status running --source copilot"}
    ],
    "agentStop": [
      {"type": "command", "command": "zj-radar notify generic --status done --source copilot"}
    ],
    "errorOccurred": [
      {"type": "command", "command": "zj-radar notify generic --status error --source copilot"}
    ],
    "notification": [
      {"type": "command", "command": "zj-radar notify generic --status pending --source copilot"}
    ]
  }
}
```

## Status Mapping

| zj-radar status | Tab icon |
|---|---|
| `pending` | ⏳ |
| `error` | ⏳ |
| `done` | ✅ |
| `running` | (none) |
| `idle` | (none) |

`running` and `idle` are intentionally ignored — the agent is working and needs no user attention.

## Legacy Claude Code Integration

For direct integration without zj-radar, add to `~/.claude/settings.json`:

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

| Hook           | Notification | Meaning                  |
| -------------- | ------------ | ------------------------ |
| `Notification` | ⏳ waiting   | Claude needs user input  |
| `Stop`         | ✅ completed | Claude finished the task |

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

For manual testing or integration with other tools:

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

## Troubleshooting

- Check `/tmp/zellij-attention.log` for parse errors
- Verify `zj-radar` CLI is on PATH: `which zj-radar`
- Ensure Zellij ≥ 0.44.3
- After rebuilding WASM, clear Zellij cache: `find ~/.cache/zellij -path "*zellij-agent-attention*" -exec rm -f {} \;`

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for more common issues.

## License

MIT
