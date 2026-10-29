// The remote page will not open a socket until localStorage looks signed in.
// The relay then checks the JWT. See docs/zcode-remote-protocol.md.

const PROVIDERS = new Set(["zai", "bigmodel"]);

export function readCredentials(env = process.env) {
  const jwt = env.ZCODE_JWT?.trim() ?? "";
  if (!jwt) return { ok: false, code: "auth-required", message: "ZCODE_JWT is not set" };
  const provider = (env.ZCODE_PROVIDER?.trim() || "zai").toLowerCase();
  if (!PROVIDERS.has(provider)) {
    return { ok: false, code: "bad-provider", message: "ZCODE_PROVIDER must be zai or bigmodel" };
  }
  const expiry = jwtExpiry(jwt);
  if (expiry.kind === "expired") {
    return { ok: false, code: "jwt-expired", message: "ZCODE_JWT is expired", expiresAt: expiry.expiresAt };
  }
  let userInfo = env.ZCODE_USER_INFO?.trim() ?? "";
  if (!userInfo) {
    userInfo = JSON.stringify({
      id: "zcode-driver",
      username: "zcode-driver",
      displayName: "zcode-driver",
    });
  } else {
    try {
      const parsed = JSON.parse(userInfo);
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.username !== "string" || typeof parsed.displayName !== "string") {
        return {
          ok: false,
          code: "bad-user-info",
          message: "ZCODE_USER_INFO must be JSON with id, username, and displayName",
        };
      }
    } catch {
      return { ok: false, code: "bad-user-info", message: "ZCODE_USER_INFO is not JSON" };
    }
  }
  const accessToken = env.ZCODE_ACCESS_TOKEN?.trim() || "zcode-driver-placeholder";
  const accessKey = provider === "bigmodel" ? "oauth:bigmodel:access_token" : "oauth:zai:access_token";
  const userKey = provider === "bigmodel" ? "oauth:bigmodel:user_info" : "oauth:zai:user_info";
  return {
    ok: true,
    jwt,
    provider,
    accessToken,
    userInfo,
    accessKey,
    userKey,
    expiry,
  };
}

// Same check the page uses: base64url payload exp, 30s skew, no signature check.
export function jwtExpiry(token, now = Date.now(), skewMs = 30_000) {
  try {
    const part = token.split(".")[1];
    if (!part) return { kind: "unknown" };
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return { kind: "unknown" };
    }
    const expiresAt = payload.exp * 1000;
    if (now + Math.max(0, skewMs) >= expiresAt) return { kind: "expired", expiresAt };
    return { kind: "valid", expiresAt };
  } catch {
    return { kind: "unknown" };
  }
}
