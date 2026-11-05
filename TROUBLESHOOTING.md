# Troubleshooting

## Notifications not appearing

1. **Check plugin is loaded:**
   - Verify `load_plugins` is configured in your `config.kdl`
   - Check Zellij logs: `tail -f /tmp/zellij-*/zellij-log-*/zellij.log` (look for `zellij-attention: loaded`)

2. **Verify pipe commands work:**
   ```bash
   echo $ZELLIJ_PANE_ID  # Should print a number
   zellij pipe --name "zellij-attention::waiting::$ZELLIJ_PANE_ID"
   # Tab name should change immediately
   ```

3. **Clear Zellij plugin cache:**
   ```bash
   # Zellij caches compiled WASM — clear if the plugin isn't updating
   find ~/.cache/zellij -path "*zellij-attention*" -exec rm -f {} \;
   ```

## Plugin not loading

- Verify the plugin is in `load_plugins` in your `config.kdl` with the correct file path
- Check that the `.wasm` file exists at `~/.config/zellij/plugins/zellij-attention.wasm`

## Pipe command hangs or does nothing

- Ensure you're using the `--name` flag (broadcast), NOT `--plugin` (targeted)
- Check `$ZELLIJ_PANE_ID` is set: `echo $ZELLIJ_PANE_ID`
- Verify the format uses double-colon separators: `zellij-attention::EVENT_TYPE::PANE_ID`

### Wrong format examples

**Correct:**
```bash
zellij pipe --name "zellij-attention::waiting::5"
```

**Common mistakes:**
```bash
# WRONG: Single colon
zellij pipe --name "zellij-attention:waiting:5"

# WRONG: Missing plugin name prefix
zellij pipe --name "waiting::5"

# WRONG: Using --plugin instead of --name
zellij pipe --plugin "zellij-attention" --message "waiting::5"
```

## Icons stop appearing or stale icons remain after a tab was closed

Observed on zellij 0.44.3: closing a tab (`Ctrl-o x`) can also stop the background
attention plugin instance (it exited in the same log burst as the tab's own
tab-bar/status-bar plugins, and was not restarted automatically).

1. **Check the log** for a `Bye from plugin <N>` with no later `zellij-attention: v... loaded`:
   ```bash
   grep -E 'Bye from plugin|zellij-attention' /tmp/zellij-*/zellij-log/zellij.log | tail -10
   ```
2. **Reload the plugin** — this also force-clears any stale icons (state is memory-only and
   is stripped on startup):
   ```bash
   zellij action start-or-reload-plugin "file:~/.config/zellij/plugins/zellij-agent-attention.wasm"
   ```
3. Note that pane IDs are renumbered when tabs are killed/recreated. Producers must read
   `$ZELLIJ_PANE_ID` at event time (the bundled opencode plugin does), never cache it.

## Tabs not restoring original names

- This is expected if notifications are still active on other panes in the same tab
- Focus the pane with the notification to clear it — the tab name restores automatically
- To force-clear all notifications, restart the Zellij session (state is memory-only)

## Remote pi not rendering icons (zssh / zssh2)

Symptom: the tab's remote pi is alive (its line in `~/.zellij-attention/<session>/<tab>.panes`
keeps updating, and the remote `/tmp/pi-zellij-attention.log` shows state changes like
`clearDoneIcon tab=N`) but ✅/⏳ never appear on the tab — the log has state changes but
no `renderIcon tab=N` lines. Cause: the pane's reverse-tunnel socket is missing on the
remote (the ssh died — pane closed, network blip, remote reboot — and nothing re-created it),
so the remote pi's `zellij action` calls fail with "There is no active session!".

1. **Check the pane's tunnel socket** (`<pane>` is the pane's `ZELLIJ_PANE_ID`):
   ```bash
   ssh <remote> "ls /tmp/zellij-sock*_p<pane>/contract_version_1/ 2>/dev/null"
   ```
   An empty or missing dir = dead tunnel. (Per-pane dirs: each zssh pane owns
   `/tmp/zellij-sock<tag>_<session>_p<pane>` — see SSH-SETUP.md.)
2. **Connections made outside zellij** (no `ZELLIJ_PANE_ID`) use the shared
   `/tmp/zellij-sock<tag>_<session>` dir instead — check that one:
   ```bash
   ssh <remote> "ls -d /tmp/zellij-sock*/contract_version_1/ 2>/dev/null | grep -v _p"
   ```
3. **Fix: re-run `zssh`/`zssh2` in that pane.** The pre-step clears the stale socket and
   the new `-R` forward re-creates it. The pi's down-backoff recovers automatically once
   the socket exists again (its log shows `zellij server back up (was down Ns)`).
4. Verify from the remote shell: `ZELLIJ_SOCKET_DIR=<dir> ~/.local/bin/zellij action list-tabs`
   must list your LOCAL tabs.
