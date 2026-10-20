import fs from "node:fs";
import path from "node:path";
import { expandPostLinks } from "./expand.js";
import { REQUEST_TIMEOUT_MS } from "./limits.js";
import { paths } from "./paths.js";
import { isTco, parseXStatusUrl } from "./xurl.js";

const UA = "SavedToShipped/0.1 (+https://github.com/srinikhil9/saved-to-shipped)";
export const READ_FAILED = "Couldn't read this post. Check the link or your connection.";

export function loadFixture(statusId, fixturesDir = paths.fixtures) {
  const file = path.join(fixturesDir, `${statusId}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizeFixture(raw);
}

export function listFixturePosts(fixturesDir = paths.fixtures) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadFixture(name.replace(/\.json$/, ""), fixturesDir))
    .filter(Boolean);
}

export function readCachedPost(statusId, cacheDir = paths.liveCache) {
  const file = path.join(cacheDir, `${statusId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeFixture(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeCachedPost(post, cacheDir = paths.liveCache) {
  if (!post?.id) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const body = {
    id: String(post.id),
    url: post.url,
    author: post.author || null,
    handle: post.handle || null,
    posted_at: post.posted_at || null,
    text: post.text || "",
    links: post.links || [],
    replies: post.replies || [],
    quote: post.quote || null,
    source: "live-cache",
  };
  fs.writeFileSync(path.join(cacheDir, `${post.id}.json`), JSON.stringify(body, null, 2));
}

/** A previous live read, or a committed seed fixture. */
export function readSavedPost(input, options = {}) {
  const parsed = parseXStatusUrl(typeof input === "string" ? input : input?.url);
  if (!parsed) return null;
  return readCachedPost(parsed.id, options.cacheDir) || loadFixture(parsed.id, options.fixturesDir);
}

/**
 * Fetch a public X post.
 * Live order (no API key): fxtwitter full text, then syndication, then oEmbed.
 * Author self-replies are included so "link in first comment" posts keep their URL.
 * A saved copy (live cache, then fixtures/) is used when the network fails.
 * skipSaved forces a live read so a background refresh can update that copy.
 */
export async function ingest(input, options = {}) {
  const parsed = parseXStatusUrl(input);
  if (!parsed) {
    throw new Error("Paste a public X post URL, like https://x.com/user/status/123");
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (options.offline) {
    const saved = readSavedPost(parsed.url, options);
    if (!saved) throw new Error(READ_FAILED);
    return expandPostLinks(saved, fetchImpl);
  }

  try {
    let live = await fetchLive(parsed, fetchImpl);
    const fixture = loadFixture(parsed.id, options.fixturesDir);
    if (fixture) live = mergeFixture(live, fixture);
    live = await expandPostLinks(live, fetchImpl);
    writeCachedPost(live, options.cacheDir);
    return live;
  } catch {
    if (options.skipSaved) throw new Error(READ_FAILED);
    const saved = readSavedPost(parsed.url, options);
    if (saved) return expandPostLinks(saved, fetchImpl);
    throw new Error(READ_FAILED);
  }
}

export function combinedText(post) {
  return [post?.text || "", post?.reply_text || ""].filter(Boolean).join("\n\n").trim();
}

async function fetchLive(parsed, fetchImpl) {
  let post = null;
  try {
    post = fromFx(await fetchJson(fetchImpl, `https://api.fxtwitter.com/status/${parsed.id}`));
  } catch {
    post = null;
  }
  if (!post?.text) {
    try {
      post = fromSyndication(await fetchJson(fetchImpl, `https://cdn.syndication.twimg.com/tweet-result?id=${parsed.id}&lang=en&token=x`), parsed);
    } catch {
      post = null;
    }
  }
  if (!post?.text) {
    try {
      post = fromOembed(await fetchJson(fetchImpl, `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(parsed.url)}`), parsed);
    } catch {
      post = null;
    }
  }
  if (!post?.text) throw new Error(READ_FAILED);
  post.handle = post.handle || parsed.handle;
  post.url = parsed.url;
  post.id = parsed.id;
  post.replies = await fetchAuthorReplies(parsed, post.handle, fetchImpl);
  return post;
}

async function fetchAuthorReplies(parsed, handle, fetchImpl) {
  let html = "";
  try {
    const response = await fetchImpl(parsed.url, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  }
  const ids = [...html.matchAll(/\/status\/(\d+)/g)]
    .map((match) => match[1])
    .filter((id, index, all) => id !== parsed.id && all.indexOf(id) === index)
    .slice(0, 3);
  const replies = [];
  for (const id of ids) {
    try {
      const tweet = fromFx(await fetchJson(fetchImpl, `https://api.fxtwitter.com/status/${id}`));
      const sameAuthor = tweet.handle && tweet.handle.toLowerCase() === String(handle || parsed.handle).toLowerCase();
      const repliesToThis = String(tweet.replying_to_status || "") === parsed.id;
      if (sameAuthor && repliesToThis) replies.push(tweet);
    } catch {
      // A reply id from the page shell is optional.
    }
  }
  return replies;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return response.json();
}

function fromFx(payload) {
  const tweet = payload?.tweet;
  if (!tweet?.text && !tweet?.raw_text?.text) return null;
  const text = tweet.text || tweet.raw_text?.text || "";
  return {
    id: String(tweet.id),
    url: tweet.url || null,
    author: tweet.author?.name || null,
    handle: tweet.author?.screen_name || null,
    posted_at: tweet.created_at || null,
    text: text.trim(),
    links: linksFromFacets(tweet.raw_text?.facets),
    replying_to_status: tweet.replying_to_status ? String(tweet.replying_to_status) : null,
    quote: tweet.quote?.article
      ? {
          title: tweet.quote.article.title || null,
          url: articleUrl(tweet.quote),
        }
      : null,
  };
}

function linksFromFacets(facets) {
  const links = [];
  for (const facet of facets || []) {
    if (!facet.original && !facet.replacement) continue;
    const short = isTco(facet.original || "") ? facet.original : null;
    const expanded = facet.replacement || facet.original;
    if (!expanded) continue;
    links.push({ short, expanded });
  }
  return links;
}

function articleUrl(quote) {
  const facet = (quote.raw_text?.facets || []).find((item) => item.replacement || item.original);
  return facet?.replacement || quote.url || null;
}

function fromSyndication(payload, parsed) {
  if (!payload?.text) return null;
  const links = [];
  for (const entity of payload.entities?.urls || []) {
    links.push({ short: entity.url || null, expanded: entity.expanded_url || entity.url });
  }
  for (const entity of payload.entities?.media || []) {
    links.push({ short: entity.url || null, expanded: entity.expanded_url || entity.media_url_https || entity.url });
  }
  if (payload.quoted_tweet?.entities?.urls) {
    for (const entity of payload.quoted_tweet.entities.urls) {
      links.push({ short: entity.url || null, expanded: entity.expanded_url || entity.url });
    }
  }
  return {
    id: parsed.id,
    url: parsed.url,
    author: payload.user?.name || null,
    handle: payload.user?.screen_name || parsed.handle,
    posted_at: payload.created_at || null,
    text: payload.text.trim(),
    links,
  };
}

function fromOembed(payload, parsed) {
  const html = payload?.html || "";
  const text = decodeHtml(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((match) => ({
    short: isTco(match[1]) ? match[1] : null,
    expanded: match[1],
  }));
  if (!text) return null;
  return {
    id: parsed.id,
    url: parsed.url,
    author: payload.author_name || null,
    handle: parsed.handle,
    posted_at: null,
    text,
    links,
  };
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&#x27;/g, "'");
}

function normalizeFixture(raw) {
  const replies = raw.replies || [];
  return {
    id: String(raw.id),
    url: raw.url,
    author: raw.author || null,
    handle: raw.handle || null,
    posted_at: raw.posted_at || null,
    text: raw.text || "",
    links: raw.links || [],
    replies,
    reply_text: replies.map((reply) => reply.text || "").filter(Boolean).join("\n\n"),
    quote: raw.quote || null,
    source: raw.source || "fixture",
  };
}

function mergeFixture(live, fixture) {
  const links = [...(live.links || [])];
  const seen = new Set(links.map((link) => link.expanded));
  const extras = [
    ...(fixture.links || []),
    ...(fixture.replies || []).flatMap((reply) => reply.links || []),
  ];
  for (const link of extras) {
    if (link.expanded && !seen.has(link.expanded)) {
      seen.add(link.expanded);
      links.push(link);
    }
  }
  const liveText = live.text || "";
  const fixtureText = fixture.text || "";
  return {
    ...live,
    author: live.author || fixture.author,
    handle: live.handle || fixture.handle,
    posted_at: live.posted_at || fixture.posted_at,
    text: fixtureText.length > liveText.length + 40 ? fixtureText : liveText,
    links,
    reply_text: live.reply_text || fixture.reply_text || "",
    replies: live.replies?.length ? live.replies : fixture.replies || [],
  };
}
