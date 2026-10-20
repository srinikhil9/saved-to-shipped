import { llmSettings } from "./env.js";
import { LLM_TIMEOUT_MS } from "./limits.js";

const KINDS = new Set(["repo", "tool", "paper", "idea", "event", "other"]);
const RESERVED_GITHUB = new Set([
  "features",
  "topics",
  "settings",
  "marketplace",
  "orgs",
  "sponsors",
  "site",
  "about",
  "pricing",
  "explore",
  "collections",
  "events",
  "customer-stories",
  "readme",
]);

const PAPER_TEXT = /\b(\d+\s*-\s*page\s+pdf|arxiv)\b/i;
const IDEA_TEXT = /\b(idea|second brain|workflow|roadmap|how to|guide)\b/i;
const EVENT_TEXT = /\b(rsvp|webinar|conference|meetup|hackathon|join us)\b/i;
const TOOL_TEXT = /\b(tool|app|saas|sign up|try it|pip install|npm install)\b/i;
const DATE_RE =
  /\b(20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})\b/;

export async function classify(input, options = {}) {
  const heuristic = classifyHeuristic(input);
  const llmConfig = options.llm || llmSettings(options.env || process.env);
  if (!llmConfig.apiKey) return heuristic;
  const upgraded = await classifyWithGrok(input, heuristic, { ...options, llm: llmConfig });
  return upgraded || heuristic;
}

/**
 * One Grok call. Returns null when the key is missing or the call fails,
 * so the caller can keep the heuristic result.
 */
export async function classifyWithGrok(input, heuristic, options = {}) {
  const llmConfig = options.llm || llmSettings(options.env || process.env);
  if (!llmConfig.apiKey) return null;
  try {
    const llm = await requestGrok(input, {
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
      signalFactory: options.signalFactory,
    });
    if (!llm) return null;
    return {
      kind: llm.kind,
      summary: llm.summary || heuristic.summary,
      source: "llm",
      details: {
        repo_url: cleanUrl(llm.repo_url) || heuristic.details.repo_url,
        paper_url: cleanUrl(llm.paper_url) || heuristic.details.paper_url,
        tool_url: cleanUrl(llm.tool_url) || heuristic.details.tool_url,
        date: llm.date || heuristic.details.date,
      },
    };
  } catch {
    return null;
  }
}

export function classifyHeuristic(input) {
  const text = `${input.text || ""}\n${(input.links || []).map((link) => link.expanded || link.short || "").join("\n")}`;
  const urls = uniqueUrls(text);
  const repoUrl = urls.map(githubRepoUrl).find(Boolean) || null;
  const paperUrl = urls.find(isPaperUrl) || (PAPER_TEXT.test(text) ? urls.find(isDriveFile) : null) || null;
  const date = (text.match(DATE_RE) || [])[1] || null;
  const external = urls.filter((url) => !isSocial(url) && !githubRepoUrl(url) && !isPaperUrl(url));

  let kind = "other";
  if (repoUrl) kind = "repo";
  else if (paperUrl || PAPER_TEXT.test(text)) kind = "paper";
  else if (EVENT_TEXT.test(text) || external.some((url) => /luma\.com|eventbrite\.com|meetup\.com|lu\.ma/.test(url))) kind = "event";
  else if (TOOL_TEXT.test(text) || (external.length > 0 && /\b(tool|app)\b/i.test(text))) kind = "tool";
  else if (IDEA_TEXT.test(text)) kind = "idea";

  const toolUrl = kind === "tool" ? external[0] || null : null;
  return {
    kind,
    summary: summarize(input.text || text),
    source: "heuristic",
    details: {
      repo_url: repoUrl,
      paper_url: paperUrl,
      tool_url: toolUrl,
      date,
    },
  };
}

export function summarize(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const parts = clean.split(/(?<=[.!?])\s/);
  let summary = parts[0];
  if (summary.length < 80 && parts[1]) summary = `${summary} ${parts[1]}`;
  if (summary.length <= 200) return summary;
  return `${summary.slice(0, 197).trimEnd()}…`;
}

function grokBody(model, input, reasoning) {
  const body = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Classify a saved social post. Reply with JSON only: {kind, summary, repo_url, paper_url, tool_url, date}. kind is one of repo, tool, paper, idea, event, other. summary is one or two sentences. Use null for unknown URLs and date.",
      },
      {
        role: "user",
        content: JSON.stringify({
          text: input.text || "",
          links: (input.links || []).map((link) => link.expanded || link.short),
        }),
      },
    ],
  };
  // grok-4.7 accepts low | medium | high | xhigh. Default is high, which is
  // slow for a short classify. The chat schema's "only grok-4.3" note is stale.
  if (reasoning) body.reasoning_effort = "low";
  return body;
}

async function requestGrok(input, options) {
  const first = await postGrok(input, options, true);
  if (first.status === 400) {
    const text = await first.text();
    if (/reasoning[_ ]?effort/i.test(text)) return readGrok(await postGrok(input, options, false));
    throw new Error("LLM returned 400");
  }
  return readGrok(first);
}

async function postGrok(input, { apiKey, baseUrl, model, fetchImpl, timeoutMs, signalFactory }, reasoning) {
  const limit = timeoutMs ?? LLM_TIMEOUT_MS;
  const signal = signalFactory ? signalFactory(limit) : AbortSignal.timeout(limit);
  return fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(grokBody(model, input, reasoning)),
    signal,
  });
}

async function readGrok(response) {
  if (!response.ok) throw new Error(`LLM returned ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(stripFence(content));
  if (!KINDS.has(parsed.kind)) throw new Error("LLM returned an unknown kind");
  return parsed;
}

function stripFence(value) {
  return String(value).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
}

function uniqueUrls(text) {
  const found = text.match(/https?:\/\/[^\s)<>"]+/g) || [];
  const urls = [];
  const seen = new Set();
  for (const raw of found) {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function githubRepoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  if (RESERVED_GITHUB.has(owner.toLowerCase())) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}

function isPaperUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "arxiv.org") return true;
    return parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function isDriveFile(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase() === "drive.google.com" && parsed.pathname.includes("/file/");
  } catch {
    return false;
  }
}

function isSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "t.co" ||
      host === "x.com" ||
      host === "twitter.com" ||
      host.endsWith(".x.com") ||
      host.endsWith("twimg.com")
    );
  } catch {
    return false;
  }
}

function cleanUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
