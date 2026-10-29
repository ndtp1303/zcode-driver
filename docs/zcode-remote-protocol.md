# ZCode remote protocol (desktop 3.16.3, page `/remote/v4`)

This note is reconstructed from the public page
`https://zcode.z.ai/remote/v4` (bundle `3.16.3`, `index-BsmXQHMM.js` and
`validation-B6yV_dPD.js` / `src-NU5WmGbb.js`, last-modified 23 Oct 2026) and
from unauthenticated live probes on 29 Oct 2026. It is not an official Z.ai
spec. The relay can change without notice.

The remote link is a credential. This repository never stores a real `sid` or
`mid`.

## What the link is

```
https://zcode.z.ai/remote/v4?sid=<device_sid>&mid=<device_mid>&name=<machine>&app_version=<desktop>
```

| Query | Role |
| --- | --- |
| `sid` | Device session id (`device_sid`). Required to attach to one desktop. |
| `mid` | Machine id. Sent again as the WebSocket `mid` query. |
| `name` | Display name only. |
| `app_version` | Desktop build. The page reloads itself if bootstrap reports a different build. |
| `hash`, `t` | v1 HMAC parameters. The 3.16.3 parser returns "invalid connection" when either is present. |

`sid` does not authenticate the browser. The page reads a ZCode login from
`localStorage` and refuses to open a socket until that login exists.

## Two generations

Older write-ups describe v1: `wss://zcode.z.ai/ws?mid=…`, then
`auth_init` → `auth_challenge` → HMAC proof using `hash`. Desktop 3.16.x no
longer puts `hash` in the QR code. The shipped 3.16.3 page speaks v2:

1. The browser must already hold a ZCode JWT for the same account as the desktop.
2. It mints a short terminal token.
3. It connects to `wss://<origin>/api/v1/remote/ws2?token=<terminal>&mid=<mid>`.
4. The first frame is `auth_init` with `device_sid`. There is no challenge.

## Sign-in material the page expects

All four keys must be present or the page clears storage and shows
"Sign In To Continue":

| Key | Value |
| --- | --- |
| `oauth:active_provider` | `zai` or `bigmodel` |
| `zcodejwttoken` | JWT. Client-side it only checks `exp` (30s skew). The server checks the signature. |
| `oauth:zai:access_token` or `oauth:bigmodel:access_token` | Non-empty. The relay calls do not send this token. |
| `oauth:zai:user_info` or `oauth:bigmodel:user_info` | JSON with `id`, `username`, `displayName`. |

Login buttons call Z.ai / BigModel OAuth and return to `/remote/v4`.

## HTTP

Origin is the page origin (`https://zcode.z.ai` for the hosted page).

| Call | Body | Auth |
| --- | --- | --- |
| `POST /api/v1/remote/token` | `{"role":"terminal"}` | `Authorization: Bearer <jwt>` |
| `GET /api/v1/remote/device` | — | same |
| `POST /api/v1/remote/device` | register a desktop | same |
| `POST /api/v1/remote/device/delete` | `{device_sid}` | same |

Token success shape:

```json
{"code":0,"msg":"...","data":{"token":"<22 char>","expires_in":123}}
```

The token matches `^[A-Za-z0-9_-]{21}[AQgw]$`. `role` is `device` or `terminal`.
A phone/driver uses `terminal`. The desktop uses `device`.

Live probe without a JWT, 29 Oct 2026: both the token POST and the device GET
returned `401` with an empty body. A WebSocket upgrade to `/api/v1/remote/ws2`
without a token also returned `401` (not a 101). No `auth_init` was sent.

Device list rows:

```json
{"device_sid":"...","device_mid":"...","online":true,"created_at":0,"meta":{"name":"...","platform":"...","version":"..."}}
```

## WebSocket session

URL: `wss://<host>/api/v1/remote/ws2?token=<terminal token>&mid=<device_mid>`

Client → server (JSON text frames):

```json
{"type":"auth_init","device_sid":"<sid>","meta":{"platform":"web","version":"3.16.3","name":"mobile-browser"},"client_ts":1700000000}
{"type":"pair_status_query","client_ts":1700000000}
{"type":"data","payload":{"zcode_type":"..."},"client_ts":1700000000}
```

`device_sid` is at most 128 bytes. The official page sends `name: "mobile-browser"`.
This driver sends `name: "zcode-driver"` on the pure-protocol status path.

Server → client:

| `type` | Fields |
| --- | --- |
| `auth_ack` | `device_sid`, optional `terminal_sid`, `pair_status` |
| `pair_status_ack` | optional `terminal_sid`, `pair_status` |
| `data` | `payload` (a `zcode_type` object) |
| `error` | `code`, optional `message` |

`pair_status` is `waiting` or `matched`. `matched` means the desktop has
attached this terminal. The page then allows payloads. While `waiting`, sends
are dropped.

Error codes: `AUTH_FAILED` (wrong account), `WRONG_PARAM` (bad link),
`KICKED` (another terminal took the slot), `INTERNAL`, `DEVICE_OFFLINE`.

One terminal at a time. `status`, `list`, and a prompt run all mint a
`terminal` token. A second client is kicked. Close the socket when the
command finishes.

Heartbeat: `pair_status_query` about every 5 seconds (jitter, 15s ack
timeout). The page gives the desktop about 30 seconds to leave `waiting`,
then shows "Desktop Offline".

## Data channel (`type: "data"`)

`payload.zcode_type` values seen in the 3.16.3 bundle:

| `zcode_type` | Direction | Meaning |
| --- | --- | --- |
| `bootstrap-request` / `bootstrap-response` | client → desktop / reply | Desktop version, workspace snapshot, view state. |
| `workspace-list-request` / `workspace-list-response` / `workspace-list-updated` | both | `{workspaces, activeWorkspaceKey, activeTaskId}`. |
| `workspace-bridge-open` / `workspace-bridge-ready` | client / desktop | Open the service bridge for one workspace or task. |
| `workspace-bridge-error`, `bridge-degraded`, `app-error` | desktop | Bridge failed. |
| `workspace-reconnect-request` / `workspace-reconnect-response` | client / desktop | Reattach a workspace. |
| `platform-request` / `platform-response` | client / desktop | Host questions only: docker/WSL/SSH listing and user MCP load/save. Not the agent prompt. |
| `mobile-view-state-update` | client | Which workspace and task the phone is looking at. |
| `mobile-task-view-update` / `mobile-task-view-request` | client / desktop | Scroll/viewport sync. |
| `telemetry-report`, `mobile-diagnostic` | client | Diagnostics. |
| `rpc-frame` / `rpc-frame-ack` | both | Binary agent session. See below. |

Workspace row fields: `workspacePath`, optional `workspaceIdentity`,
`remoteSessionId`, `label`, `workspacePurpose` (`project` or `conversation`),
`kind` (`local` or `remote`), optional `connectionState`.

`workspace-bridge-open` carries `requestId`, `bridgeSessionId`,
`bridgeGeneration`, `workspaceKey`, and optional `taskId` / `taskHostId` /
`project`. `workspace-bridge-ready` returns a bridge descriptor (`kind: local`
or `kind: remote`) plus `initialTaskId`.

Request ids in the page look like `<purpose>-<uuid>`.

## Why prompts are not a JSON relay message

After the bridge is ready, the agent transcript is not JSON on the data
channel. It is `rpc-frame`:

```json
{
  "zcode_type": "rpc-frame",
  "bridgeSessionId": "...",
  "seq": 1,
  "messageSeq": 1,
  "fragmentIndex": 0,
  "fragmentCount": 1,
  "messageBytes": 100,
  "checksum": {"algorithm": "crc32", "value": "0123abcd"},
  "dataBase64": "...."
}
```

Fragments reassemble to a byte buffer. The page feeds that buffer into the
same zcode protocol v4 channel the desktop UI uses (the bundle tags it as a
proto frame for `ZCodeAgent`, with its own size limits and acks). Composer
send, streaming assistant text, tool cards, permission requests, and stop are
service calls on that channel. `platform-request` cannot submit a prompt; its
method enum is only docker/WSL/SSH/MCP helpers.

Re-implementing that codec and the service surface from the minified bundle
would be a second client of a private protocol. This driver therefore:

- speaks the JSON relay directly for `status` and `list` (pair status, device
  list, workspace list once `matched`);
- drives the official `/remote/v4` page with headless Chrome for `run`,
  `continue`, `stop`, and approvals, and records the relay frames the page
  already sends.

The page hooks used for that:

- Sign-in copy: "Sign In To Continue" / "登录后继续使用 Web 远程控制".
- Composer: `[data-lexical-editor="true"]`, button name `Send` or `发送`.
- Stop: button name `Stop` or `停止生成`.
- Transcript: `[data-trajectory-message-role="assistant"]`, `[data-turn-id]`,
  `[data-running="true"]`.
- Permission buttons (exact name, so "Always allow…" is not clicked): `Allow`
  / `允许`, `Deny` / `拒绝`. Titles include "Permission required" and
  "Awaiting approval".

## Live check on 29 Oct 2026

The supplied `/remote/v4` link (sid + mid, no hash, `app_version=3.16.3`)
loaded the 3.16.3 SPA. With an empty browser profile the document title was
"ZCode - Web Remote Control Sign In" and the only actions were "Connect to
Z.ai" and "Connect to BigModel". No WebSocket was opened. The harmless prompt
was not typed. Pairing, workspace list, and an agent reply remain untested
until `ZCODE_JWT` from the same desktop account is available.

## Safety

- Anyone who holds the link plus the account JWT can operate the desktop window.
- The phone does not get its own runtime. Commands run on the machine that
  workspace was already attached to (local, SSH, WSL, or Docker).
- Closing the driver does not click "Stop remote control" inside the desktop
  app. The desktop keeps the remote switch on until someone stops it there.
- A prompt can read and write that machine. Scope it in the prompt text.
