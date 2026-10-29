import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Headed sign-in must be a normal Chrome. Playwright adds --enable-automation
// and a debugging port, and Google then refuses the account with
// "This browser or app may not be secure".
export function plainChromeArgs(profile, url) {
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
}

export function chromeLockTarget(profile) {
  try {
    return readlinkSync(join(profile, "SingletonLock"));
  } catch {
    return null;
  }
}

export async function waitForPlainChrome({
  chrome,
  args,
  profile,
  spawnImpl = spawn,
  sleep = delay,
  startTimeoutMs = 20_000,
}) {
  const before = chromeLockTarget(profile);
  const child = spawnImpl(chrome, args, { stdio: "ignore" });
  let exited = false;
  let exitCode = null;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", (code) => {
    exitCode = code;
    exited = true;
  });

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw coded("chrome-failed", spawnError.message);
    const target = chromeLockTarget(profile);
    if (target && target !== before) break;
    if (exited && target && target === before) break;
    if (exited && !target) {
      throw coded("chrome-failed", `Chrome exited (${exitCode ?? "unknown"}) before a window opened.`);
    }
    await sleep(200);
  }
  if (!chromeLockTarget(profile)) {
    throw coded("chrome-failed", "Chrome did not keep the profile open.");
  }
  while (chromeLockTarget(profile)) await sleep(500);
  await sleep(300);
  while (chromeLockTarget(profile)) await sleep(500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
