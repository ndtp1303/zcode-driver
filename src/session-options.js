import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Permission modes shown in the composer. `build` is "Ask before changes".
export const MODES = {
  build: { id: "build", en: "Ask before changes", zh: "变更前确认" },
  default: { id: "default", en: "Default", zh: "默认模式" },
  edit: { id: "edit", en: "Edit automatically", zh: "自动编辑" },
  plan: { id: "plan", en: "Plan mode", zh: "计划模式" },
  yolo: { id: "yolo", en: "Full access", zh: "完全访问" },
  guarded: { id: "guarded", en: "Autonomous mode", zh: "自主模式" },
};

const MODE_ALIASES = {
  ask: "build",
  "ask-before-changes": "build",
  "ask before changes": "build",
  "变更前确认": "build",
  default: "default",
  "默认": "default",
  "默认模式": "default",
  edit: "edit",
  "edit-automatically": "edit",
  "edit automatically": "edit",
  "自动编辑": "edit",
  plan: "plan",
  "plan-mode": "plan",
  "plan mode": "plan",
  "计划模式": "plan",
  yolo: "yolo",
  full: "yolo",
  "full-access": "yolo",
  "full access": "yolo",
  "完全访问": "yolo",
  guarded: "guarded",
  autonomous: "guarded",
  "autonomous-mode": "guarded",
  "自主模式": "guarded",
};

export function profileDir(env = process.env) {
  const raw = env.ZCODE_PROFILE?.trim() || env.ZCODE_USER_DATA_DIR?.trim();
  if (!raw) return join(homedir(), ".zcode-driver", "profile");
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw === "~" ? homedir() : raw;
  return resolve(expanded);
}

export function parseMode(input, { fallback = "build" } = {}) {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, mode: MODES[fallback] };
  const key = MODE_ALIASES[raw.toLowerCase()] || MODE_ALIASES[raw] || (MODES[raw] ? raw : null);
  if (!key || !MODES[key]) {
    return {
      ok: false,
      code: "bad-mode",
      message: `Unknown mode "${raw}". Use ask (Ask before changes), default, edit, plan, full, or autonomous.`,
    };
  }
  return { ok: true, mode: MODES[key] };
}

export function matchProject(names, query) {
  const wanted = String(query ?? "").trim();
  const unique = [...new Set(names.filter((name) => typeof name === "string" && name.trim()))];
  if (!wanted) return { ok: false, code: "project-not-found", names: unique };
  const exact = unique.filter((name) => name.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return { ok: true, name: exact[0] };
  if (exact.length > 1) return { ok: false, code: "ambiguous-project", names: exact };
  const partial = unique.filter((name) => name.toLowerCase().includes(wanted.toLowerCase()));
  if (partial.length === 1) return { ok: true, name: partial[0] };
  if (partial.length > 1) return { ok: false, code: "ambiguous-project", names: partial };
  return { ok: false, code: "project-not-found", names: unique };
}

export function modeAlreadySelected(triggerText, mode) {
  const text = String(triggerText ?? "").replace(/\s+/g, " ").trim();
  return text.includes(mode.en) || text.includes(mode.zh);
}
