// Bridges opencode attention state to ITS OWN zellij tab (producer-side; no WASM plugin needed).
//   ⏳  opencode is waiting for your input (permission prompt) or hit an error
//   ✅  opencode finished a turn (session went idle)
//
// Each opencode instance manages only its own tab's icon: it renames the tab with
// `zellij action rename-tab-by-id <tabId> <name>` to add an icon, and clears it by
// polling `zellij action current-tab-info` — the moment the user switches to this tab,
// the icon is stripped (clear-on-focus). This bypasses the zellij WASM plugin subsystem
// entirely, so it is immune to a wedged/slow plugin thread and has no rename->TabUpdate
// feedback loop.
//
// No-op outside zellij (requires ZELLIJ_PANE_ID, set automatically in zellij panes).
// Install: place in ~/.config/opencode/plugins/ (global) or .opencode/plugins/ (project).
// The zellij-agent-attention WASM plugin must be disabled (config.kdl: enabled "false"),
// otherwise it will strip these icons as "stale".

import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const LOG_FILE = "/tmp/opencode-zellij-attention.log";
const ICON_DONE = "✅";
const ICON_WAIT = "⏳";
const POLL_INTERVAL_MS = 1500;
const PERMISSION_DEBOUNCE_MS = 300;
const ZELLIJ_TIMEOUT_MS = 2500;
// Show ✅ when a turn completes (session goes idle). The ✅ is suppressed in the tab you're
// already in (see session.idle) and cleared as soon as you switch to the tab (clear-on-focus).
const NOTIFY_ON_IDLE = true;

// The zellij CLI may not be on PATH (e.g. opencode running over ssh, where the
// remote shell's PATH lacks the dir zellij was installed into). Resolve a known
// location before falling back to a PATH lookup.
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

// Run `zellij action <args...>`; resolve with stdout (string) or null on error/timeout.
function runZellij(args, timeoutMs = ZELLIJ_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(ZELLIJ_BIN, ["action", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done(null);
    }, timeoutMs);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      log(`zellij spawn failed (${ZELLIJ_BIN}): ${err?.message ?? err}`);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out : null);
    });
  });
}

// Stable id of the currently active zellij tab, or null (outside zellij / on timeout).
async function activeTabId() {
  const out = await runZellij(["current-tab-info"]);
  if (!out) return null;
  const m = out.match(/^id:\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

// Canonical key for a permission event. `permission.asked`/`updated` and
// `permission.replied` must resolve the SAME key, or a pending prompt's debounce
// timer is never cancelled and a stale ⏳ fires after the user already replied.
function permKey(props) {
  return props?.id ?? props?.permissionID ?? "perm";
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

export const ZellijAttention = async ({ client } = {}) => {
  // Outside zellij there is nothing to do. (paneId() is 0 for the first tab, so
  // compare against null, not truthiness — `!0` is true and would wrongly bail out.)
  if (paneId() == null) {
    log("plugin no-op: ZELLIJ_PANE_ID not set (outside zellij, or env not forwarded over ssh)");
    return { event: async () => {} };
  }

  const isSubSession = async (sessionID) => {
    if (!sessionID || !client?.session?.get) return false;
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      return Boolean(res?.data?.parentID);
    } catch {
      return false;
    }
  };

  // Find the tab containing this opencode pane. Do not use current-tab-info here:
  // an opencode instance can start/resume while another tab is active.
  // Uses the JSON form so a pane's title/command/cwd (which may contain "terminal_N")
  // can't be mistaken for the pane id.
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

  // Stable id of the tab containing this opencode pane. Null if it can't be
  // determined yet; retried lazily via ensureTabId() (e.g. if the CLI wasn't ready
  // at load time, the plugin would otherwise no-op for the whole session).
  let myTabId = await tabIdForPane();
  log(`plugin loaded (pane=${paneId()} tab=${myTabId ?? "none"} zellij=${ZELLIJ_BIN})`);

  // Resolve myTabId if the initial lookup failed (transient CLI timeout at load).
  // Dedup in-flight lookups so concurrent callers share one list-panes call.
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
  let iconSource = null; // "idle" | "error" | "permission"
  let pollTimer = null;

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

  // Rename our tab to `base + (icon ? " " + icon : "")`. Returns true if the tab now
  // matches (or already did), false if we couldn't apply it (transient CLI failure).
  // Callers MUST treat a false return as "retry later" — never assume the rename took,
  // or a failed rename wedges the icon (myIcon cleared but the tab still shows it).
  async function applyIcon(icon) {
    if ((await ensureTabId()) == null) return false;
    const name = await myTabName();
    if (name == null) return false;
    const base = stripIcon(name);
    const target = icon ? `${base} ${icon}` : base;
    if (target === name) return true;
    const out = await runZellij(["rename-tab-by-id", String(myTabId), target]);
    if (out != null) log(`applyIcon tab=${myTabId} '${name}' -> '${target}'`);
    return out != null;
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // While an icon is set, poll the active tab; when the user is on our tab, strip the icon
  // (clear-on-focus). If a rename fails (transient CLI timeout), the poll keeps running and
  // retries — this is what prevents a failed rename from wedging the icon on the tab.
  function startPoll() {
    stopPoll();
    const tick = async () => {
      if (myIcon == null) {
        pollTimer = null;
        return;
      }
      const active = await activeTabId();
      if (active != null && active === myTabId) {
        await clearIcon("focus");
        // clearIcon() only stops the poll if the rename succeeded; if it failed, myIcon is
        // still set, so reschedule and retry.
        if (myIcon != null) pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      // Not on our tab: re-apply the icon in case a prior set-rename failed.
      await applyIcon(myIcon);
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  async function setIcon(icon, source) {
    myIcon = icon;
    iconSource = source;
    await applyIcon(icon); // best-effort now; the poll re-applies it if this failed
    startPoll();
  }

  async function clearIcon(reason) {
    if (myIcon == null) return;
    const ok = await applyIcon(null);
    if (!ok) return; // rename failed: keep myIcon + the poll running so it retries
    myIcon = null;
    iconSource = null;
    stopPoll();
    log(`clearIcon(${reason}) tab=${myTabId} done`);
  }

  // Strip any icon left on our tab from a previous run / the old WASM mechanism.
  // Best-effort: if it can't be cleared now, the first setIcon's poll will reconcile it.
  async function startupCleanup() {
    await applyIcon(null);
  }
  // Await (not fire-and-forget) so a just-set icon from an early event can't be
  // stripped by the cleanup; the handler is only registered once cleanup is done.
  await startupCleanup();

  const permissionTimers = new Map();
  // Sessions that went busy (started a turn) since load. opencode emits session.idle
  // only on real turn completion (the runner is created lazily on first prompt), so a
  // resumed session emits NO idle at load — its first turn completion must not be
  // swallowed. Only an idle that follows a busy→idle transition earns a ✅; a startup
  // idle with no prior busy (if one ever fires) is still suppressed.
  const busySessions = new Set();

  return {
    event: async ({ event }) => {
      await ensureTabId();
      switch (event?.type) {
        case "session.status": {
          const sessionID = event.properties?.sessionID;
          if (sessionID != null && event.properties?.status?.type === "busy") {
            busySessions.add(sessionID);
          }
          break;
        }
        case "session.idle": {
          if (!NOTIFY_ON_IDLE) break;
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          // Only a turn that actually ran (went busy) earns a ✅.
          if (!busySessions.delete(sessionID)) break;
          // Focus-aware: skip if the user is already in our tab (they can see it's done).
          const active = await activeTabId();
          if (myTabId != null && active === myTabId) break;
          // A COMPLETED turn shows ✅, even if it hit a transient error along the way.
          // opencode fires session.error for retried/transient failures (rate limits,
          // timeouts it retries) too, so keying ✅ off "no error ever fired" mislabels
          // successful turns as ⏳. A turn that genuinely FAILED never goes idle, so its
          // session.error ⏳ simply stays until the next turn or focus.
          await setIcon(ICON_DONE, "idle");
          break;
        }
        // ⏳ (action needed) is set regardless of focus so it is visible even when you are
        // already in the tab; the poll clears it on focus, and the matching "replied"/next
        // turn clears it when the action is done. (✅ stays focus-aware — see session.idle.)
        case "session.error": {
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          // ⏳ now: a real error needs attention. If the turn recovers and completes, the
          // session.idle ✅ overwrites it; if it fails (no idle), the ⏳ stays. Log the
          // error name so transient-vs-fatal is diagnosable.
          log(`session.error ${sessionID ?? "?"} name=${event.properties?.error?.name ?? "?"}`);
          await setIcon(ICON_WAIT, "error");
          break;
        }
        case "question.asked": {
          await setIcon(ICON_WAIT, "question");
          break;
        }
        case "question.replied": {
          if (iconSource === "question") await clearIcon("question-replied");
          break;
        }
        case "permission.asked":
        case "permission.updated": {
          // Auto-allowed permissions are created+replied within ms; a real prompt stays open.
          // Debounce so only a still-pending prompt sets the icon.
          const id = permKey(event.properties);
          if (permissionTimers.has(id)) clearTimeout(permissionTimers.get(id));
          permissionTimers.set(
            id,
            setTimeout(() => {
              permissionTimers.delete(id);
              void setIcon(ICON_WAIT, "permission");
            }, PERMISSION_DEBOUNCE_MS),
          );
          break;
        }
        case "permission.replied": {
          const id = permKey(event.properties);
          const timer = permissionTimers.get(id);
          if (timer) {
            clearTimeout(timer);
            permissionTimers.delete(id);
          }
          if (iconSource === "permission") await clearIcon("permission-replied");
          break;
        }
        default:
          break;
      }
    },
  };
};
