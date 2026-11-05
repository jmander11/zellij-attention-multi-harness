// Bridges pi attention state to ITS OWN zellij tab (producer-side; no WASM plugin needed).
//   ⏳  pi hit a turn error, a compaction failed, or is waiting on a blocking UI prompt
//   ✅  the AI is done and waiting on YOU (a run settled cleanly, not aborted, and no
//       background subagents are still running)
//
// The icon only reflects "the AI is waiting on the user". A run started by a pi-subagents
// completion/attention wake (a custom "subagent*" message, or the fixed PARENT_WAKE_TEXT steer
// prompt) is classified as a subagent run and never raises an icon on its own. While any
// background subagent is still active (tracked via pi-subagents' start/complete events + a disk
// resync on resume), a "done" ✅ is suppressed — the AI is waiting on a subagent, not on you. ✅
// appears only when the LAST subagent's wake settles (or a plain user run settles with none
// active). Without this, a cascade of subagent wakes flaps the icon on/off and hammers the
// zellij CLI, which loads zellij's CPU. Blocking UI prompts (the agent asking a question) and
// compaction failures are main-agent signals and still raise ⏳ regardless of run origin.
//
// Each pi instance manages its tab's icon: it renames the tab with
// `zellij action rename-tab-by-id <tabId> <name>` to add an icon, and clears it by
// polling `zellij action current-tab-info` — the moment the user switches to this tab,
// the icon is stripped (clear-on-focus). The zellij CLI resolves the session socket from
// ZELLIJ_SOCKET_DIR (exported by zssh), so no --socket flag is needed. This bypasses the
// zellij WASM plugin subsystem entirely, so it is immune to a wedged/slow plugin thread.
//
// When MULTIPLE pi instances share a tab (a split pane, or a local pi + a zssh-remote pi),
// they coordinate via a shared per-(session,tab) file under $HOME (shared NFS in the zssh
// setup): `~/.zellij-attention/<session>/<tabId>.panes`, one line per live instance
// (`<paneId>\t<icon>\t<lastSeen>`). The LOWEST fresh pane id is the leader and the only
// instance that renames the tab; it renders the WORST fresh icon across all instances
// (⏳ > ✅ > none), so a non-leader's attention still shows. A line is fresh for ~3 poll
// ticks; older lines (a killed/exited instance) are pruned, so a dead leader can't wedge
// the tab. Writes are atomic (temp file + rename) so a concurrent reader never sees a torn
// file. No-op outside zellij (requires ZELLIJ_PANE_ID, set automatically in zellij panes /
// by zssh).
//
// Install: place in ~/.pi/agent/extensions/ (global) or a project extensions dir.
// The zellij-agent-attention WASM plugin must be disabled (config.kdl: enabled "false"),
// otherwise it will strip these icons as "stale".
//
// Ported from opencode/zellij-attention.js. Differences: pi events (agent_start / turn_end /
// agent_settled / ui_prompt_* / session_compact_failed) instead of opencode's session.* events,
// and pi.exec() (with a timeout) instead of a manual child_process spawn.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_FILE = "/tmp/pi-zellij-attention.log";
const ICON_DONE = "✅";
const ICON_WAIT = "⏳";
const POLL_INTERVAL_MS = 1500;
const PROMPT_DEBOUNCE_MS = 300;
const ZELLIJ_TIMEOUT_MS = 2500;
// After the zellij server (re)starts there is a short race window: a short-lived `zellij action`
// CLI client that connects before the first interactive client has created the session can make
// the server panic (zellij 0.44.3: RemoveClient processed while session_data is still None).
// When we detect the server just came back up (a CLI call succeeds after a run of failures) we
// hold off on CLI calls for this long so we don't land in that window.
const STARTUP_GRACE_MS = 5000;
// While the zellij server is DOWN (CLI calls keep failing), probe at most this often instead of
// every poll tick, so we don't hammer a dead/broken server with a fresh `zellij action` process
// every 1.5s. A successful probe ends the down state and starts the STARTUP_GRACE_MS window.
const DOWN_PROBE_INTERVAL_MS = 10000;
// Stable prefix of pi-subagents' PARENT_WAKE_TEXT (the steer prompt it uses to wake the parent
// for a subagent completion/attention). A user-message run whose prompt starts with this is a
// subagent wake, not a real user prompt. Coupled to pi-subagents; if that text changes, subagent
// wakes would be misread as user runs and start raising icons again.
const SUBAGENT_WAKE_PREFIX = "Inspect subagent updates above";
// A shared-file line is "fresh" for this long; older lines (a killed/exited instance that
// never ran session_shutdown) are pruned and excluded from the election, so a dead leader
// can't wedge the tab. ~3 poll ticks.
const STALE_TTL_MS = 3 * POLL_INTERVAL_MS;
// Per-(session,tab) shared-state dir. Lives under $HOME (shared NFS in the zssh setup) so a
// local pi and a zssh-remote pi in the SAME tab coordinate via the same file. Each file
// `<session>/<tabId>.panes` holds one line per live instance: `<paneId>\t<icon>\t<lastSeen>`.
// The LOWEST fresh pane id is the leader and the only instance that renames the tab; it
// renders the WORST fresh icon across all instances (⏳ > ✅ > none). This prevents two
// writers racing on rename-tab-by-id and lets a non-leader's attention show on the tab.
const LEADER_DIR = path.join(process.env.HOME ?? "/tmp", ".zellij-attention");

// The zellij CLI may not be on PATH (e.g. pi running over ssh, where the remote shell's
// PATH lacks the dir zellij was installed into). Resolve a known location first.
function resolveZellijBin() {
  const home = process.env.HOME ?? "";
  const candidates = home
    ? [path.join(home, ".local/bin/zellij"), "/usr/local/bin/zellij"]
    : ["/usr/local/bin/zellij"];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return "zellij";
}
const ZELLIJ_BIN = resolveZellijBin();

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function paneId() {
  const raw = process.env.ZELLIJ_PANE_ID;
  if (!raw) return null;
  const id = Number(raw);
  // Zellij pane ids are 0-indexed, so 0 is a valid pane (the first tab).
  return Number.isInteger(id) && id >= 0 ? id : null;
}

// Stable key for the zellij session, used to namespace the shared-state file so two
// sessions that both have a tab with the same id don't elect a single leader across
// sessions. Prefer ZELLIJ_SESSION_NAME; fall back to the socket-dir basename (zssh sets
// ZELLIJ_SOCKET_DIR); else "local". Sanitized to a safe path component.
function sessionKey() {
  let k = (process.env.ZELLIJ_SESSION_NAME ?? "").trim();
  if (!k) {
    const d = process.env.ZELLIJ_SOCKET_DIR;
    if (d) k = path.basename(d);
  }
  if (!k || k === "." || k === "/") k = "local";
  return k.replace(/[^A-Za-z0-9._-]/g, "_");
}

export default function (pi) {
  // Outside zellij there is nothing to do. (paneId() is 0 for the first tab, so compare
  // against null, not truthiness — `!0` is true and would wrongly bail out.)
  if (paneId() == null) {
    log("extension no-op: ZELLIJ_PANE_ID not set (outside zellij, or env not forwarded over ssh)");
    return;
  }
  const mySessionKey = sessionKey();

  // Run `zellij action <args...>`; resolve with stdout (string) or null on error/timeout.
  // pi.exec inherits the parent env, so ZELLIJ_SOCKET_DIR (set by zssh) reaches the CLI.
  // NOTE: pi's exec coalesces a signal-killed child's exit code to 0, so a TIMED-OUT call
  // resolves { code: 0, killed: true, stdout: "" }. Treat `killed` as failure (return null) —
  // otherwise a timed-out rename-tab-by-id is reported as success and clearIcon() stops the
  // poll, wedging the icon on the tab (the exact failure the retry-on-failed-rename design
  // exists to prevent).
  async function runZellij(args, timeoutMs = ZELLIJ_TIMEOUT_MS) {
    const now = Date.now();
    // Gate 1: suppress CLI calls during the post-(re)start grace window (startup race). This gate
    // is the single source of truth for "are we in grace?" and also covers event-handler CLI calls
    // (agent_settled / setIcon / clearIcon / ensureCleanup), which don't go through the poll tick.
    // A suppressed call is NOT "down", so it must not set serverDownSince (or the next real
    // success would log a spurious "server back up").
    if (inStartupGrace()) return null;
    // Gate 2: down backoff. While the server is down, probe at most every DOWN_PROBE_INTERVAL_MS
    // so we don't hammer a dead/broken server every poll tick. A skipped probe is not a new "down"
    // signal (already known down), so it must not touch serverDownSince.
    if (serverDownSince != null && now - lastProbeAt < DOWN_PROBE_INTERVAL_MS) {
      return null;
    }
    lastProbeAt = now;
    let out;
    try {
      const res = await pi.exec(ZELLIJ_BIN, ["action", ...args], { timeout: timeoutMs });
      out = res && res.code === 0 && !res.killed ? res.stdout : null;
    } catch {
      out = null;
    }
    // Track server up/down so the poll can back off across a server (re)start (see
    // STARTUP_GRACE_MS / DOWN_PROBE_INTERVAL_MS). A null result means the CLI call failed
    // (server down / timeout).
    if (out == null) {
      if (serverDownSince == null) serverDownSince = now;
    } else if (serverDownSince != null) {
      log(
        `zellij server back up (was down ${Math.round((now - serverDownSince) / 1000)}s); ` +
          `holding CLI calls ${STARTUP_GRACE_MS / 1000}s (startup race window)`,
      );
      startupGraceUntil = now + STARTUP_GRACE_MS;
      serverDownSince = null;
    }
    return out;
  }

  // True while we're in the post-(re)start grace window (skip zellij CLI calls).
  function inStartupGrace() {
    return Date.now() < startupGraceUntil;
  }

  // Stable id of the currently active zellij tab, or null (outside zellij / on timeout).
  async function activeTabId() {
    const out = await runZellij(["current-tab-info"]);
    if (!out) return null;
    const m = out.match(/^id:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  }

  // Find the tab containing this pi pane. Do not use current-tab-info here: a pi instance can
  // start/resume while another tab is active. Uses the JSON form so a pane's title/command/cwd
  // (which may contain "terminal_N") can't be mistaken for the pane id.
  async function tabIdForPane() {
    const id = paneId();
    if (id == null) return null;
    const out = await runZellij(["list-panes", "-a", "-j"]);
    if (!out) return null;
    let panes;
    try {
      panes = JSON.parse(out);
    } catch {
      return null;
    }
    if (!Array.isArray(panes)) return null;
    const pane = panes.find((p) => p && !p.is_plugin && p.id === id);
    return pane ? pane.tab_id : null;
  }

  // Stable id of the tab containing this pi pane. Null if it can't be determined yet; retried
  // lazily via ensureTabId() (e.g. if the CLI wasn't ready at load time, the extension would
  // otherwise no-op for the whole session). Dedup in-flight lookups.
  let myTabId = null;
  let tabIdInFlight = null;
  async function ensureTabId() {
    if (myTabId != null) return myTabId;
    if (!tabIdInFlight) {
      tabIdInFlight = tabIdForPane().then((t) => {
        myTabId = t;
        tabIdInFlight = null;
        return t;
      });
    }
    return tabIdInFlight;
  }

  let myIcon = null; // null | ICON_DONE | ICON_WAIT
  let iconSource = null; // "idle" | "error" | "prompt" | "compact"
  let pollTimer = null;
  let pollTick = 0; // counts poll ticks; the clear-on-focus check runs every few ticks, not all
  // Server (re)start detection: serverDownSince is set when a CLI call fails (server down) and
  // cleared when one succeeds; on that down->up transition we set startupGraceUntil so the poll
  // skips CLI calls for STARTUP_GRACE_MS (avoids the zellij startup RemoveClient race).
  let serverDownSince = null;
  let startupGraceUntil = 0;
  let lastProbeAt = 0; // last time we actually spawned a zellij CLI probe (for down backoff)
  let runActive = false; // a run (agent_start) is in progress
  let lastTurnOutcome = null; // "completed" | "aborted" | "error" | null
  // Origin of the in-progress run: "user" (a real prompt) or "subagent" (a pi-subagents
  // completion/attention wake). Only user runs may raise/clear the tab icon; subagent wakes must
  // not, or a cascade of completion wakes flaps the icon and hammers the zellij CLI. null (no
  // before_agent_start seen yet) is treated as user so a real run is never silently suppressed.
  let runOrigin = null; // "user" | "subagent" | null
  // The icon this instance last applied to the tab (leader only). Lets the always-on poll skip the
  // `list-tabs` CLI call when the desired icon is unchanged (steady state), so it no longer spawns
  // a process every tick. Reset to null when we stop being leader so a new leader re-reads the tab
  // before trusting the cache.
  let lastRenderedIcon = null;
  // Async subagent runs still active in THIS pi process (by run id). While non-empty the AI is
  // waiting on a subagent, not on the user, so no "done" ✅ is shown. Populated from pi-subagents'
  // start/complete events and re-synced from disk on session_start (resume).
  const activeSubagentRuns = new Set();

  // Start the always-on poll at load so every instance heartbeats into the shared file from
  // the start (membership + state), even before its first run. ensureCleanup() restarts it
  // per session.
  startPoll();

  // The NAME of our tab from `list-tabs` (TAB_ID POSITION NAME), or null.
  async function myTabName() {
    if (myTabId == null) return null;
    const out = await runZellij(["list-tabs"]);
    if (!out) return null;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m && Number(m[1]) === myTabId) return m[3].trim();
    }
    return null;
  }

  // Strip any attention-icon suffixes (in any order/count) from a tab name, returning the base.
  function stripIcon(name) {
    let r = name;
    let changed = true;
    while (changed) {
      changed = false;
      for (const ic of [ICON_DONE, ICON_WAIT]) {
        const suf = " " + ic;
        if (r.endsWith(suf)) {
          r = r.slice(0, r.length - suf.length);
          changed = true;
        }
      }
    }
    return r;
  }

  // Rename our tab to `base + (icon ? " " + icon : "")`. Best-effort: a failed rename is
  // retried by the poll (never assume it took, or a failed rename wedges the icon). Skips the
  // `list-tabs` CLI call entirely when the tab already shows `icon` (steady state), so the poll
  // doesn't spawn a process every tick.
  async function renderIcon(icon) {
    if (myTabId == null) return;
    if (lastRenderedIcon !== null && icon === lastRenderedIcon) return; // unchanged; no CLI call
    const name = await myTabName();
    if (name == null) return;
    const base = stripIcon(name);
    const target = icon ? `${base} ${icon}` : base;
    if (target === name) {
      lastRenderedIcon = icon; // tab already correct
      return;
    }
    const out = await runZellij(["rename-tab-by-id", String(myTabId), target]);
    if (out != null) {
      lastRenderedIcon = icon;
      log(`renderIcon tab=${myTabId} '${name}' -> '${target}'`);
    }
    // On failure (out == null) leave lastRenderedIcon unchanged so the next tick retries.
  }

  // The worst fresh icon across all instances: any ⏳ wins, else any ✅, else none.
  function worstIcon(lines) {
    let wait = false;
    let done = false;
    for (const l of lines) {
      if (l.icon === "wait") wait = true;
      else if (l.icon === "done") done = true;
    }
    return wait ? ICON_WAIT : done ? ICON_DONE : null;
  }

  // Only the per-(session,tab) leader renames the tab: two instances in one tab both
  // renaming would race (one strips the icon while the other re-applies it, wedging it).
  // The leader renders the WORST fresh icon across all instances (⏳ > ✅ > none); non-
  // leaders record their state in the shared file and defer to the leader. Fails CLOSED on
  // a real read error (skip this cycle; retry next tick) but fails OPEN when the file is
  // simply absent (a single instance is its own leader).
  async function renderIfLeader() {
    if ((await ensureTabId()) == null) return;
    const fresh = freshNow();
    if (fresh == null) return; // unreadable file: fail closed, retry next tick
    const leaderId = fresh.length ? Math.min(...fresh.map((l) => l.paneId)) : paneId();
    if (leaderId !== paneId()) {
      // Not the leader: don't trust our render cache; the next leader must re-read the tab.
      lastRenderedIcon = null;
      return;
    }
    // If no fresh lines (e.g. upsert failed to create the file), fall back to our own
    // icon rather than stripping it.
    await renderIcon(fresh.length ? worstIcon(fresh) : myIcon);
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // --- Per-(session,tab) shared-state election ------------------------------------------
  // Two pi instances in the SAME tab (e.g. a split pane, or a local pi + a zssh-remote pi)
  // would both drive the same tab name via rename-tab-by-id and race: one strips the icon
  // while the other re-applies it, wedging it. So they share a per-(session,tab) file under
  // $HOME (shared NFS in the zssh setup). Each line is `<paneId>\t<icon>\t<lastSeen>`; the
  // LOWEST fresh pane id is the leader and the only instance that renames the tab, and it
  // renders the WORST fresh icon across all instances (⏳ > ✅ > none). A line is "fresh"
  // for STALE_TTL_MS; older lines (a killed/exited instance) are pruned, so a dead leader
  // can't wedge the tab.
  function stateFile() {
    return path.join(LEADER_DIR, mySessionKey, `${myTabId}.panes`);
  }

  function iconToWire(icon) {
    return icon === ICON_WAIT ? "wait" : icon === ICON_DONE ? "done" : "none";
  }

  // Parse the shared file into [{paneId, icon, lastSeen}]; drop malformed lines.
  function parseLines(text) {
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [p, i, s] = l.split("\t");
        const id = Number(p);
        if (!Number.isInteger(id) || id < 0) return null;
        if (i !== "wait" && i !== "done" && i !== "none") return null;
        const ts = Number(s);
        return Number.isFinite(ts) ? { paneId: id, icon: i, lastSeen: ts } : null;
      })
      .filter(Boolean);
  }

  // Atomic write: write a temp file in the SAME dir, then rename over the target, so a
  // concurrent reader never observes a torn/empty file (the truncate-then-write race).
  function atomicWrite(file, content) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `${path.basename(file)}.tmp.${process.pid}`);
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  }

  // Read the shared file. Returns {ok:true, lines} (lines [] if absent) or {ok:false} on a
  // real read error (NFS EIO/EAGAIN, existing-but-unreadable) — callers fail CLOSED on that.
  function readState() {
    const file = stateFile();
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      return e && e.code === "ENOENT" ? { ok: true, lines: [] } : { ok: false };
    }
    return { ok: true, lines: parseLines(text) };
  }

  // The fresh lines (lastSeen within STALE_TTL_MS), or null if the file couldn't be read.
  function freshNow() {
    const now = Date.now();
    const st = readState();
    return st.ok ? st.lines.filter((l) => now - l.lastSeen <= STALE_TTL_MS) : null;
  }

  // Record this instance's line (paneId, current icon, lastSeen=now) and prune stale lines.
  // Idempotent + convergent: every writer computes the same result from a fresh read.
  function upsertSelf() {
    const id = paneId();
    if (id == null || myTabId == null) return;
    try {
      mkdirSync(path.dirname(stateFile()), { recursive: true });
      const st = readState();
      if (!st.ok) return;
      const now = Date.now();
      const kept = st.lines.filter(
        (l) => now - l.lastSeen <= STALE_TTL_MS && l.paneId !== id,
      );
      // GC a dead file: if every prior line was stale (no live instance left), delete the
      // file + the now-empty session dir before writing our line. This prunes files left
      // behind by killed instances (which never run removeSelf). Recreate the dir for the
      // write that follows.
      if (kept.length === 0 && st.lines.length > 0) {
        try {
          unlinkSync(stateFile());
        } catch {}
        try {
          rmdirSync(path.dirname(stateFile()));
        } catch {}
        cleanStaleTemps();
        mkdirSync(path.dirname(stateFile()), { recursive: true });
      }
      kept.push({ paneId: id, icon: iconToWire(myIcon), lastSeen: now });
      atomicWrite(
        stateFile(),
        kept.map((l) => `${l.paneId}\t${l.icon}\t${l.lastSeen}`).join("\n") + "\n",
      );
    } catch {}
  }

  // Remove this instance's line (on shutdown). Deletes the file (and dir) when the last
  // instance leaves, and best-effort cleans up stale temp files.
  function removeSelf() {
    const id = paneId();
    if (id == null || myTabId == null) return;
    try {
      const st = readState();
      if (!st.ok) return;
      const now = Date.now();
      const kept = st.lines.filter(
        (l) => l.paneId !== id && now - l.lastSeen <= STALE_TTL_MS,
      );
      if (kept.length === 0) {
        try {
          unlinkSync(stateFile());
        } catch {} // file may already be gone (concurrent removeSelf); still GC the dir
        try {
          rmdirSync(path.dirname(stateFile()));
        } catch {}
        cleanStaleTemps();
      } else {
        atomicWrite(
          stateFile(),
          kept.map((l) => `${l.paneId}\t${l.icon}\t${l.lastSeen}`).join("\n") + "\n",
        );
      }
    } catch {}
  }

  // Best-effort: remove leftover `<file>.tmp.<pid>` files older than 60s (a crashed writer).
  function cleanStaleTemps() {
    const dir = path.dirname(stateFile());
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.includes(".tmp.")) continue;
      const full = path.join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > 60000) unlinkSync(full);
      } catch {}
    }
  }

  // Always-on poll: every instance heartbeats (upsertSelf) and re-evaluates leadership each
  // tick, so a survivor re-elects within the TTL after the leader dies (a killed leader no
  // longer wedges the tab). When the user is on our tab, clear our icon (clear-on-focus).
  // The leader then renders the worst fresh state; a failed rename is retried next tick.
  function startPoll() {
    stopPoll();
    const tick = async () => {
      try {
        // Heartbeat ALWAYS runs (even during the post-(re)start grace window) so the shared-file
        // membership stays fresh. This matters because STALE_TTL_MS < STARTUP_GRACE_MS: if the
        // leader stopped heartbeating during grace, a non-leader (which never enters grace, since
        // it makes no CLI calls) would see the leader's line go stale and get re-elected mid-grace,
        // then start making CLI calls inside the very startup window we're trying to avoid.
        // upsertSelf() only touches the shared file, so it's safe during grace.
        upsertSelf();
        // Right after the server (re)starts, hold off on zellij CLI calls (startup race window —
        // see STARTUP_GRACE_MS). runZellij() also gates on inStartupGrace(), so event-handler CLI
        // calls are suppressed too. The heartbeat above still runs, so membership stays fresh.
        if (!inStartupGrace()) {
          if ((await ensureTabId()) == null) {
            pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }
          // Clear-on-focus: each check spawns a zellij CLI process, so run it every few ticks
          // rather than every tick. The icon still clears within a few seconds of the user
          // switching to the tab, which is plenty for an attention indicator.
          pollTick++;
          if (myIcon != null && pollTick % 4 === 0) {
            const active = await activeTabId();
            if (active != null && active === myTabId) {
              myIcon = null;
              iconSource = null;
              upsertSelf(); // record the clear so the leader renders the new worst state
            }
          }
          await renderIfLeader(); // leader renders the worst fresh state (no-op if not leader)
        }
      } catch {}
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  async function setIcon(icon, source) {
    myIcon = icon;
    iconSource = source;
    await ensureTabId(); // resolve the tab id before touching the shared file
    upsertSelf(); // record our new state in the shared file
    await renderIfLeader(); // best-effort now (leader only); the poll re-renders if it failed
    startPoll();
  }

  async function clearIcon(reason) {
    if (myIcon == null) return;
    myIcon = null;
    iconSource = null;
    await ensureTabId();
    upsertSelf(); // record the clear so the leader renders the new worst state
    await renderIfLeader();
    log(`clearIcon(${reason}) tab=${myTabId} done`);
  }

  // Drop only the "done" ✅ (a new run or a still-active subagent makes it stale). Keeps any ⏳
  // attention icon, which is still valid. Fire-and-forget render; the poll re-renders if it fails.
  function clearDoneIcon(reason) {
    if (myIcon !== ICON_DONE) return;
    myIcon = null;
    iconSource = null;
    upsertSelf();
    void renderIfLeader();
    log(`clearDoneIcon(${reason}) tab=${myTabId}`);
  }

  // pi-subagents stores each async run's status at <tempRoot>/async-subagent-runs/<runId>/status.json.
  // tempRoot is $PI_SUBAGENTS_TEMP_ROOT, else <tmpdir>/pi-subagents-<scope> (scope is usually
  // "uid-<uid>"). Best-effort: any mismatch just means the resync adds nothing (a conservative
  // "missed ✅", never a spurious one).
  function subagentsTempRoots() {
    const roots = [];
    const envRoot = (process.env.PI_SUBAGENTS_TEMP_ROOT ?? "").trim();
    if (envRoot) roots.push(path.resolve(envRoot));
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid !== undefined) roots.push(path.join(os.tmpdir(), `pi-subagents-uid-${uid}`));
    } catch {}
    return roots;
  }

  // Rebuild the active-subagent set from disk (for resume, where pi-subagents restores runs
  // without re-emitting their start events). Only runs owned by THIS session count.
  function resyncActiveSubagents(sessionFile) {
    activeSubagentRuns.clear();
    if (typeof sessionFile !== "string" || !sessionFile) return;
    for (const root of subagentsTempRoots()) {
      const runsDir = path.join(root, "async-subagent-runs");
      let entries;
      try {
        entries = readdirSync(runsDir);
      } catch {
        continue;
      }
      for (const runId of entries) {
        let st;
        try {
          st = JSON.parse(readFileSync(path.join(runsDir, runId, "status.json"), "utf8"));
        } catch {
          continue;
        }
        if (st && (st.state === "queued" || st.state === "running") && st.sessionId === sessionFile) {
          activeSubagentRuns.add(typeof st.runId === "string" && st.runId ? st.runId : runId);
        }
      }
    }
  }

  // Shared cleanup: stop the poll, strip any stale icon from a previous run, and reset run
  // state. Runs once per session (re-armed on session_shutdown, since pi reuses this extension
  // across /new, /resume, /fork); icon-setting handlers await it so no icon is set before the
  // stale one is cleared. Triggered at session_start — NOT in the factory, because pi runs the
  // factory on session-less invocations (pi config, pi -p) where spawning zellij is wrong and a
  // hung CLI would block startup. The strip is best-effort: if it times out, the next setIcon
  // strips the stale suffix via stripIcon().
  let cleanupPromise = null;
  function ensureCleanup() {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        stopPoll();
        myIcon = null;
        iconSource = null;
        runActive = false;
        lastTurnOutcome = null;
        // NB: do NOT reset runOrigin here. before_agent_start always (re)sets it before any
        // consumer (turn_end / agent_settled) reads it, so a stale value can't leak across
        // sessions. But this cleanup can run AFTER before_agent_start (e.g. agent_start is the
        // session's first ensureCleanup, with no preceding session_start); resetting here would
        // clobber the freshly-classified origin and misread a subagent wake as a user run.
        lastRenderedIcon = null;
        upsertSelf(); // no-op if myTabId not resolved yet
        await renderIfLeader(); // no-op if myTabId not resolved yet
        startPoll(); // (re)start the always-on poll for the fresh session
      })();
    }
    return cleanupPromise;
  }

  // ⏳ for a blocking UI prompt (an extension's confirmation/input/editor prompt). Debounced so
  // a quick open/close (e.g. an RPC-mode auto-response) doesn't flash the icon; cancelled on end.
  let promptTimer = null;

  pi.on("session_start", (event, ctx) => {
    ensureCleanup(); // trigger cleanup early (non-blocking); also resets state on re-start
    upsertSelf(); // record our state in the shared file (no-op if myTabId unset yet)
    // Re-sync active subagents from disk (a resume restores runs without re-emitting start events).
    resyncActiveSubagents(ctx?.sessionManager?.getSessionFile?.());
  });

  // Track active async subagent runs so the tab icon reflects "AI waiting on you" rather than
  // "AI waiting on a subagent". pi-subagents emits these on the shared pi event bus; if it isn't
  // installed they never fire and the set stays empty (behavior unchanged).
  if (pi.events?.on) {
    pi.events.on("subagent:async-started", (data) => {
      const id = data && data.id;
      if (typeof id === "string" && id) {
        activeSubagentRuns.add(id);
        // A subagent just (re)started work: a "done" ✅ is now stale.
        clearDoneIcon("subagent-started");
      }
    });
    pi.events.on("subagent:async-complete", (data) => {
      const id = data && (data.runId || data.id);
      if (typeof id === "string" && id) activeSubagentRuns.delete(id);
    });
  }

  // Classify a run's origin so only the main agent's own activity drives the tab icon. A
  // pi-subagents wake starts a run that is NOT a real user prompt: either a custom message whose
  // customType starts with "subagent" (sent with triggerTurn), or a steer user message carrying
  // the fixed PARENT_WAKE_TEXT. Both are subagent runs and must not raise/clear the icon.
  function classifyRunOrigin(event) {
    if (event.messageType === "custom") {
      const ct = event.message && event.message.customType;
      return typeof ct === "string" && ct.startsWith("subagent") ? "subagent" : "user";
    }
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    return prompt.startsWith(SUBAGENT_WAKE_PREFIX) ? "subagent" : "user";
  }

  pi.on("before_agent_start", (event) => {
    runOrigin = classifyRunOrigin(event);
  });

  pi.on("agent_start", async () => {
    await ensureCleanup();
    runActive = true;
    // A new run started: the AI is working, not waiting on you. Drop any stale "done" ✅.
    clearDoneIcon("run-started");
  });

  pi.on("turn_end", async (event) => {
    await ensureCleanup();
    lastTurnOutcome = event.outcome;
    // ⏳ now: a turn that ended in error needs attention — but only for a real (user) run. A
    // subagent wake run erroring must not touch the icon (it would flap on every wake). If a
    // later turn recovers and the run settles, agent_settled ✅ overwrites it; if the run ends
    // errored, the ⏳ stays.
    if (event.outcome === "error" && runOrigin !== "subagent") {
      log(`turn_end error (turn ${event.turnIndex})`);
      await setIcon(ICON_WAIT, "error");
    }
  });

  pi.on("agent_settled", async (event) => {
    await ensureCleanup();
    const origin = runOrigin;
    runOrigin = null;
    if (!runActive) {
      lastTurnOutcome = null;
      return; // no run to report (a settle with no prior agent_start)
    }
    runActive = false;
    const outcome = lastTurnOutcome;
    lastTurnOutcome = null;
    const subagentsActive = activeSubagentRuns.size > 0;
    if (origin === "subagent") {
      if (subagentsActive) {
        // More subagents are still running: the AI is waiting on them, not on you. Drop any stale
        // "done" ✅ (a ⏳ attention icon, if present, is still valid and is kept).
        clearDoneIcon("subagents-active");
        return;
      }
      // The last subagent's wake just settled: the AI is now waiting on you. Focus-aware: skip if
      // the user is already in our tab (they can see it's done).
      const active = await activeTabId();
      if (myTabId != null && active === myTabId) return;
      await setIcon(ICON_DONE, "idle");
      return;
    }
    if (event.aborted) {
      // User aborted (e.g. Escape): they took control, so no attention icon is needed.
      await clearIcon("aborted");
      return;
    }
    if (outcome === "error") {
      // The run settled but its last turn errored: keep the ⏳ (the turn failed).
      await setIcon(ICON_WAIT, "error");
      return;
    }
    if (subagentsActive) {
      // The main agent's turn is done but subagents are still running: the AI is waiting on them,
      // not on you. No "done" ✅ (a ⏳ from a prompt, if any, is kept).
      clearDoneIcon("subagents-active");
      return;
    }
    // Focus-aware: skip if the user is already in our tab (they can see it's done).
    const active = await activeTabId();
    if (myTabId != null && active === myTabId) return;
    await setIcon(ICON_DONE, "idle");
  });

  pi.on("ui_prompt_start", async () => {
    await ensureCleanup();
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = setTimeout(async () => {
      promptTimer = null;
      await setIcon(ICON_WAIT, "prompt");
    }, PROMPT_DEBOUNCE_MS);
  });

  pi.on("ui_prompt_end", async () => {
    await ensureCleanup();
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
    if (iconSource === "prompt") await clearIcon("prompt-end");
  });

  pi.on("session_compact_failed", async (event) => {
    await ensureCleanup();
    // A failed compaction that won't be retried leaves the context stuck: needs attention.
    // (willRetry => pi recovers on its own; aborted => the user cancelled.)
    if (!event.aborted && !event.willRetry) {
      log(`session_compact_failed reason=${event.reason} willRetry=${event.willRetry}`);
      await setIcon(ICON_WAIT, "compact");
    }
  });

  pi.on("session_shutdown", () => {
    stopPoll(); // idempotent; release the poll timer on shutdown
    removeSelf(); // release our line in the shared file (GCs the file when we're last)
    activeSubagentRuns.clear(); // drop this session's subagent tracking
    // Re-arm cleanup: pi reuses the SAME loaded extension across /new, /resume, /fork, so a
    // later session_start must run a FRESH cleanup (strip any stale icon + reset state). Without
    // this, the cached (already-resolved) cleanupPromise makes the 2nd+ session_start a no-op,
    // wedging a stale icon with the poll stopped. session_shutdown always precedes the
    // replacement's session_start, so this is safe (harmless on reason "quit").
    cleanupPromise = null;
  });
}
