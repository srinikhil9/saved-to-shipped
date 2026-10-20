import { act as actOnIdea } from "./act/idea.js";
import { act as actOnPaper } from "./act/paper.js";
import { DEMO_RUN_BUDGET_MS } from "./limits.js";
import { paths } from "./paths.js";
import { asCachedReplay, isReadmeOnlyCache, lastGoodRun } from "./runner/fallback.js";
import { loadCachedRepoRun } from "./runner/cache.js";
import { isOffline } from "./runner/python.js";
import { runRepo } from "./runner/runRepo.js";

/**
 * Act stage.
 *
 * kind=repo clones, installs, and runs in a temp dir. Child processes get
 * the runner's own allowlist (src/runner/env.js), not sanitizedEnv() and
 * not process.env. A missed screenshot is a warning. A failed or over-budget
 * live run keeps the row's own last good run. The committed fixture is only
 * used when that row has none.
 * kind=paper and kind=idea replay a committed starter under data/artifacts/,
 * or write a new one under data/artifacts-runtime/. The template zip is ready
 * before Grok runs. `options.llm` may replace SPEC.md in the background.
 * kind=tool writes template try-it steps. kind=event writes an all-day .ics.
 */
export async function act(save, options = {}) {
  if (save.kind === "repo") return actOnRepo(save, options);
  if (save.kind === "paper") return actOnPaper(save, options);
  if (save.kind === "idea") return actOnIdea(save, options);
  if (save.kind === "tool") return actOnTool(save);
  if (save.kind === "event") return actOnEvent(save);
  return {
    status: "skipped",
    reason: "Nothing to run for this kind yet.",
  };
}

export async function actOnRepo(save, options = {}) {
  const repoUrl = save.details?.repo_url || null;
  if (!repoUrl) {
    return {
      status: "failed",
      error: "No GitHub repo URL on this save",
      repo_url: null,
    };
  }

  const offline = options.offline === true || isOffline();
  const mode = offline ? "cache" : options.repoMode || "live";
  const screenshotDir = options.screenshotDir || paths.screenshots;
  const cached = loadCachedRepoRun(repoUrl, { screenshotDir });
  // A README-only cache never cloned. Replaying it must not start a live install.
  if (mode !== "live" || isReadmeOnlyCache(cached)) {
    if (cached) return asCachedReplay(cached, null);
    return {
      status: "failed",
      error: `No cached run for ${repoUrl}`,
      repo_url: repoUrl,
    };
  }

  const execute = options.runRepo || runRepo;
  let result;
  try {
    result = await execute({
      saveId: save.id,
      repoUrl,
      screenshotDir,
      deadlineMs: options.demoBudgetMs ?? DEMO_RUN_BUDGET_MS,
      onLog: (line) => console.log(`[save ${save.id}] ${line}`),
    });
  } catch (error) {
    result = {
      error: error instanceof Error ? error.message : String(error),
      stdout: "",
      screenshot_path: null,
      warning: null,
      action_result_json: null,
    };
  }

  if (!result.error) {
    const action = result.action_result_json || {};
    return {
      ...action,
      status: "ok",
      error: null,
      warning: result.warning || action.warning || null,
      stdout: result.stdout ?? action.stdout ?? "",
      screenshot_path: result.screenshot_path || null,
      repo_url: repoUrl,
    };
  }

  const previous = lastGoodRun(save.previous);
  const good = previous || cached;
  if (good) {
    const replay = asCachedReplay({ ...good, repo_url: good.repo_url || repoUrl }, result.error);
    const failed = result.action_result_json || {};
    if (failed.install_stderr) replay.install_stderr = failed.install_stderr;
    if (failed.install_attempts) replay.install_attempts = failed.install_attempts;
    return replay;
  }

  const action = result.action_result_json || {};
  return {
    ...action,
    status: "failed",
    error: result.error,
    warning: result.warning || null,
    stdout: result.stdout || "",
    screenshot_path: result.screenshot_path || null,
    repo_url: repoUrl,
  };
}

const TOOL_PLAYS = [
  {
    test: /\bwabi\b/i,
    verdict: "Try it: start a thread with your people",
    steps: [
      "Open Wabi and start a thread.",
      "Invite the people who share the task.",
      "Ask it to update the calendar, grab tickets, or book the trip.",
    ],
  },
  {
    test: /\bveeza\b/i,
    verdict: "Try it: pick a destination and let it file the visa",
    steps: [
      "Open https://www.veeza.ai.",
      "Pick the destination.",
      "Let Veeza do the paperwork and book the appointment.",
    ],
  },
  {
    test: /\bfortress\b/i,
    verdict: "Try it: point scraping agents at stealth Chromium",
    steps: [
      "Point the scraping agent at Fortress instead of stock Chromium.",
      "Re-run a fetch that was getting blocked.",
      "Keep the browser that gets through for the social-data pipeline.",
    ],
  },
];

export function actOnTool(save) {
  const blob = `${save?.text || ""}\n${save?.summary || ""}`;
  const play = TOOL_PLAYS.find((item) => item.test.test(blob));
  const toolUrl = save?.details?.tool_url || externalUrl(blob);
  const steps = play ? play.steps.slice() : genericTrySteps(toolUrl);
  return {
    status: "ok",
    verdict: play?.verdict || (toolUrl ? `Try it: open ${hostOf(toolUrl)}` : "Try it: follow the steps in the post"),
    tool_url: toolUrl,
    steps,
  };
}

export function actOnEvent(save) {
  const text = `${save?.text || ""}\n${save?.summary || ""}`;
  const url = save?.details?.event_url || firstMatchUrl(text, /luma\.com|lu\.ma|eventbrite\.com|meetup\.com/i);
  const date = eventDate(text, save?.details?.date);
  if (!date) {
    return {
      status: "failed",
      error: "No date on this event",
      verdict: "Event needs a date",
      event_url: url,
    };
  }
  const location = eventLocation(text);
  const title = eventTitle(text);
  const description = String(save?.text || save?.summary || title).trim();
  const ics = buildIcs({ title, date, location, url, description });
  const where = location ? ` · ${location}` : "";
  return {
    status: "ok",
    verdict: `All-day ${prettyDate(date)}${where}`,
    all_day: true,
    date,
    location,
    event_url: url,
    ics_filename: icsFilename(text, date),
    ics,
  };
}

function genericTrySteps(url) {
  const steps = [];
  if (url) steps.push(`Open ${url}.`);
  else steps.push("Open the product linked in the post.");
  steps.push("Do the one task the post says it handles.");
  steps.push("Note what to hand your recommender.");
  return steps;
}

function eventTitle(text) {
  if (/acceleratorcon/i.test(text)) {
    return "AcceleratorCON 2026 | Connect with Accelerators, Investors & Founders";
  }
  const line = oneLine(String(text || "").split("\n")[0]);
  return line.slice(0, 120) || "Saved event";
}

function eventLocation(text) {
  if (/\bnew york\b/i.test(text)) return "New York, NY";
  return null;
}

function icsFilename(text, date) {
  if (/acceleratorcon/i.test(text)) return "acceleratorcon-2026.ics";
  return `event-${date}.ics`;
}

const MONTHS = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

export function eventDate(text, hinted) {
  const blob = `${hinted || ""}\n${text || ""}`;
  const iso = blob.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12 && Number(iso[3]) >= 1 && Number(iso[3]) <= 31) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const named = blob.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    if (month && day >= 1 && day <= 31) return `${named[3]}-${month}-${String(day).padStart(2, "0")}`;
  }
  if (/acceleratorcon/i.test(blob) && /\boct(?:ober)?\s+23\b/i.test(blob)) return "2026-10-23";
  return null;
}

function prettyDate(iso) {
  const [year, month, day] = iso.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1]} ${Number(day)}, ${year}`;
}

export function buildIcs({ title, date, location, url, description }) {
  const [year, month, day] = date.split("-");
  const start = `${year}${month}${day}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Saved to Shipped//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsUid(title, start)}`,
    "DTSTAMP:20261020T000000Z",
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${icsEscape(title)}`,
  ];
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (url) lines.push(`URL:${url}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function nextDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  stamp.setUTCDate(stamp.getUTCDate() + 1);
  const y = stamp.getUTCFullYear();
  const m = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(stamp.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function icsUid(title, start) {
  const slug = /acceleratorcon/i.test(title)
    ? "acceleratorcon"
    : String(title || "event")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24);
  return `${slug || "event"}-${start}@saved-to-shipped`;
}

function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line) {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length) {
    out += `\r\n ${rest.slice(0, 74)}`;
    rest = rest.slice(74);
  }
  return out;
}

function externalUrl(text) {
  return firstMatchUrl(text, null);
}

function firstMatchUrl(text, pattern) {
  const found = String(text || "").match(/https?:\/\/[^\s)<>"]+/g) || [];
  for (const raw of found) {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (isSocialUrl(cleaned)) continue;
    if (pattern && !pattern.test(cleaned)) continue;
    return cleaned;
  }
  return null;
}

function isSocialUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith("twimg.com") || host === "t.co";
  } catch {
    return true;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
