# Project Instructions

## Project Overview

Zellij WASM plugin that adds notification icons to tab names when panes need attention. Accepts both the legacy `zellij-attention::` pipe format and the `zj_radar.status.v1` wire format from zj-radar producers (Claude Code, Cursor, Copilot).

**Flow:** External process → `zellij pipe` → plugin updates tab name → focus clears notification.

- Legacy: `zellij pipe --name "zellij-attention::EVENT::PANE_ID"`
- zj-radar: `zellij pipe --name "zj_radar.status.v1" -- '{"pane":{"id":N},"status":"pending"}'`

## Architecture

- `src/main.rs` — Plugin registration entry point
- `src/lib.rs` — Core plugin logic: event handling, tab renaming, pipe dispatch, focus clearing
- `src/radar.rs` — zj-radar wire format parser (`zj_radar.status.v1` JSON payloads)
- `src/config.rs` — User configuration parsing (enabled, waiting_icon, completed_icon)
- `src/state.rs` — NotificationType enum (Waiting, Completed)
- Build target: `wasm32-wasip1` (Zellij WASM plugin)

## Pipe Dispatch

Name-based dispatch in `pipe()`:
1. `pipe_message.name == "zj_radar.status.v1"` — parse JSON, map status, set notification
2. `pipe_message.name` starts with `zellij-attention::` — legacy format handling
3. All other names — ignored, return false

## Status Mapping (zj-radar → notification)

| zj-radar `status` | NotificationType | Icon |
|---|---|---|
| `pending` | `Waiting` | ⏳ |
| `error` | `Waiting` | ⏳ |
| `done` | `Completed` | ✅ |
| `running` | no-op (ignored) | — |
| `idle` | no-op (ignored) | — |

`running`/`idle` are intentionally ignored to avoid noisy tab icons — the agent is working and needs no user attention.

## Key Design Decisions

- **Single global plugin instance** via `load_plugins` in `config.kdl` (no visible pane)
- **Notification state:** `HashMap<u32, HashSet<NotificationType>>` — pane_id → notification set. Latest event **replaces** (no stacking per pane)
- **Tab-level priority:** If any pane in a tab has Waiting, tab shows ⏳. Only shows ✅ if no Waiting exists.
- **No position-keyed caches** — original tab names derived via `strip_icons()` at rename time, making tab reordering safe
- **`rename_tab()` is 1-indexed** — Zellij API quirk, always pass `position + 1`
- **`updating_tabs` flag** prevents re-entrancy from `rename_tab()` → `TabUpdate` → `update_tab_names()` loop
- **Load-bearing invariant:** `unblock_cli_pipe_input` must be called on every `pipe()` exit path. Omitting it causes `zellij pipe` callers to hang indefinitely, eventually triggering EMFILE and crashing the session.

## Parse Failure Handling

zj-radar JSON parse failures are silently ignored. Errors are appended to `/tmp/zellij-attention.log` with timestamps. Falls back to `eprintln` if the log file is unwritable.

## Zellij Plugin Gotchas

- Use broadcast pipes (`zellij pipe --name`) NOT targeted pipes (`--plugin`) — targeted pipes create new instances due to config mismatch
- Plugin state must use `/host/` path (shared), NOT `/data/` (sandboxed per-instance)
- `load_plugins` in config.kdl supports configuration via plugin aliases or inline config blocks
- Plugin pane IDs overlap with terminal pane IDs — always filter `is_plugin` when mapping panes
- `rename_tab()` triggers a synchronous `TabUpdate` event — beware of race conditions between rename and the resulting event
- `load_plugins` plugins may be lost after session resurrection (zellij attach) — see [#4156](https://github.com/zellij-org/zellij/issues/4156)
- After rebuilding WASM, clear Zellij cache: `find ~/.cache/zellij -path "*zellij-agent-attention*" -exec rm -f {} \;`

## Build & Test

```bash
# Build
cargo build --release --target wasm32-wasip1

# Install
cp target/wasm32-wasip1/release/zellij-agent-attention.wasm ~/.config/zellij/plugins/

# Test legacy format
zellij pipe --name "zellij-attention::waiting::$ZELLIJ_PANE_ID"
zellij pipe --name "zellij-attention::completed::$ZELLIJ_PANE_ID"

# Test zj-radar format
zellij pipe --name zj_radar.status.v1 -- '{"pane":{"id":12},"status":"pending"}'
zellij pipe --name zj_radar.status.v1 -- '{"pane":{"id":12},"status":"done"}'
```
