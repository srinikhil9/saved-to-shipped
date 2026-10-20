import fs from "node:fs";
import { readBotProfile } from "./db.js";
import { paths } from "./paths.js";

const LIST_KEYS = new Set(["stack", "projects", "interests"]);

export function loadProfile(profilePath = paths.profile) {
  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
}

/**
 * Bot memory wins when a profile has been pushed. Otherwise why_you keeps
 * using the static file.
 */
export function resolveProfile(db) {
  const file = loadProfile();
  const stored = db ? readBotProfile(db) : null;
  if (!stored) return { profile: file, source: "default", synced_at: null };
  return {
    profile: effectiveProfile(file, stored.payload),
    source: "bot",
    synced_at: stored.synced_at,
  };
}

export function presentProfile(state) {
  return {
    source: state.source,
    synced_at: state.synced_at,
    ...state.profile,
  };
}

export function validateProfile(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Profile must be a JSON object" };
  }
  const profile = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "source" || key === "synced_at") continue;
    if (key === "why") {
      const why = validateWhy(value);
      if (why.error) return why;
      if (Object.keys(why.value).length) profile.why = why.value;
      continue;
    }
    if (LIST_KEYS.has(key)) {
      const list = validateStringOrList(value);
      if (list.error) return { error: `${key} must be a string or a list of strings` };
      profile[key] = list.value;
      continue;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text) profile[key] = text;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      profile[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      profile[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      profile[key] = value.map((item) => item.trim()).filter(Boolean);
      continue;
    }
    return { error: `${key} must be a string, number, boolean, or list of strings` };
  }
  if (!Object.keys(profile).length) return { error: "Profile needs at least one field" };
  return { profile };
}

/**
 * Pushed memory is stored beside the file profile. why_you slots stay the
 * file's short phrases unless the body sends `why` and that value is itself
 * a short phrase. Lists and sentences are kept on stack, startup, and
 * interests, and are not copied into the slots.
 */
export function effectiveProfile(file, pushed) {
  const why = { ...(file.why || {}) };
  for (const [key, value] of Object.entries(pushed.why || {})) {
    const phrase = cleanPhrase(value);
    if (phrase) why[key] = phrase;
  }
  return {
    ...file,
    ...pushed,
    name: textOf(pushed.name) || file.name,
    summary: textOf(pushed.summary) || file.summary,
    building: textOf(pushed.building) || file.building,
    why,
  };
}

export function cleanPhrase(value) {
  const text = textOf(value).replace(/\s+/g, " ");
  if (!text || text.length > 48) return "";
  if (/[.!?]/.test(text)) return "";
  if ((text.match(/,/g) || []).length >= 2) return "";
  return text;
}

function validateWhy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "why must be a JSON object" };
  }
  const why = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return { error: `why.${key} must be a string` };
    const text = item.trim();
    if (text) why[key] = text;
  }
  return { value: why };
}

function validateStringOrList(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { error: "empty" };
    return { value: text };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const items = value.map((item) => item.trim()).filter(Boolean);
    if (!items.length) return { error: "empty" };
    return { value: items };
  }
  return { error: "bad" };
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}
