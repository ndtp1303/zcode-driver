import { existsSync, mkdirSync } from "node:fs";
import { classifyPageText, failureReason } from "./page-state.js";
import { redact, summarizeFrame } from "./output.js";
import { matchProject, modeAlreadySelected } from "./session-options.js";
import { plainChromeArgs, waitForPlainChrome } from "./plain-chrome.js";

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

export async function withRemotePage({ link, credentials, secrets, log, timeoutMs, profile, headless = true }, run) {
  const opened = await openChrome({ profile, headless, credentials });
  try {
    const { page } = opened;
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
    log?.event({ type: "driver", event: "page", state: state.kind, detail: state.detail ?? null, auth: profile ? "profile" : "jwt" });
    return await run(page, state);
  } finally {
    await opened.close();
  }
}

export async function loginAndPair({ link, profile, chromePath, spawnImpl, verifyImpl, sleep }) {
  mkdirSync(profile, { recursive: true });
  const chrome = chromePath || findChrome();
  if (!chrome) throw coded("chrome-missing", "Chrome/Chromium not found. Set ZCODE_CHROME.");
  process.stderr.write(
    [
      `Opening plain Chrome with profile ${profile}.`,
      "This window is not automated, so Google sign-in can proceed.",
      "Sign in with the same Z.ai account as the desktop.",
      "When the desktop app asks to approve this browser, accept it there.",
      "After the task list appears, close Chrome. The profile is checked after that.",
      "",
    ].join("\n"),
  );
  await waitForPlainChrome({
    chrome,
    args: plainChromeArgs(profile, link.pageUrl),
    profile,
    spawnImpl,
    sleep,
  });
  const ready = verifyImpl
    ? await verifyImpl({ link, profile })
    : await profileHasTaskList({ link, profile });
  if (!ready) {
    throw coded(
      "login-incomplete",
      "Chrome closed before the task list appeared. Sign in, then approve the pairing request on the desktop app.",
    );
  }
  process.stderr.write("Task list is visible.\n");
}

async function profileHasTaskList({ link, profile }) {
  const open = () => withRemotePage({
    link,
    credentials: null,
    profile,
    headless: true,
    secrets: [link.deviceSid, link.deviceMid].filter(Boolean),
    timeoutMs: 45_000,
  }, async (page, state) => state.kind === "ready" && (await page.locator("[data-testid='task-new-button']").count()) > 0);
  try {
    return await open();
  } catch (error) {
    if (error.code !== "profile-busy") throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return open();
  }
}

export async function readSession(page) {
  const text = await bodyText(page);
  const ready = (await page.locator("[data-testid='task-new-button'], [data-lexical-editor='true']").count()) > 0;
  const kind = ready ? "ready" : classifyPageText(text);
  return {
    page: kind,
    deviceName: await deviceName(page),
    project: await labeledText(page, "[data-testid='composer-workspace-trigger']"),
    mode: await labeledText(page, "[data-testid='chat-mode-select-trigger']"),
    detail: failureReason(text),
  };
}

export async function listVisibleWork(page) {
  const sidebar = await texts(page, "[data-testid='virtual-project-root-name']");
  const tasks = await texts(page, "[data-testid^='task-item-']");
  let projects = [];
  const trigger = page.locator("[data-testid='composer-workspace-trigger']");
  if (await trigger.count()) {
    await trigger.first().click();
    const menu = page.locator("[data-testid='composer-project-menu']");
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    projects = await menu.locator("[data-project-name]").evaluateAll((nodes) => nodes.map((node) => ({
      name: node.getAttribute("data-project-name"),
      offline: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("data-disabled"),
      device: node.querySelector("[data-testid='composer-project-device']")?.textContent?.trim() || null,
    })));
    await page.keyboard.press("Escape");
  }
  return {
    projects,
    sidebarProjects: sidebar,
    tasks: tasks.map((row) => row.split("\n")[0].trim()).filter(Boolean).slice(0, 40),
  };
}

export async function prepareNewTask(page, { project, mode, log }) {
  const created = page.locator("[data-testid='task-new-button']");
  if (!(await created.count())) {
    throw coded("new-task-missing", "New task button was not found. The page may still be waiting for desktop approval.");
  }
  await created.first().click();
  log?.event({ type: "driver", event: "new-task" });
  await page.locator("[data-lexical-editor='true']").last().waitFor({ state: "visible", timeout: 20_000 });
  if (project) await selectProject(page, project, log);
  await selectMode(page, mode, log);
}

async function selectProject(page, project, log) {
  const trigger = page.locator("[data-testid='composer-workspace-trigger']");
  await trigger.first().click();
  const menu = page.locator("[data-testid='composer-project-menu']");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const search = menu.locator("input");
  if (await search.count()) await search.first().fill(project);
  await page.waitForTimeout(300);
  const names = await menu.locator("[data-project-name]").evaluateAll((nodes) => nodes
    .filter((node) => node.getAttribute("aria-disabled") !== "true" && !node.hasAttribute("data-disabled"))
    .map((node) => node.getAttribute("data-project-name")));
  const matched = matchProject(names, project);
  if (!matched.ok) {
    await page.keyboard.press("Escape");
    const error = coded(matched.code, matched.code === "ambiguous-project"
      ? `Project "${project}" matches more than one: ${matched.names.join(", ")}`
      : `Project "${project}" was not in Select project. Visible: ${matched.names.join(", ") || "(none)"}`);
    error.names = matched.names;
    throw error;
  }
  const item = menu.locator(`[data-project-name="${cssAttr(matched.name)}"]`);
  if (!(await item.count())) throw coded("project-not-found", `Could not click project ${matched.name}`);
  await item.first().click();
  log?.event({ type: "driver", event: "project", name: matched.name });
}

async function selectMode(page, mode, log) {
  const trigger = page.locator("[data-testid='chat-mode-select-trigger']");
  if (!(await trigger.count())) {
    throw coded("mode-missing", "Mode switch was not found, so the driver will not send in an unknown permission mode.");
  }
  const current = await trigger.first().innerText().catch(() => "");
  if (modeAlreadySelected(current, mode)) {
    log?.event({ type: "driver", event: "mode", id: mode.id, already: true });
    return;
  }
  await trigger.first().click();
  const item = page.locator(`[data-testid='chat-mode-select-item-${mode.id}']`);
  await item.first().click({ timeout: 10_000 });
  log?.event({ type: "driver", event: "mode", id: mode.id, label: mode.en });
}

async function openChrome({ profile, headless, credentials }) {
  const chrome = findChrome();
  if (!chrome) throw coded("chrome-missing", "Chrome/Chromium not found. Set ZCODE_CHROME.");
  const { chromium } = await import("playwright-core");
  const viewport = headless ? { width: 1400, height: 900 } : null;
  if (profile) {
    mkdirSync(profile, { recursive: true });
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: chrome,
        headless,
        locale: "en-US",
        viewport,
        args: chromeArgs(headless),
      });
    } catch (error) {
      const busy = /SingletonLock|process_singleton|profile.*in use|already running/i.test(error.message);
      throw coded(busy ? "profile-busy" : "chrome-failed", error.message);
    }
    if (credentials?.ok) await injectLogin(context, credentials);
    const page = context.pages()[0] ?? await context.newPage();
    return { page, context, close: () => context.close() };
  }
  const browser = await chromium.launch({
    executablePath: chrome,
    headless,
    args: chromeArgs(headless),
  });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1400, height: 900 } });
  if (credentials?.ok) await injectLogin(context, credentials);
  const page = await context.newPage();
  return { page, context, close: () => browser.close() };
}

async function injectLogin(context, credentials) {
  await context.addInitScript((keys) => {
    localStorage.setItem("oauth:active_provider", keys.provider);
    localStorage.setItem("zcodejwttoken", keys.jwt);
    localStorage.setItem(keys.accessKey, keys.accessToken);
    localStorage.setItem(keys.userKey, keys.userInfo);
  }, credentials);
}

async function deviceName(page) {
  const button = page.getByRole("button", { name: /Switch device|切换设备/ });
  if (!(await button.count())) return null;
  const text = (await button.first().innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  return text[0] ?? null;
}

async function labeledText(page, selector) {
  const node = page.locator(selector);
  if (!(await node.count())) return null;
  return (await node.first().innerText()).replace(/\s+/g, " ").trim() || null;
}

async function texts(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes
    .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean));
}

export async function sendPrompt(page, prompt, timeoutMs) {
  if (!(await page.locator("[data-lexical-editor='true']").count())) {
    throw coded("composer-missing", "The remote page has no composer. The desktop session is not ready.");
  }
  const before = await finalReply(page, "");
  await typeIntoComposer(page, prompt);
  const send = page.getByRole("button", { name: SEND_NAME });
  if (await send.count()) {
    if (await send.last().isDisabled()) {
      throw coded("send-disabled", "Send is disabled. Choose a project with --project, and confirm the desktop approved pairing.");
    }
    await send.last().click();
  } else await page.keyboard.press("Enter");
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
      if (document.querySelector("[data-testid='task-new-button'], [data-lexical-editor='true']")) return true;
      return /Device disconnected|设备未连接|does not belong|Access Link Expired|Remote Control Ended|Taken Over By Another Device|Workspace Closed|Desktop Offline|Mobile Connection Invalid|Desktop Timed Out|Relay Unavailable|Web Remote Control Failed|该设备不属于|访问链接已失效|桌面端已离线|已被其他设备接管/.test(text);
    }, null, { timeout: timeoutMs });
  } catch {
    const text = await bodyText(page);
    return { kind: "timeout", detail: failureReason(text), text };
  }
  const text = await bodyText(page);
  if (await page.locator("[data-testid='task-new-button'], [data-lexical-editor='true']").count()) {
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

function chromeArgs(headless) {
  const args = ["--disable-dev-shm-usage"];
  const sandbox = process.env.ZCODE_CHROME_NO_SANDBOX;
  if (sandbox === "1" || (headless && sandbox !== "0")) args.push("--no-sandbox");
  return args;
}

function cssAttr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
