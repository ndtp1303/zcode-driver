// Parse a ZCode Web remote-control link. The 3.16.3 page treats hash/t as a
// v1 link and refuses it. sid/mid/name/app_version are the v2 query fields.

export function parseRemoteUrl(input, { requireSid = true } = {}) {
  if (!input || !String(input).trim()) {
    return fail("missing-url", "ZCODE_REMOTE_URL is not set");
  }
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return fail("invalid-url", "Remote link is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("invalid-url", "Remote link must be http(s)");
  }
  const params = url.searchParams;
  if (params.has("hash") || params.has("t")) {
    return fail(
      "v1-link",
      "This link still has v1 hash/t parameters. The 3.16.3 remote page only accepts sid and mid.",
    );
  }
  const deviceSid = params.get("sid")?.trim() ?? "";
  const deviceMid = params.get("mid")?.trim() ?? "";
  const deviceName = params.get("name")?.trim() ?? "";
  const appVersion = params.get("app_version")?.trim() ?? "";
  if (requireSid && !deviceSid) {
    return fail("missing-sid", "Remote link has no sid");
  }
  return {
    ok: true,
    origin: url.origin,
    deviceSid,
    deviceMid,
    deviceName,
    appVersion,
    pageUrl: url.toString(),
  };
}

function fail(code, message) {
  return { ok: false, code, message };
}

export function relayWsUrl(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/remote/ws2";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function describeLink(link) {
  return {
    origin: link.origin,
    hasSid: Boolean(link.deviceSid),
    hasMid: Boolean(link.deviceMid),
    appVersion: link.appVersion || null,
    deviceName: link.deviceName || null,
  };
}
