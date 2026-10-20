/**
 * Draft a spec with the shared Grok settings from src/env.js (llmSettings).
 * Same request shape as classifyWithGrok: reasoning_effort low, 8s, and one
 * retry without that field when the API rejects it with 400.
 * No key, a timeout, or any bad payload throws and the caller keeps the template.
 */

import { XAI_BASE_URL, llmSettings } from "../env.js";
import { LLM_TIMEOUT_MS } from "../limits.js";

export const XAI_CHAT_COMPLETIONS = `${XAI_BASE_URL}/chat/completions`;
export const SPEC_TIMEOUT_MS = LLM_TIMEOUT_MS;

export async function draftSpec({ llm, env, fetchImpl, profileName, save, fallbackSummary, timeoutMs }) {
  const settings = llm || llmSettings(env);
  if (!settings.apiKey) throw new Error("no XAI_API_KEY");
  const parsed = await requestSpec({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    fetchImpl,
    timeoutMs: timeoutMs ?? SPEC_TIMEOUT_MS,
    save,
    profileName,
  });
  const spec = typeof parsed.spec === "string" ? parsed.spec.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!spec.startsWith("#") || spec.length < 400 || spec.length > 8000) {
    throw new Error("LLM spec was empty or the wrong shape");
  }
  if (profileName && !spec.toLowerCase().includes(String(profileName).toLowerCase())) {
    throw new Error("LLM spec ignored the profile");
  }
  return {
    spec: `${spec}\n`,
    summary: clipSummary(summary || fallbackSummary),
  };
}

function specBody(model, save, profileName, reasoning) {
  const body = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Write a one-page SPEC.md that applies a saved social post to the user\'s startup. Reply with JSON only: {"spec":"markdown","summary":"one sentence"}. The spec is markdown, under 700 words, starts with a single # heading, and names the user. Apply the post to their scrape-and-recommend pipeline. Do not invent metrics, customers, or quotes.',
      },
      {
        role: "user",
        content: JSON.stringify({
          profile_name: profileName,
          kind: save.kind,
          url: save.url,
          post_summary: save.summary || "",
          post: excerpt(save.text, 2000),
          paper_url: save.details?.paper_url || null,
        }),
      },
    ],
  };
  if (reasoning) body.reasoning_effort = "low";
  return body;
}

async function requestSpec(options) {
  const first = await postSpec(options, true);
  if (first.status === 400) {
    const text = await first.text();
    if (/reasoning[_ ]?effort/i.test(text)) return readSpec(await postSpec(options, false));
    throw new Error("LLM returned 400");
  }
  return readSpec(first);
}

async function postSpec({ apiKey, baseUrl, model, fetchImpl, timeoutMs, save, profileName }, reasoning) {
  const timeout = referencedTimeout(timeoutMs ?? SPEC_TIMEOUT_MS);
  try {
    return await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(specBody(model, save, profileName, reasoning)),
      signal: timeout.signal,
    });
  } finally {
    timeout.cancel();
  }
}

function referencedTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
  };
}

async function readSpec(response) {
  if (!response.ok) throw new Error(`LLM returned ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  return JSON.parse(stripFence(content));
}

function excerpt(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function clipSummary(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 280) return clean;
  return `${clean.slice(0, 277).trimEnd()}…`;
}

function stripFence(value) {
  return String(value)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}
