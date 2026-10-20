const STATUS_RE =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?(?:\?.*)?$/i;

export function parseXStatusUrl(input) {
  if (typeof input !== "string") return null;
  const url = input.trim();
  const match = STATUS_RE.exec(url);
  if (!match) return null;
  return {
    url: `https://x.com/${match[1]}/status/${match[2]}`,
    handle: match[1],
    id: match[2],
  };
}

export function isTco(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return host === "t.co";
  } catch {
    return false;
  }
}

export function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
