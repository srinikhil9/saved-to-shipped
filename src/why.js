import crypto from "node:crypto";
import { getSave, updateSave } from "./db.js";
import { llmSettings } from "./env.js";
import { cleanPhrase, loadProfile } from "./profile.js";

const KINDS = new Set(["repo", "tool", "paper", "idea", "event", "other"]);
const DEFAULT_TIMEOUT_MS = 8000;
const FOCUS = "your social-data recommender";

const DEFAULT_SLOTS = {
  pipeline: "social-data scraping pipeline",
  use: "pull user posts at scale for product recommendations",
  agents: "scrape-and-recommend agents",
  product: "Saved to Shipped",
  memory: "saved posts, founders, and YC/a16z products",
  wiki: "living wiki",
  reader: "recommender",
  focus: FOCUS,
};

const inflight = new Map();
const tickets = new WeakMap();

/**
 * One template line from data/profile.json.
 * Keyword hits are not tied to a single kind: Grok sorting may land on either.
 */
export function whyYou(save, profile = {}) {
  const kind = KINDS.has(save?.kind) ? save.kind : "other";
  const blob = `${save?.text || ""}\n${save?.summary || ""}`;
  // The three seed lines always use the file's short phrases, never a pushed list or sentence.
  const hit = keywordLine(kind, blob, seedSlots());
  if (hit) return hit;
  const slots = { ...seedSlots(), ...cleanWhy(profile.why) };
  return template(kind, slots.focus || FOCUS);
}

function seedSlots() {
  const slots = { ...DEFAULT_SLOTS };
  try {
    const file = loadProfile();
    for (const [key, value] of Object.entries(file?.why || {})) {
      if (typeof value === "string" && value.trim()) slots[key] = value.trim();
    }
  } catch {
    // DEFAULT_SLOTS already match the shipped profile.
  }
  return slots;
}

function cleanWhy(why) {
  if (!why || typeof why !== "object") return {};
  const clean = {};
  for (const [key, value] of Object.entries(why)) {
    const phrase = cleanPhrase(value);
    if (phrase) clean[key] = phrase;
  }
  return clean;
}

export function profileHash(profile = {}) {
  const payload = JSON.stringify({
    name: profile.name || "",
    summary: profile.summary || "",
    building: profile.building || "",
    why: profile.why || null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Profile hash plus kind and summary, so a re-sort does not reuse the old line. */
export function whyCacheKey(profile, save) {
  const sort = crypto.createHash("sha256").update(`${save?.kind || ""}|${save?.summary || ""}`).digest("hex").slice(0, 12);
  return `${profileHash(profile)}:${sort}`;
}

export function cachedWhyYou(row, profile, save = row) {
  if (!row?.why_you || row.why_you_source !== "grok") return null;
  if (row.why_you_profile_hash !== whyCacheKey(profile, save)) return null;
  return row.why_you;
}

/**
 * Rewrite template lines after a profile push or reset.
 * Grok-written lines stay as they are.
 */
export function retargetWhyYou(db, profile) {
  const rows = db.prepare("SELECT * FROM saves WHERE kind IS NOT NULL AND why_you_source IS NOT 'grok'").all();
  if (!rows.length) return 0;
  const update = db.prepare(
    `UPDATE saves
     SET why_you = @why_you, why_you_source = 'template', why_you_profile_hash = @hash
     WHERE id = @id AND why_you_source IS NOT 'grok'`,
  );
  let count = 0;
  const write = db.transaction((pending) => {
    for (const row of pending) {
      if (row.why_you_source === "grok") continue;
      const hash = whyCacheKey(profile, row);
      const line = whyYou(row, profile);
      if (row.why_you === line && row.why_you_source === "template" && row.why_you_profile_hash === hash) continue;
      update.run({ id: row.id, why_you: line, hash });
      count += 1;
    }
  });
  write(rows);
  return count;
}

export function backfillWhyYou(db, profile) {
  const rows = db
    .prepare("SELECT * FROM saves WHERE kind IS NOT NULL AND (why_you IS NULL OR why_you = '')")
    .all();
  if (!rows.length) return 0;
  const update = db.prepare(
    `UPDATE saves
     SET why_you = @why_you, why_you_source = 'template', why_you_profile_hash = @hash
     WHERE id = @id`,
  );
  const write = db.transaction((pending) => {
    for (const row of pending) {
      update.run({ id: row.id, why_you: whyYou(row, profile), hash: whyCacheKey(profile, row) });
    }
  });
  write(rows);
  return rows.length;
}

/**
 * Store the template immediately. When XAI_API_KEY is set and this save has
 * no Grok line for the current profile, replace it in the background.
 * Offline replays keep the cached Grok line and do not call.
 */
export function refreshWhyYou(db, id, save, profile, options = {}) {
  const hash = whyCacheKey(profile, save);
  const row = getSave(db, id);
  if (!row) return Promise.resolve(null);
  if (cachedWhyYou(row, profile, save)) return Promise.resolve(row);

  const settings = options.llm || llmSettings(options.env || {});
  if (!settings.apiKey) return Promise.resolve(row);
  if (options.offline && !options.whyFetch) return Promise.resolve(row);

  const flightKey = `${id}:${hash}`;
  const pending = inflight.get(flightKey);
  if (pending) return pending;
  const ticket = nextTicket(db, id);
  updateSave(db, id, { why_you_source: "pending" });

  const timeoutMs = options.whyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.whyFetch || options.llmFetch || globalThis.fetch;
  const job = withTimeout(
    grokWhyYou(save, profile, { ...settings, fetchImpl, timeoutMs }),
    timeoutMs,
  )
    .then((text) => {
      if (!ticketCurrent(db, id, ticket)) return getSave(db, id);
      const current = getSave(db, id);
      if (!current) return null;
      if (!text) {
        return updateSave(db, id, { why_you_source: "template" });
      }
      return updateSave(db, id, {
        why_you: text,
        why_you_source: "grok",
        why_you_profile_hash: hash,
      });
    })
    .catch(() => {
      if (!ticketCurrent(db, id, ticket)) return getSave(db, id);
      const current = getSave(db, id);
      if (current?.why_you_source === "pending") {
        return updateSave(db, id, { why_you_source: "template" });
      }
      return current;
    })
    .finally(() => {
      if (inflight.get(flightKey) === job) inflight.delete(flightKey);
    });
  inflight.set(flightKey, job);
  return job;
}

export function storeWhyLine(db, id, save, profile) {
  const hash = whyCacheKey(profile, save);
  const cached = cachedWhyYou(getSave(db, id), profile, save);
  return updateSave(db, id, {
    why_you: cached || whyYou(save, profile),
    why_you_source: cached ? "grok" : "template",
    why_you_profile_hash: hash,
  });
}

function keywordLine(kind, blob, slots) {
  if (/\bcua spaces\b|\bspaces sdk\b/i.test(blob)) {
    return `Cua Spaces is infra for the scraping agents that pull social data for your YC/a16z product ${slots.reader}.`;
  }
  if (/\bwabi\b/i.test(blob)) {
    return `Wabi is the kind of a16z consumer product your ${slots.reader} should surface to the right users.`;
  }
  if (/\bveeza\b/i.test(blob)) {
    return `Veeza is the kind of YC consumer product your ${slots.reader} should surface to the right users.`;
  }
  if (/acceleratorcon/i.test(blob)) {
    return "AcceleratorCON is where you meet the YC and a16z founders whose products feed your catalog.";
  }
  if (/\bfortress\b/i.test(blob)) {
    return "Fortress is stealth-browser infra so your scraping agents stop getting blocked.";
  }
  if ((kind === "repo" || kind === "tool") && /\bscrap/i.test(blob)) {
    return `Drop-in for your ${slots.pipeline}: use it to ${slots.use}.`;
  }
  if ((kind === "paper" || kind === "idea") && /\bloop\b/i.test(blob)) {
    return `A blueprint for running your ${slots.agents} as a self-verifying loop; ${slots.product} is one.`;
  }
  if ((kind === "idea" || kind === "paper" || kind === "other") && /second brain|karpathy|living wiki/i.test(blob)) {
    return `Turn your ${slots.memory} into a ${slots.wiki} your ${slots.reader} can draw on.`;
  }
  return null;
}

function template(kind, focus) {
  const phrase = shortPhrase(focus);
  if (kind === "repo") return `A repo to use while you build ${phrase}.`;
  if (kind === "tool") return `A tool to put in front of ${phrase}.`;
  if (kind === "paper") return `A paper to read against ${phrase}.`;
  if (kind === "idea") return `An idea to fold into ${phrase}.`;
  if (kind === "event") return `An event for people building ${phrase}.`;
  return `Worth keeping next to ${phrase}.`;
}

function shortPhrase(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 48) return FOCUS;
  return text;
}

async function grokWhyYou(save, profile, { apiKey, baseUrl, model, fetchImpl, timeoutMs }) {
  const url = `${String(baseUrl || "https://api.x.ai/v1").replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: model || "grok-4.7",
    temperature: 0,
    max_completion_tokens: 180,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "Write one or two sentences on why this saved post matters to this person. Name the concrete connection to their startup. No preamble, no bullets, no quotes.",
      },
      {
        role: "user",
        content: JSON.stringify({
          profile: {
            name: profile.name || "",
            summary: profile.summary || "",
            building: profile.building || "",
          },
          summary: save?.summary || "",
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
  if (!response?.ok) throw new Error(`Grok returned ${response?.status || "error"}`);
  const payload = await response.json();
  const cleaned = cleanGrokText(payload?.choices?.[0]?.message?.content || "");
  if (!cleaned) throw new Error("empty why_you");
  return cleaned;
}

function cleanGrokText(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(why you\s*:\s*)/i, "");
  text = text.replace(/^["“”']+|["“”']+$/g, "");
  if (!text || text.length < 20 || text.length > 500) return "";
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

function nextTicket(db, id) {
  let byId = tickets.get(db);
  if (!byId) {
    byId = new Map();
    tickets.set(db, byId);
  }
  const next = (byId.get(id) || 0) + 1;
  byId.set(id, next);
  return next;
}

function ticketCurrent(db, id, ticket) {
  return tickets.get(db)?.get(id) === ticket;
}

function withTimeout(promise, ms) {
  let timer;
  promise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("why_you timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
