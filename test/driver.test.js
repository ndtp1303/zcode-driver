import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { jwtExpiry, readCredentials } from "../src/credentials.js";
import { RunLog, redact, summarizeFrame } from "../src/output.js";
import { classifyPageText } from "../src/page-state.js";
import { buildAuthInit, buildData, mintTerminalToken } from "../src/relay.js";
import { parseRemoteUrl, relayWsUrl } from "../src/remote-url.js";
import { matchProject, parseMode, profileDir } from "../src/session-options.js";
import { plainChromeArgs } from "../src/plain-chrome.js";
import { loginAndPair } from "../src/page-driver.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("v2 link keeps sid and mid and drops nothing secret into the description", () => {
  const link = parseRemoteUrl(
    "https://zcode.z.ai/remote/v4?sid=sid-value&mid=mid-value&name=Mac&app_version=3.16.3",
  );
  assert.equal(link.ok, true);
  assert.equal(link.deviceSid, "sid-value");
  assert.equal(link.deviceMid, "mid-value");
  assert.equal(link.deviceName, "Mac");
  assert.equal(link.appVersion, "3.16.3");
  assert.equal(link.origin, "https://zcode.z.ai");
});

test("v1 hash link is rejected", () => {
  const link = parseRemoteUrl("https://zcode.z.ai/remote/v4?sid=abc&hash=dead&t=1&mid=m");
  assert.equal(link.ok, false);
  assert.equal(link.code, "v1-link");
});

test("missing sid fails a run link and is allowed for list", () => {
  const required = parseRemoteUrl("https://zcode.z.ai/remote/v4?mid=only-mid");
  assert.equal(required.code, "missing-sid");
  const listed = parseRemoteUrl("https://zcode.z.ai/remote/v4?mid=only-mid", { requireSid: false });
  assert.equal(listed.ok, true);
  assert.equal(listed.deviceSid, "");
});

test("relay websocket url is ws2 on the link origin", () => {
  assert.equal(relayWsUrl("https://zcode.z.ai"), "wss://zcode.z.ai/api/v1/remote/ws2");
  assert.equal(relayWsUrl("http://127.0.0.1:3030"), "ws://127.0.0.1:3030/api/v1/remote/ws2");
});

test("auth_init carries the device sid and does not invent a hash", () => {
  const message = buildAuthInit({ deviceSid: "sid-value", appVersion: "3.16.3", now: 1_700_000_000_000 });
  assert.deepEqual(message, {
    type: "auth_init",
    device_sid: "sid-value",
    meta: { platform: "web", version: "3.16.3", name: "zcode-driver" },
    client_ts: 1_700_000_000,
  });
  assert.equal("hash" in message, false);
  const data = buildData({ zcode_type: "workspace-list-request", requestId: "workspace-list-1" }, 1_700_000_000_000);
  assert.equal(data.type, "data");
  assert.equal(data.payload.zcode_type, "workspace-list-request");
});

test("token mint maps HTTP 401 to auth-required", async () => {
  const fetchImpl = async () => ({ status: 401, ok: false, json: async () => ({}) });
  await assert.rejects(
    () => mintTerminalToken("https://zcode.z.ai", "jwt", fetchImpl),
    (error) => error.code === "auth-required",
  );
});

test("jwt expiry uses the exp claim and a 30s skew", () => {
  const exp = Math.floor(Date.now() / 1000) + 10;
  const token = `aaa.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  assert.equal(jwtExpiry(token).kind, "expired");
  const later = Math.floor(Date.now() / 1000) + 3600;
  const fresh = `aaa.${Buffer.from(JSON.stringify({ exp: later })).toString("base64url")}.sig`;
  assert.equal(jwtExpiry(fresh).kind, "valid");
  assert.equal(readCredentials({}).code, "auth-required");
});

test("page text classifies login and desktop failure", () => {
  assert.equal(classifyPageText("ZCode\nSign In To Continue\nConnect to Z.ai"), "login");
  assert.equal(classifyPageText("登录后继续使用 Web 远程控制"), "login");
  assert.equal(classifyPageText("This device does not belong to this account"), "failure");
  assert.equal(classifyPageText("Desktop Offline"), "failure");
  assert.equal(classifyPageText("Device disconnected. Reconnect to continue this conversation."), "disconnected");
});

test("run log writes the omp-shaped files and redacts secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-driver-"));
  try {
    const log = new RunLog(dir);
    log.event({ type: "driver", event: "page", state: "login" });
    log.err("auth-required");
    log.final("");
    log.meta({ exit: 2, seconds: 1, mode: "playwright" });
    assert.match(readFileSync(join(dir, "run.jsonl"), "utf8"), /"state":"login"/);
    assert.match(readFileSync(join(dir, "run.err"), "utf8"), /auth-required/);
    assert.equal(readFileSync(join(dir, "final.txt"), "utf8"), "");
    assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).exit, 2);
    assert.equal(redact("sid-value is here", ["sid-value"]), "[redacted] is here");
    assert.deepEqual(summarizeFrame('{"type":"auth_ack"}'), { message: { type: "auth_ack" }, truncated: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile path and permission mode defaults", () => {
  assert.equal(profileDir({ HOME: "/home/me", ZCODE_PROFILE: "~/profiles/zcode" }).endsWith("/profiles/zcode"), true);
  assert.equal(parseMode("").mode.id, "build");
  assert.equal(parseMode("Ask before changes").mode.en, "Ask before changes");
  assert.equal(parseMode("full").mode.id, "yolo");
  assert.equal(parseMode("nope").ok, false);
  assert.equal(matchProject(["topup", "topup_netease"], "topup").name, "topup");
  assert.equal(matchProject(["topup", "topup_netease"], "top").code, "ambiguous-project");
  assert.equal(matchProject(["wrongway", "muakey"], "WrongWay").name, "wrongway");
});

test("login spawns plain Chrome and checks the profile only after it closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-login-"));
  const lock = join(dir, "SingletonLock");
  const url = "https://zcode.z.ai/remote/v4?sid=abc&mid=def";
  let verifiedWhileLocked = false;
  try {
    await loginAndPair({
      link: { pageUrl: url, deviceSid: "abc", deviceMid: "def" },
      profile: dir,
      chromePath: "/usr/bin/google-chrome",
      sleep: () => Promise.resolve(),
      spawnImpl: (_chrome, args) => {
        assert.deepEqual(args, plainChromeArgs(dir, url));
        assert.equal(args.some((arg) => /enable-automation|remote-debugging|disable-blink-features/.test(arg)), false);
        symlinkSync("linux-box-1", lock);
        return fakeChild(() => unlinkSync(lock));
      },
      verifyImpl: async () => {
        verifiedWhileLocked = existsLock(lock);
        return true;
      },
    });
    assert.equal(verifiedWhileLocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login-incomplete when the headless check does not see the task list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-login-"));
  const lock = join(dir, "SingletonLock");
  try {
    await assert.rejects(
      () => loginAndPair({
        link: { pageUrl: "https://zcode.z.ai/remote/v4?sid=abc", deviceSid: "abc" },
        profile: dir,
        chromePath: "/bin/true",
        sleep: () => Promise.resolve(),
        spawnImpl: () => {
          symlinkSync("linux-box-2", lock);
          return fakeChild(() => unlinkSync(lock));
        },
        verifyImpl: async () => false,
      }),
      (error) => error.code === "login-incomplete",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeChild(onExit) {
  const listeners = { exit: [], error: [] };
  queueMicrotask(() => {
    onExit();
    for (const listener of listeners.exit) listener(0);
  });
  return {
    once(event, listener) {
      listeners[event].push(listener);
    },
  };
}

function existsLock(lock) {
  try {
    lstatSync(lock);
    return true;
  } catch {
    return false;
  }
}

test("run rejects an unknown mode before launching chrome", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-mode-"));
  try {
    const result = spawnSync(process.execPath, [join(root, "src/cli.js"), "--mode", "nope", dir, "hello"], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_REMOTE_URL: "https://zcode.z.ai/remote/v4?sid=abc&mid=def", ZCODE_JWT: "" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli refuses to run without a remote url", () => {
  const result = spawnSync(process.execPath, [join(root, "src/cli.js"), "/tmp/unused", "hello"], {
    encoding: "utf8",
    env: { ...process.env, ZCODE_REMOTE_URL: "", ZCODE_JWT: "" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ZCODE_REMOTE_URL/);
});
