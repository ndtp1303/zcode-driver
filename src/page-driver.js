import { existsSync } from "node:fs";
import { classifyPageText, failureReason } from "./page-state.js";
import { redact, summarizeFrame } from "./output.js";

const SEND_NAME = /^(Send|发送)$/;
const STOP_NAME = /^(Stop|停止生成)$/;
const ALLOW_NAME = /^(Allow|允许)$/;
const DENY_NAME = /^(Deny|拒绝)$/;

export function findChrome(env = process.env) {
  const candidates = [
    env.ZCODE_CHROME?.trim(),
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

export async function withRemotePage({ link, credentials, secrets, log, timeoutMs }, run) {
  const chrome = findChrome();
  if (!chrome) {
    throw coded("chrome-missing", "Chrome/Chromium not found. Set ZCODE_CHROME.");
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: chromeArgs(),
  });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1400, height: 900 },
    });
    if (credentials?.ok) {
      await context.addInitScript((keys) => {
        localStorage.setItem("oauth:active_provider", keys.provider);
        localStorage.setItem("zcodejwttoken", keys.jwt);
        localStorage.setItem(keys.accessKey, keys.accessToken);
        localStorage.setItem(keys.userKey, keys.userInfo);
      }, credentials);
    }
    const page = await context.newPage();
    page.on("websocket", (socket) => {
      const record = (direction, payload) => {
        const text = payloadToText(payload);
        log?.event({
          type: "relay",
          direction,
          ...summarizeFrame(redact(text, secrets)),
        });
      };
      socket.on("framesent", (frame) => record("out", frame.payload));
      socket.on("framereceived", (frame) => record("in", frame.payload));
      socket.on("close", () => log?.event({ type: "relay", event: "socket-close" }));
    });
    page.on("pageerror", (error) => log?.err(`pageerror: ${error.message}`));
    await page.goto(link.pageUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 45_000) });
    const state = await waitForSurface(page, Math.min(timeoutMs, 30_000));
    log?.event({ type: "driver", event: "page", state: state.kind, detail: state.detail ?? null });
    return await run(page, state);
  } finally {
    await browser.close();
  }
}

export async function sendPrompt(page, prompt, timeoutMs) {
  if (!(await page.locator("[data-lexical-editor='true']").count())) {
    throw coded("composer-missing", "The remote page has no composer. The desktop session is not ready.");
  }
  const before = await finalReply(page, "");
  await typeIntoComposer(page, prompt);
  const send = page.getByRole("button", { name: SEND_NAME });
  if (await send.count()) await send.last().click();
  else await page.keyboard.press("Enter");
  return waitForReply(page, prompt, before, timeoutMs);
}

export async function clickStop(page) {
  const stop = page.getByRole("button", { name: STOP_NAME });
  if (!(await stop.count())) return false;
  await stop.last().click();
  return true;
}

export async function listApprovals(page) {
  const cards = page.locator("[data-trajectory-message-role='tool'], [data-trajectory-expandable-role='tool-call']");
  const count = await cards.count();
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const text = (await cards.nth(index).innerText()).replace(/\s+/g, " ").trim();
    if (/Permission required|需要权限|Awaiting approval|等待确认/.test(text)) rows.push(text.slice(0, 500));
  }
  const visible = await page.getByText(/Permission required|需要权限|Awaiting approval|等待确认/).allInnerTexts();
  for (const text of visible) {
    const flat = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (flat && !rows.includes(flat)) rows.push(flat);
  }
  return rows;
}

export async function decideApproval(page, decision) {
  const name = decision === "deny" ? DENY_NAME : ALLOW_NAME;
  const button = page.getByRole("button", { name, exact: true });
  if (!(await button.count())) return false;
  await button.last().click();
  return true;
}

async function waitForSurface(page, timeoutMs) {
  try {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || "";
      if (/Sign In To Continue|登录后继续使用 Web 远程控制/.test(text)) return true;
      if (document.querySelector("[data-lexical-editor='true']")) return true;
      return /Device disconnected|设备未连接|does not belong|Access Link Expired|Remote Control Ended|Taken Over By Another Device|Workspace Closed|Desktop Offline|Mobile Connection Invalid|Desktop Timed Out|Relay Unavailable|Web Remote Control Failed|该设备不属于|访问链接已失效|桌面端已离线|已被其他设备接管/.test(text);
    }, null, { timeout: timeoutMs });
  } catch {
    const text = await bodyText(page);
    return { kind: "timeout", detail: failureReason(text), text };
  }
  const text = await bodyText(page);
  if (await page.locator("[data-lexical-editor='true']").count()) {
    return { kind: "ready", text };
  }
  const kind = classifyPageText(text);
  return { kind: kind === "unknown" ? "unknown" : kind, detail: failureReason(text), text };
}

async function typeIntoComposer(page, prompt) {
  const editor = page.locator("[data-lexical-editor='true']").last();
  await editor.click();
  await page.keyboard.insertText(prompt);
  const got = await editor.innerText();
  if (!got.includes(prompt.slice(0, Math.min(20, prompt.length)))) {
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await editor.pressSequentially(prompt, { delay: 5 });
  }
}

async function waitForReply(page, prompt, before, timeoutMs) {
  const started = Date.now();
  let sawActivity = false;
  let last = before;
  let stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    const now = await finalReply(page, prompt);
    const running = await page.locator("[data-running='true'], [data-v4-running-live-tail='true']").count();
    const stopVisible = await page.getByRole("button", { name: STOP_NAME }).count();
    if (now !== last || running || stopVisible) {
      sawActivity = true;
      last = now;
      stableSince = Date.now();
    }
    if (sawActivity && !running && !stopVisible && now && now !== before && Date.now() - stableSince > 2000) {
      return now;
    }
    await page.waitForTimeout(400);
  }
  const latest = await finalReply(page, prompt);
  if (latest && latest !== before) return latest;
  throw coded("reply-timeout", "The desktop session did not finish a reply before the timeout");
}

async function finalReply(page, prompt) {
  const assistants = page.locator("[data-trajectory-message-role='assistant']");
  const count = await assistants.count();
  if (count) return (await assistants.nth(count - 1).innerText()).trim();
  const turns = page.locator("[data-turn-id]");
  const turnsCount = await turns.count();
  if (!turnsCount) return "";
  let text = (await turns.nth(turnsCount - 1).innerText()).trim();
  const needle = prompt.trim();
  if (needle) {
    const index = text.lastIndexOf(needle);
    if (index >= 0) text = text.slice(index + needle.length).trim();
  }
  return text;
}

async function bodyText(page) {
  return page.locator("body").innerText().catch(() => "");
}

function payloadToText(payload) {
  if (typeof payload === "string") return payload;
  if (payload instanceof Buffer) return payload.toString("utf8");
  return String(payload);
}

function chromeArgs() {
  const args = ["--disable-dev-shm-usage"];
  if (process.env.ZCODE_CHROME_NO_SANDBOX !== "0") args.push("--no-sandbox");
  return args;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
