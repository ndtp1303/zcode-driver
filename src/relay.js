import { relayWsUrl } from "./remote-url.js";

const TOKEN_PATH = "/api/v1/remote/token";
const DEVICE_PATH = "/api/v1/remote/device";

export function buildAuthInit({ deviceSid, appVersion, now = Date.now() }) {
  return {
    type: "auth_init",
    device_sid: deviceSid,
    meta: {
      platform: "web",
      version: appVersion || "web",
      name: "zcode-driver",
    },
    client_ts: Math.floor(now / 1000),
  };
}

export function buildData(payload, now = Date.now()) {
  return { type: "data", payload, client_ts: Math.floor(now / 1000) };
}

export function requestId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export async function mintTerminalToken(origin, jwt, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(TOKEN_PATH, origin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "terminal" }),
    redirect: "error",
  });
  if (response.status === 401) {
    throw coded("auth-required", "Relay rejected the JWT (HTTP 401)");
  }
  if (!response.ok) {
    throw coded("relay-unavailable", `Relay token HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (!body || body.code !== 0 || !body.data?.token) {
    throw coded("relay-unavailable", body?.msg || "Relay token response was empty");
  }
  return { token: body.data.token, expiresIn: body.data.expires_in ?? null };
}

export async function listDevices(origin, jwt, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(DEVICE_PATH, origin), {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
    redirect: "error",
  });
  if (response.status === 401) throw coded("auth-required", "Device list rejected the JWT (HTTP 401)");
  if (!response.ok) throw coded("relay-unavailable", `Device list HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!body || body.code !== 0 || !Array.isArray(body.data)) {
    throw coded("relay-unavailable", body?.msg || "Device list response was empty");
  }
  return body.data.map((device) => ({
    deviceSid: device.device_sid,
    deviceMid: device.device_mid,
    online: Boolean(device.online),
    createdAt: device.created_at ?? null,
    name: device.meta?.name ?? null,
    platform: device.meta?.platform ?? null,
    version: device.meta?.version ?? null,
  }));
}

export async function openRelay({
  origin,
  jwt,
  deviceSid,
  deviceMid,
  appVersion,
  timeoutMs = 15_000,
  fetchImpl = fetch,
}) {
  const minted = await mintTerminalToken(origin, jwt, fetchImpl);
  const url = new URL(relayWsUrl(origin));
  url.searchParams.set("token", minted.token);
  if (deviceMid) url.searchParams.set("mid", deviceMid);
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  const push = (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else inbox.push(message);
  };

  ws.addEventListener("message", (event) => {
    frameText(event.data)
      .then((text) => {
        try {
          push(JSON.parse(text));
        } catch {
          push({ type: "unparsed", text: text.slice(0, 500) });
        }
      })
      .catch((error) => push({ type: "unparsed", text: String(error) }));
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, coded("ws-timeout", "WebSocket open timed out")), timeoutMs);
      ws.addEventListener("open", () => finish(resolve));
      ws.addEventListener("error", () => finish(reject, coded("ws-failed", "WebSocket failed before the relay accepted it")));
      ws.addEventListener("close", (event) => {
        finish(reject, coded("ws-closed", `WebSocket closed ${event.code} ${event.reason || ""}`.trim()));
      });
    });
  } catch (error) {
    try {
      ws.close();
    } catch {
      // handshake already failed
    }
    throw error;
  }

  ws.addEventListener("close", (event) => {
    push({ type: "socket-close", code: event.code, reason: event.reason || "" });
  });
  ws.send(JSON.stringify(buildAuthInit({ deviceSid, appVersion })));

  return {
    expiresIn: minted.expiresIn,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    next(timeout) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve) => {
        const waiter = {
          done: false,
          resolve: (message) => {
            if (waiter.done) return;
            waiter.done = true;
            clearTimeout(waiter.timer);
            resolve(message);
          },
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          waiter.resolve(null);
        }, timeout);
        waiters.push(waiter);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

export async function readPairStatus(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pairStatus = null;
  let terminalSid = null;
  while (Date.now() < deadline) {
    const message = await session.next(Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (!message) {
      if (pairStatus) session.send({ type: "pair_status_query", client_ts: Math.floor(Date.now() / 1000) });
      continue;
    }
    if (message.type === "auth_ack" || message.type === "pair_status_ack") {
      pairStatus = message.pair_status ?? pairStatus;
      terminalSid = message.terminal_sid ?? terminalSid;
      if (pairStatus === "matched") break;
    } else if (message.type === "error") {
      throw coded(relayErrorCode(message.code), message.message || message.code || "relay error");
    } else if (message.type === "socket-close") {
      throw coded("ws-closed", `WebSocket closed ${message.code || ""}`.trim());
    }
  }
  if (!pairStatus) throw coded("pair-timeout", "Relay did not return pair status");
  return { pairStatus, terminalSid };
}

export async function readWorkspaces(session, timeoutMs) {
  const listId = requestId("workspace-list");
  const bootId = requestId("bootstrap");
  session.send(buildData({
    zcode_type: "bootstrap-request",
    requestId: bootId,
    terminalClientSessionId: requestId("terminal-page"),
  }));
  session.send(buildData({ zcode_type: "workspace-list-request", requestId: listId }));
  const deadline = Date.now() + timeoutMs;
  let workspaces = null;
  let bootstrap = null;
  while (Date.now() < deadline && (workspaces === null || bootstrap === null)) {
    const message = await session.next(Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (!message || message.type !== "data") continue;
    const payload = message.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.zcode_type === "workspace-list-response" && payload.requestId === listId) {
      workspaces = payload.result ?? null;
    }
    if (payload.zcode_type === "bootstrap-response" && payload.requestId === bootId) {
      bootstrap = payload.result ?? null;
    }
    if (payload.zcode_type === "workspace-list-updated" && workspaces === null) {
      workspaces = payload.result ?? null;
    }
  }
  return { workspaces, bootstrap };
}

export function summarizeWorkspaces(result) {
  const rows = Array.isArray(result?.workspaces) ? result.workspaces : [];
  return {
    activeWorkspaceKey: result?.activeWorkspaceKey ?? null,
    activeTaskId: result?.activeTaskId ?? null,
    workspaces: rows.map((row) => ({
      label: row.label ?? null,
      kind: row.kind ?? null,
      workspacePath: row.workspacePath ?? null,
      workspaceIdentity: row.workspaceIdentity ?? null,
      connectionState: row.connectionState ?? null,
      purpose: row.workspacePurpose ?? null,
    })),
  };
}

function relayErrorCode(code) {
  if (code === "AUTH_FAILED") return "device-not-owned";
  if (code === "WRONG_PARAM") return "invalid-mobile-connection";
  if (code === "KICKED") return "session-conflict";
  if (code === "DEVICE_OFFLINE") return "desktop-disconnected";
  return "relay-unavailable";
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}
