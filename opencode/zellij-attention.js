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
import { appendFileSync } from "node:fs";

const LOG_FILE = "/tmp/opencode-zellij-attention.log";
const ICON_DONE = "✅";
const ICON_WAIT = "⏳";
const POLL_INTERVAL_MS = 1500;
const PERMISSION_DEBOUNCE_MS = 300;
const ZELLIJ_TIMEOUT_MS = 2500;
// Show ✅ when a turn completes (session goes idle). The ✅ is suppressed in the tab you're
// already in (see session.idle) and cleared as soon as you switch to the tab (clear-on-focus).
const NOTIFY_ON_IDLE = true;

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function paneId() {
  const raw = process.env.ZELLIJ_PANE_ID;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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
      child = spawn("zellij", ["action", ...args], {
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
    child.on("error", () => {
      clearTimeout(timer);
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
  // Outside zellij there is nothing to do.
  if (!paneId()) {
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

  // Our tab's stable id, captured at load. Opencode is started inside a tab, so at
  // plugin-load that tab is the active one. Null if it can't be determined (no-op after).
  const myTabId = (await activeTabId()) ?? null;
  log(`plugin loaded (pane=${paneId()} tab=${myTabId ?? "none"})`);

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

  async function renameTab(name) {
    if (myTabId == null) return;
    await runZellij(["rename-tab-by-id", String(myTabId), name]);
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // While an icon is set, poll the active tab; when the user is on our tab, strip the icon.
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
        return; // clearIcon() stops the poll
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  async function setIcon(icon, source) {
    if (myTabId == null) return;
    const name = await myTabName();
    if (name == null) return;
    const base = stripIcon(name);
    const target = `${base} ${icon}`;
    myIcon = icon;
    iconSource = source;
    if (target !== name) await renameTab(target);
    log(`setIcon ${icon} tab=${myTabId} '${name}' -> '${target}'`);
    startPoll();
  }

  async function clearIcon(reason) {
    const had = myIcon;
    myIcon = null;
    iconSource = null;
    stopPoll();
    if (had == null || myTabId == null) return;
    const name = await myTabName();
    if (name == null) return;
    const base = stripIcon(name);
    if (base !== name) {
      await renameTab(base);
      log(`clearIcon(${reason}) tab=${myTabId} '${name}' -> '${base}'`);
    }
  }

  // Strip any icon left on our tab from the previous (WASM) mechanism / stale state.
  void clearIcon("startup-cleanup");

  const firstIdleSeen = new Set();
  const permissionTimers = new Map();

  return {
    event: async ({ event }) => {
      switch (event?.type) {
        case "session.idle": {
          if (!NOTIFY_ON_IDLE) break;
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          // Suppress the initial idle of a fresh/resumed session (startup, not a finished turn).
          if (!firstIdleSeen.has(sessionID)) {
            firstIdleSeen.add(sessionID);
            break;
          }
          // Focus-aware: skip if the user is already in our tab (they can see it's done).
          const active = await activeTabId();
          if (myTabId != null && active === myTabId) break;
          await setIcon(ICON_DONE, "idle");
          break;
        }
        case "session.error": {
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          const active = await activeTabId();
          if (myTabId != null && active === myTabId) break;
          await setIcon(ICON_WAIT, "error");
          break;
        }
        case "permission.asked":
        case "permission.updated": {
          const id = event.properties?.id;
          if (!id) break;
          if (permissionTimers.has(id)) clearTimeout(permissionTimers.get(id));
          // Debounce: auto-allowed permissions are created+replied within ms; a real prompt
          // stays open, so only set the icon once it is still pending.
          permissionTimers.set(
            id,
            setTimeout(() => {
              permissionTimers.delete(id);
              void (async () => {
                const active = await activeTabId();
                if (myTabId != null && active === myTabId) return;
                await setIcon(ICON_WAIT, "permission");
              })();
            }, PERMISSION_DEBOUNCE_MS),
          );
          break;
        }
        case "permission.replied": {
          const id = event.properties?.permissionID;
          const timer = id ? permissionTimers.get(id) : undefined;
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
