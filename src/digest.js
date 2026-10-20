import { isReadmeOnlyCache } from "./runner/fallback.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_N = 2;

const STOP = new Set(
  `a an the and or to of for in on your you with from that this into its their than then just over about after before they them have has was were are is be as at by it if not but can will our my we when while what which who how all any more most other some such only also one two next still keep worth people using used use out too very much many each every because through across again never always here there thing things something anything been being had`.split(
    /\s+/,
  ),
);

export function parseSince(value, now = new Date()) {
  if (value == null || value === "") return new Date(now.getTime() - WEEK_MS);
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function buildDigest(rows, profile = {}, options = {}) {
  const since = options.since instanceof Date ? options.since : parseSince(options.since, options.now || new Date());
  if (!since) throw new Error("since must be an ISO timestamp");
  const picked = (rows || []).filter((row) => inWindow(row, since));
  const saved = picked.length;
  const tried = picked.filter((row) => actReallyRan(actOf(row), row)).length;
  const top = picked
    .map((row) => ({
      id: row.id,
      url: row.url,
      title: titleOf(row),
      kind: row.kind || null,
      why_you: row.why_you || "",
      action: actionLine(actOf(row), options.baseUrl, row),
      score: scoreSave(row, profile),
      created_at: row.created_at || "",
    }))
    .sort(byRank)
    .slice(0, TOP_N)
    .map(({ created_at, ...item }) => item);
  return {
    saved,
    tried,
    since: since.toISOString(),
    top,
    markdown: renderMarkdown({ saved, tried, top }),
  };
}

export function hasActResult(row) {
  return actReallyRan(actOf(row), row);
}

/** A skipped stub, a tool, an event, a README-only cache, or a save with no act payload did not run. */
export function actReallyRan(act, row = null) {
  if (!act || typeof act !== "object" || Array.isArray(act)) return false;
  if (row?.kind === "tool" || row?.kind === "event") return false;
  if (act.status === "skipped") return false;
  if (isReadmeOnlyCache(act)) return false;
  if (hasTrySteps(act) || hasCalendar(act)) return false;
  if (act.zipUrl || act.type === "spec" || act.type === "starter") return true;
  if (act.status === "ok" || act.status === "cached" || act.status === "done" || act.status === "failed") return true;
  if (act.exit_code != null || act.stdout || act.duration_ms != null || act.run_duration_ms != null) return true;
  return false;
}

export function actionLine(act, baseUrl = "", row = null) {
  if (act && isReadmeOnlyCache(act)) return "README cached";
  if (hasCalendar(act)) return ".ics added";
  if (hasTrySteps(act)) return "try-it steps";
  if (row?.kind === "tool" || row?.kind === "event") return "not tried yet";
  if (!actReallyRan(act, row)) return "not tried yet";
  if (typeof act.zipUrl === "string" && act.zipUrl) return `spec zip ${absoluteUrl(act.zipUrl, baseUrl)}`;
  const ms = numberOrNull(act.duration_ms) ?? numberOrNull(act.run_duration_ms);
  const failed =
    act.status === "failed" || (act.exit_code != null && Number(act.exit_code) !== 0 && act.status !== "cached");
  const repoLike = Boolean(
    act.repo || act.repo_url || act.language || ms != null || act.status === "cached" || act.status === "ok" || act.status === "failed",
  );
  if (repoLike) {
    if (failed) return "repo run failed";
    if (ms != null && ms >= 0) return `repo run ok in ${formatSeconds(ms)}`;
    if (act.status === "ok" || act.status === "cached") return "repo run ok";
  }
  if (typeof act.summary === "string" && act.summary.trim()) return act.summary.replace(/\s+/g, " ").trim();
  if (act.status) return `act ${act.status}`;
  return "act result recorded";
}

/** Deterministic keyword overlap with the active profile. No model call. */
export function scoreSave(row, profile = {}) {
  const keywords = profileKeywords(profile);
  const phrases = profilePhrases(profile);
  const blob = `${row?.text || ""} ${row?.summary || ""} ${row?.why_you || ""} ${row?.kind || ""}`.toLowerCase();
  const tokens = new Set(blob.match(/[a-z0-9][a-z0-9+.#-]*/g) || []);
  let score = 0;
  for (const word of keywords) {
    if (tokens.has(word)) {
      score += 2;
      continue;
    }
    if (word.length >= 5) {
      const stem = word.slice(0, 5);
      for (const token of tokens) {
        if (token.startsWith(stem)) {
          score += 1;
          break;
        }
      }
    }
  }
  for (const phrase of phrases) {
    if (phrase.length >= 8 && blob.includes(phrase)) score += 4;
  }
  return score;
}

function profileKeywords(profile = {}) {
  const words = new Set();
  for (const chunk of profileChunks(profile)) {
    for (const token of tokenize(chunk)) {
      if (token.length < 4 || STOP.has(token)) continue;
      words.add(token);
    }
  }
  return [...words];
}

function profilePhrases(profile = {}) {
  const phrases = new Set();
  for (const chunk of profileChunks(profile)) {
    const text = String(chunk || "")
      .toLowerCase()
      .replace(/[^a-z0-9+.#\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text.includes(" ")) continue;
    const parts = text.split(" ").filter((part) => part && !STOP.has(part));
    if (parts.length >= 2) phrases.add(parts.join(" "));
  }
  return [...phrases];
}

function profileChunks(profile = {}) {
  const chunks = [
    profile.summary,
    profile.building,
    profile.startup,
    profile.name,
    ...listValues(profile.stack),
    ...listValues(profile.projects),
    ...listValues(profile.interests),
    ...Object.values(profile.why || {}),
  ];
  return chunks.filter((chunk) => typeof chunk === "string" && chunk.trim());
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

function tokenize(value) {
  return (
    String(value || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+.#-]*/g) || []
  );
}

function renderMarkdown({ saved, tried, top }) {
  const lines = [`You saved ${saved}, I tried ${tried}, here are the ${top.length} worth your time`, ""];
  for (const item of top) {
    lines.push(`${item.title} · ${item.kind || "unsorted"}`);
    if (item.why_you) lines.push(item.why_you);
    lines.push(item.action);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function byRank(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return (right.id || 0) - (left.id || 0);
}

function inWindow(row, since) {
  const created = new Date(row?.created_at || "");
  if (Number.isNaN(created.getTime())) return false;
  return created.getTime() >= since.getTime();
}

function titleOf(row) {
  if (row.author) return row.author;
  if (row.summary) return String(row.summary).split("\n")[0].slice(0, 80);
  return row.url || `Save ${row.id}`;
}

function hasTrySteps(act) {
  return Array.isArray(act?.steps) && act.steps.length > 0;
}

function hasCalendar(act) {
  return typeof act?.ics === "string" && act.ics.length > 0;
}

function actOf(row) {
  const raw = row?.action_result_json;
  if (!raw) return null;
  if (typeof raw === "object") return raw.act || null;
  try {
    return JSON.parse(raw)?.act || null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function absoluteUrl(value, baseUrl) {
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (!base) return value;
  return `${base}${value.startsWith("/") ? value : `/${value}`}`;
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  const rounded = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
  return `${rounded}s`;
}
