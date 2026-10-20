/**
 * Draft a spec with the shared Grok settings from src/env.js (llmSettings).
 * No key, a timeout, or any bad payload throws and the caller keeps the template.
 */

import { XAI_BASE_URL, llmSettings } from "../env.js";

export const XAI_CHAT_COMPLETIONS = `${XAI_BASE_URL}/chat/completions`;
const TIMEOUT_MS = 12000;

export async function draftSpec({ llm, env, fetchImpl, profileName, save, fallbackSummary }) {
  const settings = llm || llmSettings(env);
  if (!settings.apiKey) throw new Error("no XAI_API_KEY");
  const response = await fetchImpl(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
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
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LLM returned ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(stripFence(content));
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
