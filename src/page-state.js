const LOGIN = /Sign In To Continue|登录后继续使用 Web 远程控制/;
const DISCONNECTED = /Device disconnected\.|设备未连接/;
const FAILURE = [
  "This device does not belong to this account",
  "该设备不属于当前账号",
  "Access Link Expired",
  "访问链接已失效",
  "Remote Control Ended",
  "本次远程控制已结束",
  "Taken Over By Another Device",
  "已被其他设备接管",
  "Workspace Closed",
  "当前工作区已关闭",
  "Desktop Offline",
  "桌面端已离线",
  "Mobile Connection Invalid",
  "Desktop Timed Out",
  "Connection Recovery Timed Out",
  "Relay Unavailable",
  "Action Not Supported",
  "Web Remote Control Failed",
  "Sign-In Failed",
  "登录失败",
  "Account mismatch",
  "账号不匹配",
];

export function classifyPageText(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (LOGIN.test(flat)) return "login";
  if (DISCONNECTED.test(flat)) return "disconnected";
  if (FAILURE.some((title) => flat.includes(title))) return "failure";
  return "unknown";
}

export function failureReason(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return FAILURE.find((title) => flat.includes(title)) ?? classifyPageText(flat);
}
