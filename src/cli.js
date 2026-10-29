#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readCredentials } from "./credentials.js";
import { RunLog } from "./output.js";
import { listDevices, openRelay, readPairStatus, readWorkspaces, summarizeWorkspaces } from "./relay.js";
import { describeLink, parseRemoteUrl } from "./remote-url.js";
import { parseMode, profileDir } from "./session-options.js";

const COMMANDS = new Set(["login", "run", "status", "list", "continue", "stop", "approvals", "approve"]);

const HELP = `run-zcode — giao việc cho zcode desktop qua trang remote

Cách dùng:
  run-zcode login
  run-zcode [--project TÊN] [--mode ask] <thư-mục> <file-prompt | "prompt">
  run-zcode status
  run-zcode list
  run-zcode continue <thư-mục> <file-prompt | "prompt">
  run-zcode stop [thư-mục]
  run-zcode approvals [thư-mục]
  run-zcode approve allow|deny [thư-mục]

Tuỳ chọn:
  --url URL          thay cho ZCODE_REMOTE_URL
  --timeout SECONDS  thời gian chờ trả lời (mặc định 180)
  --project TÊN      project trong Select project (chỉ run)
  --mode MODE        mặc định ask = Ask before changes

Đăng nhập: login mở Chrome có cửa sổ, profile ~/.zcode-driver/profile
  (ZCODE_PROFILE để đổi). Ký Z.ai, rồi bấm chấp nhận trên app desktop.
  Các lệnh sau dùng lại profile đó, headless. ZCODE_JWT là cách khác, không bắt buộc.
`;

async function main(argv) {
  const { command, flags, positionals } = parseArgs(argv);
  if (flags.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (!COMMANDS.has(command)) {
    process.stderr.write(HELP);
    return 2;
  }
  const requireSid = command !== "list";
  const link = parseRemoteUrl(flags.url || process.env.ZCODE_REMOTE_URL, { requireSid });
  if (!link.ok && !(command === "list" && link.code === "missing-sid")) {
    process.stderr.write(`${link.message}\n`);
    return 2;
  }
  const credentials = readCredentials();
  const timeoutSec = Number(flags.timeout || process.env.ZCODE_TIMEOUT || 180);
  const timeoutMs = (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 180) * 1000;
  try {
    if (command === "login") return await cmdLogin(link);
    if (command === "status") return await cmdStatus(link, credentials, timeoutMs);
    if (command === "list") return await cmdList(link.ok ? link : null, credentials, timeoutMs);
    if (command === "run" || command === "continue") {
      return await cmdRun(command, link, credentials, positionals, timeoutMs, flags);
    }
    if (command === "stop") return await cmdStop(link, credentials, positionals[0], timeoutMs);
    if (command === "approvals") return await cmdApprovals(link, credentials, positionals[0], timeoutMs);
    if (command === "approve") return await cmdApprove(link, credentials, positionals, timeoutMs);
  } catch (error) {
    process.stderr.write(`${error.code || "error"}: ${error.message}\n`);
    return error.code === "auth-required" || error.code === "jwt-expired" ? 2 : 1;
  }
  return 2;
}

async function cmdLogin(link) {
  const profile = profileDir();
  const { loginAndPair } = await import("./page-driver.js");
  try {
    await loginAndPair({ link, profile });
  } catch (error) {
    process.stderr.write(`${error.code || "error"}: ${error.message}\n`);
    return error.code === "login-incomplete" || error.code === "chrome-missing" ? 2 : 1;
  }
  process.stderr.write(`Saved Chrome profile: ${profile}\n`);
  return 0;
}

async function cmdStatus(link, credentials, timeoutMs) {
  if (!credentials.ok) return browserStatus(link, timeoutMs);
  const devices = await listDevices(link.origin, credentials.jwt).catch((error) => {
    if (error.code !== "auth-required") throw error;
    return null;
  });
  if (devices === null) return printAuth({ code: "auth-required", message: "Relay rejected the JWT" });
  const matched = devices.filter((device) => device.deviceSid === link.deviceSid || (link.deviceMid && device.deviceMid === link.deviceMid));
  let pair = null;
  let pairError = null;
  const session = await openRelay({
    origin: link.origin,
    jwt: credentials.jwt,
    deviceSid: link.deviceSid,
    deviceMid: link.deviceMid,
    appVersion: link.appVersion,
    timeoutMs: Math.min(timeoutMs, 20_000),
  });
  try {
    pair = await readPairStatus(session, Math.min(timeoutMs, 20_000));
  } catch (error) {
    pairError = { code: error.code, message: error.message };
  } finally {
    session.close();
  }
  const body = {
    link: describeLink(link),
    devices: (matched.length ? matched : devices).map((device) => publicDevice(device, link)),
    pair,
    pairError,
  };
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return pairError ? 1 : 0;
}

async function cmdList(link, credentials, timeoutMs) {
  if (!credentials.ok) return browserList(link, timeoutMs);
  if (!link?.origin) {
    process.stderr.write("ZCODE_REMOTE_URL is not set\n");
    return 2;
  }
  const origin = link.origin;
  const devices = await listDevices(origin, credentials.jwt);
  let workspaces = null;
  if (link?.deviceSid) {
    const session = await openRelay({
      origin: link.origin,
      jwt: credentials.jwt,
      deviceSid: link.deviceSid,
      deviceMid: link.deviceMid,
      appVersion: link.appVersion,
      timeoutMs: Math.min(timeoutMs, 20_000),
    });
    try {
      const pair = await readPairStatus(session, Math.min(timeoutMs, 20_000));
      if (pair.pairStatus === "matched") {
        const read = await readWorkspaces(session, Math.min(timeoutMs, 15_000));
        workspaces = summarizeWorkspaces(read.workspaces || read.bootstrap);
      } else {
        workspaces = { pairStatus: pair.pairStatus };
      }
    } catch (error) {
      workspaces = { error: error.code || "error", message: error.message };
    } finally {
      session.close();
    }
  }
  process.stdout.write(`${JSON.stringify({
    devices: devices.map((device) => publicDevice(device, link)),
    workspaces,
  }, null, 2)}\n`);
  return 0;
}

async function cmdRun(command, link, credentials, positionals, timeoutMs, flags) {
  if (positionals.length < 2) {
    process.stderr.write(HELP);
    return 2;
  }
  const dir = resolve(positionals[0]);
  const prompt = loadPrompt(positionals[1]);
  const started = Date.now();
  const log = new RunLog(dir, { append: command === "continue" });
  log.prompt(prompt);
  const modeChoice = command === "run" ? parseMode(flags.mode) : { ok: true, mode: null };
  const useProfile = !credentials.ok;
  const profile = useProfile ? profileDir() : null;
  const finish = (exit, reason, reply = "") => {
    log.final(reply);
    log.meta({
      exit,
      seconds: Math.round((Date.now() - started) / 1000),
      mode: useProfile ? "playwright-profile" : "playwright-jwt",
      command,
      reason,
      auth: useProfile ? "profile" : "jwt",
      profile,
      project: flags.project || null,
      permissionMode: modeChoice.ok ? modeChoice.mode?.id ?? null : null,
      ...describeLink(link),
      dir,
    });
    process.stderr.write(`zcode ${command}: exit=${exit}, ${Math.round((Date.now() - started) / 1000)}s, dir: ${dir}\n`);
    if (reply) process.stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
    return exit;
  };
  if (command === "continue" && (flags.project || flags.mode)) {
    const message = "continue keeps the open task. Use run --project and --mode to start a new task.";
    log.err(message);
    process.stderr.write(`${message}\n`);
    return finish(2, "continue-options");
  }
  if (!modeChoice.ok) {
    const message = `${modeChoice.code}: ${modeChoice.message}. Prompt was not sent.`;
    log.err(message);
    process.stderr.write(`${message}\n`);
    return finish(2, modeChoice.code);
  }
  if (!credentials.ok && credentials.code !== "auth-required" && credentials.code !== "jwt-expired") {
    const message = `${credentials.code}: ${credentials.message}. Prompt was not sent.`;
    log.err(message);
    process.stderr.write(`${message}\n`);
    return finish(2, credentials.code);
  }
  const { withRemotePage, sendPrompt, prepareNewTask } = await import("./page-driver.js");
  try {
    const reply = await withRemotePage({
      link,
      credentials: credentials.ok ? credentials : null,
      profile,
      headless: true,
      secrets: [credentials.jwt, credentials.accessToken, link.deviceSid, link.deviceMid].filter(Boolean),
      log,
      timeoutMs,
    }, async (page, state) => {
      if (state.kind !== "ready") {
        const reason = state.kind === "login"
          ? (credentials.code === "jwt-expired" ? "jwt-expired" : "auth-required")
          : state.kind;
        const error = coded(reason, "Remote page is not ready for a prompt");
        const pairing = state.kind === "timeout" || state.kind === "unknown"
          ? "\nIf the account is signed in, approve the pairing request on the desktop app."
          : "";
        error.detail = `${(state.text || "").slice(0, 500)}${pairing}`;
        throw error;
      }
      if (command === "run") await prepareNewTask(page, { project: flags.project, mode: modeChoice.mode, log });
      log.event({ type: "driver", event: "prompt-sent", chars: prompt.length });
      const text = await sendPrompt(page, prompt, timeoutMs);
      log.event({ type: "driver", event: "reply", chars: text.length });
      return text;
    });
    return finish(0, "ok", reply);
  } catch (error) {
    const code = error.code || "error";
    const sent = code === "reply-timeout";
    log.err(`${code}: ${error.message}${sent ? "" : ". Prompt was not sent."}\n${error.detail || ""}`.trim());
    return finish(code === "auth-required" || code === "login" || code === "jwt-expired" ? 2 : 1, code);
  }
}

async function cmdStop(link, credentials, dirArg, timeoutMs) {
  return pageAction(link, credentials, dirArg, timeoutMs, "stop", async (page, log) => {
    const { clickStop } = await import("./page-driver.js");
    const clicked = await clickStop(page);
    log?.event({ type: "driver", event: "stop", clicked });
    process.stdout.write(clicked ? "stopped\n" : "nothing-running\n");
    if (!clicked) throw coded("nothing-running", "No Stop button is visible");
  });
}

async function cmdApprovals(link, credentials, dirArg, timeoutMs) {
  return pageAction(link, credentials, dirArg, timeoutMs, "approvals", async (page, log) => {
    const { listApprovals } = await import("./page-driver.js");
    const rows = await listApprovals(page);
    log?.event({ type: "driver", event: "approvals", count: rows.length });
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });
}

async function cmdApprove(link, credentials, positionals, timeoutMs) {
  const decision = positionals[0];
  if (decision !== "allow" && decision !== "deny") {
    process.stderr.write("approve cần allow hoặc deny\n");
    return 2;
  }
  const dirArg = positionals[1];
  return pageAction(link, credentials, dirArg, timeoutMs, "approve", async (page, log) => {
    const { decideApproval } = await import("./page-driver.js");
    const clicked = await decideApproval(page, decision);
    log?.event({ type: "driver", event: "approve", decision, clicked });
    if (!clicked) throw coded("approval-missing", `No ${decision} button is visible`);
    process.stdout.write(`${decision}\n`);
  });
}

async function browserStatus(link, timeoutMs) {
  const profile = profileDir();
  const { withRemotePage, readSession } = await import("./page-driver.js");
  const session = await withRemotePage({
    link,
    credentials: null,
    profile,
    headless: true,
    secrets: [link.deviceSid, link.deviceMid],
    timeoutMs,
  }, async (page, state) => ({ ...await readSession(page), surface: state.kind }));
  process.stdout.write(`${JSON.stringify({ auth: "profile", profile, ...session }, null, 2)}\n`);
  return session.page === "ready" || session.surface === "ready" ? 0 : 2;
}

async function browserList(link, timeoutMs) {
  if (!link?.origin) {
    process.stderr.write("ZCODE_REMOTE_URL is not set\n");
    return 2;
  }
  const profile = profileDir();
  const { withRemotePage, listVisibleWork, readSession } = await import("./page-driver.js");
  const body = await withRemotePage({
    link,
    credentials: null,
    profile,
    headless: true,
    secrets: [link.deviceSid, link.deviceMid],
    timeoutMs,
  }, async (page, state) => {
    if (state.kind !== "ready") {
      const error = coded(state.kind === "login" ? "auth-required" : state.kind, "Remote page is not signed in");
      error.detail = (state.text || "").slice(0, 300);
      throw error;
    }
    return { session: await readSession(page), ...(await listVisibleWork(page)) };
  });
  process.stdout.write(`${JSON.stringify({ auth: "profile", profile, ...body }, null, 2)}\n`);
  return 0;
}

async function pageAction(link, credentials, dirArg, timeoutMs, command, action) {
  const useProfile = !credentials.ok;
  if (!credentials.ok && credentials.code !== "auth-required" && credentials.code !== "jwt-expired") {
    return printAuth(credentials);
  }
  const profile = useProfile ? profileDir() : null;
  const started = Date.now();
  const log = dirArg ? new RunLog(resolve(dirArg), { append: true }) : null;
  const { withRemotePage } = await import("./page-driver.js");
  try {
    await withRemotePage({
      link,
      credentials: credentials.ok ? credentials : null,
      profile,
      headless: true,
      secrets: [credentials.jwt, credentials.accessToken, link.deviceSid, link.deviceMid].filter(Boolean),
      log,
      timeoutMs,
    }, async (page, state) => {
      if (state.kind !== "ready") {
        throw coded(state.kind === "login" ? "auth-required" : state.kind, "Remote page is not ready");
      }
      await action(page, log);
    });
    log?.meta({
      exit: 0,
      seconds: Math.round((Date.now() - started) / 1000),
      mode: "playwright",
      command,
      reason: "ok",
      dir: dirArg ? resolve(dirArg) : null,
    });
    return 0;
  } catch (error) {
    log?.err(`${error.code || "error"}: ${error.message}`);
    const exit = error.code === "auth-required" || error.code === "jwt-expired" ? 2 : 1;
    log?.meta({
      exit,
      seconds: Math.round((Date.now() - started) / 1000),
      mode: "playwright",
      command,
      reason: error.code || "error",
      dir: dirArg ? resolve(dirArg) : null,
    });
    process.stderr.write(`${error.code || "error"}: ${error.message}\n`);
    return exit;
  }
}

function printAuth(credentials) {
  process.stderr.write(`${credentials.code}: ${credentials.message}\n`);
  return 2;
}

function publicDevice(device, link) {
  const selected = Boolean(link && (device.deviceSid === link.deviceSid || (link.deviceMid && device.deviceMid === link.deviceMid)));
  return {
    selected,
    online: device.online,
    name: device.name,
    platform: device.platform,
    version: device.version,
  };
}

function loadPrompt(spec) {
  if (spec && existsSync(spec) && statSync(spec).isFile()) return readFileSync(spec, "utf8");
  return spec ?? "";
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--url" || arg === "--timeout" || arg === "--project" || arg === "--mode") {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else positionals.push(arg);
  }
  let command = "run";
  if (positionals[0] && (COMMANDS.has(positionals[0]) || positionals[0] === "help")) {
    command = positionals.shift();
  }
  return { command, flags, positionals };
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
