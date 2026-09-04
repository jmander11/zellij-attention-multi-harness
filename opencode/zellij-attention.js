// Bridges opencode attention state to the zellij-agent-attention tab icon plugin.
//   ⏳  opencode is waiting for your input (permission prompt) or hit an error
//   ✅  opencode finished a turn (session went idle)
// No-op outside zellij (requires ZELLIJ_PANE_ID, set automatically in zellij panes).
// Install: place in ~/.config/opencode/plugins/ (global) or .opencode/plugins/ (project).
// Requires the zellij side: ~/.config/zellij/plugins/zellij-agent-attention.wasm loaded via
// load_plugins in config.kdl (or: zellij action start-or-reload-plugin <wasm path>).

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const LOG_FILE = "/tmp/opencode-zellij-attention.log";
const PERMISSION_DEBOUNCE_MS = 300;

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

function notify(status, sessionID) {
  const id = paneId();
  if (!id) return;
  log(`notify pane=${id} status=${status} session=${sessionID ?? "-"}`);
  try {
    const child = spawn(
      "zellij",
      [
        "pipe",
        "--name",
        "zj_radar.status.v1",
        "--",
        JSON.stringify({ pane: { id }, status }),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  } catch (err) {
    log(`spawn failed: ${err && err.message ? err.message : err}`);
  }
}

export const ZellijAttention = async ({ client } = {}) => {
  const isSubSession = async (sessionID) => {
    if (!sessionID || !client?.session?.get) return false;
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      return Boolean(res?.data?.parentID);
    } catch {
      return false;
    }
  };

  const firstIdleSeen = new Set();
  const permissionTimers = new Map();

  log(`plugin loaded (pane=${paneId() ?? "none"})`);

  return {
    event: async ({ event }) => {
      switch (event?.type) {
        case "session.idle": {
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          // Suppress the initial idle of a fresh/resumed session (startup state,
          // not a completed turn).
          if (!firstIdleSeen.has(sessionID)) {
            firstIdleSeen.add(sessionID);
            break;
          }
          notify("done", sessionID);
          break;
        }
        case "session.error": {
          const sessionID = event.properties?.sessionID;
          if (await isSubSession(sessionID)) break;
          notify("error", sessionID);
          break;
        }
        case "permission.asked":
        case "permission.updated": {
          const id = event.properties?.id;
          if (!id) break;
          if (permissionTimers.has(id)) clearTimeout(permissionTimers.get(id));
          const sessionID = event.properties?.sessionID;
          // Debounce: auto-allowed permissions are created+replied within ms;
          // a real prompt stays open, so only send once it's still pending.
          permissionTimers.set(
            id,
            setTimeout(() => {
              permissionTimers.delete(id);
              notify("pending", sessionID);
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
          break;
        }
        default:
          break;
      }
    },
  };
};
