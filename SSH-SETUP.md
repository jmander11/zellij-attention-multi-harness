# Setting up opencode-over-SSH with zellij-attention

This guide covers the case where **opencode runs on a remote host (over `ssh`)** but the
**zellij server runs on your local machine**. This is the "Dylan tab" scenario: a zellij
tab is an `ssh` session, and the opencode inside it lives on the remote box.

The local (same-host) case is simpler and is covered in the main [README](README.md) —
you only need this doc when the agent process and the zellij server are on different
machines.

## Why this is non-trivial

The opencode plugin (`opencode/zellij-attention.js`) drives zellij by shelling out to the
`zellij` CLI (`zellij action rename-tab-by-id ...`, `list-panes`, `current-tab-info`).
For that to work across `ssh`, three things must be true on the **remote** side:

1. **A `zellij` CLI is installed** and can reach the **local** zellij server.
2. **`ZELLIJ_PANE_ID`** is set in the remote shell (so the plugin knows which local pane
   it is). `ssh` does **not** forward this variable automatically.
3. **`ZELLIJ_SOCKET_DIR`** points at a copy of the local server's socket, forwarded over
   the ssh connection (the real socket lives in the local `/run/user/...`, which the
   remote cannot see).

If any of these is missing, the plugin silently no-ops (it now logs a line to
`/tmp/opencode-zellij-attention.log` explaining which one).

## How it works

```
 local machine (zellij server)                 remote machine (opencode)
 ┌──────────────────────────────┐   ssh -R    ┌──────────────────────────────┐
 │ /run/user/<uid>/zellij/      │ ──────────▶ │ /tmp/zellij-sock/.../main    │
 │   contract_version_1/<sess>  │  (unix sock │  (forwarded socket)         │
 │                              │   forward)  │        │                     │
 │  zellij server (session)     │             │        ▼                     │
 │                              │             │  zellij CLI (ZELLIJ_SOCKET_  │
 │                              │             │  DIR=/tmp/zellij-sock)      │
 │                              │             │        │                     │
 │                              │             │  opencode plugin → renames  │
 │                              │             │  the LOCAL tab by id        │
 └──────────────────────────────┘             └──────────────────────────────┘
```

- `ssh -R` forwards the **local** session socket to a path on the **remote**.
- The remote `zellij` CLI is pointed at that forwarded path via `ZELLIJ_SOCKET_DIR`.
- `ZELLIJ_PANE_ID` is expanded **locally** before ssh runs, so it lands in the remote
  shell without needing `AcceptEnv`/root on the remote.

## One-time setup

### 1. Install the zellij CLI on the remote

It must be the **same version** as your local zellij server (the socket contract is
versioned). Put it where the plugin looks: `~/.local/bin/zellij` or `/usr/local/bin/zellij`
(the plugin resolves these paths automatically, so it does **not** need to be on `PATH`).

```bash
# On the REMOTE host. Replace 0.44.3 with your local `zellij --version`.
VER=$(ssh <remote> 'zellij --version 2>/dev/null || echo 0.44.3')   # or hard-code it
ssh <remote> "
  set -e
  cd /tmp
  curl -sL -o zellij.tar.gz https://github.com/zellij-org/zellij/releases/download/v${VER}/zellij-x86_64-unknown-linux-musl.tar.gz
  tar xzf zellij.tar.gz
  install -m 755 zellij \$HOME/.local/bin/zellij
  ~/.local/bin/zellij --version
"
```

> If the remote shares your home directory over NFS (as in the work setup), installing
> once makes it visible from both hosts. If not, install on each remote you use.

### 2. Find your local socket path

```bash
# List the local zellij session sockets:
ls /run/user/$(id -u)/zellij/contract_version_1/
# e.g. -> main        (the socket name is your session name)
```

Your local socket path is therefore:

```
/run/user/$(id -u)/zellij/contract_version_1/<session-name>
```

Confirm the session name with `zellij list-sessions` (or the `zellij --server ...` process
args). In the work setup it was `/run/user/57296/zellij/contract_version_1/main`.

## The shell functions

Add to your **local** shell rc (`~/.zshrc` / `~/.bashrc`). Two variants are provided so
you can have **two** remote tabs at once (each needs its own remote socket path, because
OpenSSH leaves the `-R` socket file behind on disconnect and a second bind to the same
path fails).

```zsh
# zssh / zssh2: ssh to a remote with zellij-attention wired up.
#
# Fill these in for your environment:
export ZSSH_HOST="orw-sdedev-01.wv.mentorg.com"          # your remote host
export ZSSH_LOCAL_SOCK="/run/user/57296/zellij/contract_version_1/main"  # from step 2

_zssh() {
  local tag=$1
  local rdir="/tmp/zellij-sock${tag}"
  local host="${ZSSH_HOST:?set ZSSH_HOST}"
  local localsock="${ZSSH_LOCAL_SOCK:?set ZSSH_LOCAL_SOCK}"
  # OpenSSH leaves the -R socket file behind on disconnect, so clear it first
  # (and create the dir in case the remote /tmp was wiped by a reboot).
  ssh -o BatchMode=yes "$host" \
    "mkdir -p $rdir/contract_version_1; rm -f $rdir/contract_version_1/main" 2>/dev/null
  # -t forces a pty (the remote command would otherwise run non-interactively and the
  # remote zsh would show no prompt). $ZELLIJ_PANE_ID expands LOCALLY.
  ssh -t -R "$rdir/contract_version_1/main:$localsock" \
    "$host" \
    "export ZELLIJ_PANE_ID=$ZELLIJ_PANE_ID ZELLIJ_SOCKET_DIR=$rdir; exec zsh"
}
zssh()  { _zssh ""; }
zssh2() { _zssh "_2"; }
```

Then, in a zellij tab:

1. New tab (`Ctrl t` → `n`, or your equivalent).
2. Run `zssh` (or `zssh2` for a second remote tab).
3. Rename the tab, start opencode in it. The plugin picks up `ZELLIJ_PANE_ID` +
   `ZELLIJ_SOCKET_DIR` from the environment and starts renaming the tab.

## Important caveats (learned the hard way)

- **Use `/tmp` on the remote, not the NFS home.** OpenSSH does **not** unlink the `-R`
  unix socket on disconnect. On a local fs the stale file is harmless (the pre-step
  `rm -f` clears it); on NFS the stale file breaks the next bind, so reconnections fail.
- **One connection per socket path.** Don't open two `zssh` connections (same path) at
  once — the second's pre-step `rm -f` yanks the socket out from under the first. Use
  `zssh2` (a different path) for the second tab.
- **`-t` is required.** Without it the remote `zsh` starts non-interactive (no prompt) and
  looks hung.
- **Restart opencode to pick up plugin changes.** Plugins load at startup, not hot.
- **Pane ids are stable for the life of the pane** but are renumbered when tabs are
  closed/recreated. `zssh` reads `$ZELLIJ_PANE_ID` at connect time, so reconnect after
  recreating a tab.

## Verifying

From the remote shell (after `zssh`):

```bash
echo "$ZELLIJ_PANE_ID $ZELLIJ_SOCKET_DIR"     # both must be non-empty
~/.local/bin/zellij action list-tabs           # must list your LOCAL tabs
```

Then run a turn in opencode and watch the local tab bar: ✅ appears when the turn
finishes (suppressed while you're sitting in that tab), ⏳ when it needs input or errors.

## Troubleshooting

- **No icons at all** — check the remote log:
  `ssh <remote> 'tail /tmp/opencode-zellij-attention.log'`.
  - `plugin no-op: ZELLIJ_PANE_ID not set` → you're not in a zellij pane, or you used
    plain `ssh` instead of `zssh`.
  - `plugin loaded (pane=N tab=none ...)` → the tab lookup failed; the `zellij` CLI
    couldn't reach the server. Verify `~/.local/bin/zellij action list-tabs` works in the
    remote shell and that the `-R` forward is alive (re-run `zssh`).
  - `zellij spawn failed (...)` → the CLI binary wasn't found; install it (step 1).
- **Stale icon after a reconnect** — re-run `zssh` (the pre-step clears the old socket)
  and restart opencode.
- **Wrong zellij version on the remote** — the CLI and server must match; rebuild/reinstall
  the remote binary to the server's version.
