import { isHttpUrl, isTco } from "./xurl.js";

const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g;
const UA = "SavedToShipped/0.1 (+https://github.com/srinikhil9/saved-to-shipped)";

export async function expandTcoUrl(shortUrl, fetchImpl = globalThis.fetch) {
  if (!isTco(shortUrl)) return shortUrl;
  const response = await fetchImpl(shortUrl, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(12000),
  });
  const finalUrl = response?.url;
  if (finalUrl && isHttpUrl(finalUrl) && !isTco(finalUrl) && !isBlockedHost(finalUrl)) return finalUrl;
  return shortUrl;
}

function isBlockedHost(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export async function expandPostLinks(post, fetchImpl = globalThis.fetch) {
  const chunks = [post.text || "", post.reply_text || ""];
  for (const reply of post.replies || []) chunks.push(reply.text || "");
  const shorts = new Set();
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(TCO_RE)) shorts.add(match[0]);
  }
  for (const link of allLinks(post)) {
    if (link.short && isTco(link.short)) shorts.add(link.short);
  }

  const resolved = new Map();
  for (const short of shorts) {
    const known = allLinks(post).find((link) => link.short === short && link.expanded && !isTco(link.expanded));
    if (known) {
      resolved.set(short, known.expanded);
      continue;
    }
    try {
      resolved.set(short, await expandTcoUrl(short, fetchImpl));
    } catch {
      resolved.set(short, short);
    }
  }

  const text = replaceShorts(post.text || "", resolved);
  const replies = (post.replies || []).map((reply) => ({
    ...reply,
    text: replaceShorts(reply.text || "", resolved),
  }));
  const reply_text = replaceShorts(post.reply_text || replies.map((reply) => reply.text).filter(Boolean).join("\n\n"), resolved);

  const links = [];
  const seen = new Set();
  const push = (link) => {
    const expanded = link.expanded && !isTco(link.expanded) ? link.expanded : resolved.get(link.short) || link.expanded || link.short;
    if (!expanded || !isHttpUrl(expanded) || seen.has(expanded)) return;
    seen.add(expanded);
    links.push({ short: link.short || null, expanded });
  };
  for (const [short, expanded] of resolved) push({ short, expanded });
  for (const link of allLinks(post)) push(link);

  return { ...post, text, replies, reply_text, links };
}

function allLinks(post) {
  return [...(post.links || []), ...(post.replies || []).flatMap((reply) => reply.links || [])];
}

function replaceShorts(text, resolved) {
  let next = text;
  for (const [short, expanded] of resolved) {
    if (expanded && expanded !== short) next = next.split(short).join(expanded);
  }
  return next;
}
