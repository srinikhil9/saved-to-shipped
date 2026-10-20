import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { updateSave } from "./db.js";
import { paths } from "./paths.js";
import { loadProfile } from "./profile.js";

const CACHE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_MODEL = "grok-4.7";
const KINDS = new Set(["repo", "tool", "paper", "idea", "event", "other"]);

const KIND_SUBJECT = {
  repo: "This repo",
  tool: "This tool",
  paper: "This paper",
  idea: "This idea",
  event: "This event",
  other: "This save",
};

/**
 * Signals that count as an overlap only when the profile and the save
 * both show them. Labels are the words the fallback is allowed to use.
 */
const SIGNALS = [
  { label: "scraping", profile: [/\bscrap/i], save: [/\bscrap/i, /beautifulsoup/i, /crawler/i, /playwright/i] },
  { label: "social data", profile: [/social(?:\s+media|\s+data)?/i], save: [/social media/i, /social data/i, /\btweets?\b/i, /user signals/i] },
  { label: "recommendations", profile: [/recommend/i], save: [/recommend/i] },
  { label: "consumer products", profile: [/consumer products?/i, /\bproducts?\b/i], save: [/consumer products?/i, /\bproducts?\b/i] },
  { label: "YC", profile: [/\byc\b/i, /y combinator/i], save: [/\byc\b/i, /y combinator/i] },
  { label: "a16z", profile: [/a16z/i, /andreessen/i], save: [/a16z/i, /andreessen/i] },
  { label: "agents", profile: [/\bagents?\b/i], save: [/\bagents?\b/i, /agentic/i] },
  { label: "data pipelines", profile: [/data pipelines?/i, /\bpipelines?\b/i], save: [/data pipelines?/i, /\bpipelines?\b/i, /\bingest(?:ing|s|ed)?\b/i] },
  { label: "founders", profile: [/founders?/i], save: [/founders?/i] },
  { label: "user signals", profile: [/user signals/i], save: [/user signals/i, /\bsignals?\b/i] },
];

/**
 * One or two sentences on why this save matters to the profile.
 * Calls Grok on xAI's OpenAI-compatible endpoint only when XAI_API_KEY
 * is set. LLM_API_KEY is ignored. Any failure falls back to keywords.
 * Cached by save id + url + profile hash so a later run replays offline.
 */
export async function relate(save, profile, options = {}) {
  const normalized = normalizeProfile(profile ?? readProfile(options.profilePath));
  const env = options.env || process.env;
  const useCache = options.cache !== false;
  const cachePath = options.cachePath || paths.relateCache;
  const key = cacheKey(save, normalized);
  const hit = useCache ? cacheGet(cachePath, key) : null;
  const xai = xaiSettings(env);

  if (hit?.source === "llm" && hit.text) return hit.text;
  if (hit?.text && !xai) return hit.text;

  if (xai) {
    try {
      const text = await withTimeout(
        relateWithLlm(save, normalized, {
          ...xai,
          fetchImpl: options.fetchImpl || globalThis.fetch,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (text) {
        if (useCache) cacheSet(cachePath, key, { text, source: "llm" });
        return text;
      }
    } catch {
      // Silent fallback: a missing model, a timeout, or a bad body
      // still leaves a sentence on the card.
    }
  }

  if (hit?.text) return hit.text;
  const text = fallbackWhyYou(save, normalized);
  if (useCache) cacheSet(cachePath, key, { text, source: "fallback" });
  return text;
}

export function writeWhyYou(db, saveId, whyYou) {
  if (!db) throw new Error("writeWhyYou requires a database");
  if (saveId == null) throw new Error("writeWhyYou requires a save id");
  return updateSave(db, saveId, { why_you: whyYou });
}

export async function relateAndStore(db, save, profile, options = {}) {
  const whyYou = await relate(save, profile, options);
  return writeWhyYou(db, save.id, whyYou);
}

export function fallbackWhyYou(save, profile) {
  const normalized = normalizeProfile(profile ?? {});
  const text = saveText(save);
  const blob = profileBlob(normalized);
  const kind = KINDS.has(save?.kind) ? save.kind : "other";
  const ctx = { save: { ...save, kind }, text, blob, profile: normalized };
  const angle = pickAngle(ctx);
  if (angle) return clampSentences(angle);
  return clampSentences(renderFromOverlaps(ctx, overlaps(text, blob)));
}

/**
 * Stable cache key: save id, save url, and a hash of the normalized profile.
 * Interest order does not change the key.
 */
export function cacheKey(save, profile) {
  const normalized = normalizeProfile(profile ?? {});
  const ident = `${save?.id ?? ""}|${save?.url ?? ""}`;
  return `${ident}::${profileHash(normalized)}::v${CACHE_VERSION}`;
}

export function normalizeProfile(input) {
  let raw = unwrapProfile(input);
  const name =
    firstString(raw, ["name", "userName", "displayName"]) ||
    firstString(raw.user, ["name", "userName"]) ||
    "Srinikhil";
  const summary =
    firstString(raw, ["summary", "oneLiner", "one_liner", "bio", "description", "about"]) ||
    firstString(raw.user, ["bio", "description", "summary"]) ||
    "";
  const building = firstString(raw, ["building", "startup"]) || summary;
  const interests = unique(
    [raw.interests, raw.keywords, raw.tags, raw.topics, raw.focus].flatMap((value) => asList(value)),
  ).sort((a, b) => a.localeCompare(b));
  return { name, summary, building, interests };
}

function unwrapProfile(input) {
  if (input == null) return {};
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{")) {
      try {
        return unwrapProfile(JSON.parse(trimmed));
      } catch {
        return { summary: trimmed };
      }
    }
    return { summary: trimmed };
  }
  if (typeof input !== "object" || Array.isArray(input)) return {};
  if (input.profile && typeof input.profile === "object") {
    return { ...input.profile, ...input };
  }
  return input;
}

function readProfile(profilePath) {
  try {
    return loadProfile(profilePath);
  } catch {
    return {};
  }
}

function firstString(raw, keys) {
  if (!raw || typeof raw !== "object") return "";
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => asList(item));
  if (typeof value === "string") {
    return value
      .split(/[,|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = String(item || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function profileBlob(profile) {
  return [profile.name, profile.summary, profile.building, profile.interests.join("\n")].filter(Boolean).join("\n");
}

function profileHash(profile) {
  const payload = JSON.stringify({
    name: profile.name,
    summary: profile.summary,
    building: profile.building,
    interests: profile.interests,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function saveText(save) {
  return [save?.text, save?.summary, save?.url].filter(Boolean).join("\n");
}

function pickAngle(ctx) {
  const ranked = [
    {
      id: "scraping-pipeline",
      ok: isScrapingSave(ctx.text) && /\bscrap|pipeline|social media|social data/i.test(ctx.blob),
      kinds: new Set(["repo", "tool", "other"]),
      render: renderScraping,
    },
    {
      id: "agent-loops",
      ok: isAgentLoop(ctx.text) && /\bscrap|\bagents?\b|pipeline/i.test(ctx.blob),
      kinds: new Set(["paper", "idea", "other"]),
      render: renderLoop,
    },
    {
      id: "knowledge-base",
      ok: isKnowledgeSave(ctx.text) && /product|recommend|social|founder/i.test(ctx.blob),
      kinds: new Set(["idea", "paper", "tool", "other"]),
      render: renderKnowledge,
    },
  ];
  const matches = ranked.filter((angle) => angle.ok);
  if (!matches.length) return "";
  matches.sort((a, b) => {
    const aKind = a.kinds.has(ctx.save.kind) ? 1 : 0;
    const bKind = b.kinds.has(ctx.save.kind) ? 1 : 0;
    return bKind - aKind;
  });
  return matches[0].render(ctx);
}

function isScrapingSave(text) {
  return /\bscrapling\b/i.test(text) || /\bscrap(?:e|es|ing|er|ers)\b/i.test(text) || /beautifulsoup/i.test(text) || /web[-\s]?scrap/i.test(text);
}

function isAgentLoop(text) {
  if (/loop engineering/i.test(text)) return true;
  const loop = /\bloops?\b/i.test(text);
  const agent = /\bagents?\b|agentic/i.test(text);
  const system = /schedule|verify|discover|agentic|automation/i.test(text);
  return loop && agent && system;
}

function isKnowledgeSave(text) {
  if (/second brain/i.test(text)) return true;
  if (/karpathy/i.test(text) && /wiki|obsidian|vault/i.test(text)) return true;
  return /\bwiki\b/i.test(text) && /obsidian|vault/i.test(text);
}

function renderScraping(ctx) {
  const subject = extractSubject(ctx.save);
  const python = /\bpython\b|\bpip install\b|\bbeautifulsoup\b/i.test(ctx.text);
  const what = python ? "a Python web-scraping library" : "a web scraper";
  const where = scrapeTarget(ctx.blob);
  if (ctx.save.kind === "paper" || ctx.save.kind === "idea") {
    return `${subject} is about the scraping pipeline you already run. Use it to improve ${where}.`;
  }
  return `${subject} is a drop-in for the scraping pipeline. It is ${what} you can point at ${where}.`;
}

function scrapeTarget(blob) {
  const social = /social/i.test(blob);
  const products = /product/i.test(blob);
  const yc = /\byc\b|y combinator/i.test(blob);
  const a16z = /a16z|andreessen/i.test(blob);
  if (social && products && yc && a16z) {
    return "the same social sources this startup already mines to recommend niche consumer products from YC and a16z startups";
  }
  if (social && products) return "the same social sources this startup already mines for product recommendations";
  if (social) return "the social data this startup already collects";
  return "the data you already pull into the startup";
}

function renderLoop(ctx) {
  const subject = /loop engineering/i.test(ctx.text) ? "Loop Engineering" : extractSubject(ctx.save);
  const moves = ["schedule", "discover", "build", "verify", "repeat"].filter((word) => new RegExp(`\\b${word}`, "i").test(ctx.text));
  const lead =
    moves.length >= 3
      ? `${subject} is how you run this startup's agent and scrape loops: ${moves.join(", ")}.`
      : `${subject} is how you run this startup's agent and scrape loops.`;
  return `${lead} Saved to Shipped is itself one of those loops.`;
}

function renderKnowledge(ctx) {
  let subject = extractSubject(ctx.save);
  if (/karpathy/i.test(ctx.text) && /second brain/i.test(ctx.text)) subject = "Karpathy's second brain";
  else if (/second brain/i.test(ctx.text)) subject = "This second brain";
  const who = /\bstartup\b/i.test(ctx.blob) ? "this startup needs" : "you need";
  const scrapes = /\bscrap/i.test(ctx.blob);
  const compounds = /compound/i.test(ctx.text) && /blank chat/i.test(ctx.text);
  let second = "File products, founders, and user signals there.";
  if (scrapes && /recommend/i.test(ctx.blob) && compounds) {
    second = "File what you scrape, and recommendations compound instead of starting from a blank chat.";
  } else if (compounds) {
    second = "The more you feed it, the more it compounds.";
  }
  return `${subject} is the knowledge base of products, founders, and user signals ${who}. ${second}`;
}

function renderFromOverlaps(ctx, found) {
  const subject = extractSubject(ctx.save);
  const building = ctx.profile.building || ctx.profile.summary;
  if (!found.length) {
    if (building) return `${subject} is on your feed while you build ${building}.`;
    return `${subject} is saved for ${ctx.profile.name || "you"}.`;
  }
  const focus = listPhrase(found);
  const second = {
    repo: "Drop the repo into that part of the startup.",
    tool: "Try the tool on that work.",
    paper: "Read the paper against that work.",
    idea: "Apply the idea to that work.",
    event: "Put the event on the calendar.",
    other: "Keep it next to that work.",
  }[ctx.save.kind] || "Keep it next to that work.";
  const because = building ? ` That sits inside ${building}.` : "";
  return `${subject} matches your profile on ${focus}. ${second}${because}`;
}

function overlaps(text, blob) {
  const found = [];
  for (const signal of SIGNALS) {
    if (!signal.profile.some((pattern) => pattern.test(blob))) continue;
    if (!signal.save.some((pattern) => pattern.test(text))) continue;
    found.push(signal.label);
  }
  return found.slice(0, 3);
}

export function extractSubject(save) {
  const text = saveText(save);
  if (/\bscrapling\b/i.test(text)) return "Scrapling";
  if (/loop engineering/i.test(text)) return "Loop Engineering";
  if (/karpathy/i.test(text) && /second brain/i.test(text)) return "Karpathy's second brain";
  if (/second brain/i.test(text)) return "This second brain";
  const repo = text.match(/github\.com\/[\w.-]+\/([\w.-]+)/i);
  if (repo) {
    const name = repo[1].replace(/\.git$/, "");
    if (name && !/^(issues|pulls|pull|blob|tree|wiki)$/i.test(name)) return name;
  }
  const quoted = text.match(/"([^"]{3,60})"/);
  if (quoted) return quoted[1].trim();
  return KIND_SUBJECT[save?.kind] || "This save";
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function clampSentences(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

function xaiSettings(env) {
  const apiKey = env.XAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = String(env.XAI_BASE_URL || XAI_BASE_URL).replace(/\/$/, "");
  return {
    apiKey,
    url: `${baseUrl}/chat/completions`,
    model: env.XAI_MODEL || XAI_MODEL,
  };
}

async function relateWithLlm(save, profile, { apiKey, url, model, fetchImpl, timeoutMs }) {
  const body = {
    model,
    temperature: 0,
    max_completion_tokens: 180,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "Write one or two sentences on why this saved post matters to this person. Name the post and the concrete connection to their startup. No preamble, no bullets, no quotes.",
      },
      {
        role: "user",
        content: JSON.stringify({
          profile,
          kind: save?.kind || "other",
          author: save?.author || null,
          url: save?.url || null,
          summary: save?.summary || "",
          text: String(save?.text || "").slice(0, 4000),
        }),
      },
    ],
  };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`LLM returned ${response?.status || "error"}`);
  const payload = await response.json();
  const cleaned = cleanLlmText(payload?.choices?.[0]?.message?.content || "");
  if (!cleaned) throw new Error("empty relate response");
  return cleaned;
}

function cleanLlmText(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(why you\s*:\s*)/i, "");
  text = text.replace(/^["“”']+|["“”']+$/g, "");
  if (!text || text.length < 20 || text.length > 500) return "";
  return clampSentences(text);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("relate timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cacheGet(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = parsed?.entries?.[key];
    if (typeof value === "string" && value.trim()) return { text: value.trim(), source: "fallback" };
    if (value && typeof value.text === "string" && value.text.trim()) {
      return { text: value.text.trim(), source: value.source === "llm" ? "llm" : "fallback" };
    }
  } catch {
    return null;
  }
  return null;
}

function cacheSet(file, key, entry) {
  try {
    let entries = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.entries === "object" && parsed.entries) entries = parsed.entries;
    } catch {
      entries = {};
    }
    entries[key] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Cache is best-effort. The sentence is still returned.
  }
}
