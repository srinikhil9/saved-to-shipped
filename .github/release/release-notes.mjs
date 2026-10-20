#!/usr/bin/env node
/**
 * Release bot. Collects pull requests and writes plain-English notes.
 *
 *   node .github/release/release-notes.mjs --dry-run
 *   node .github/release/release-notes.mjs --dry-run --example
 *   node .github/release/release-notes.mjs --self-check
 *   npm run release-notes --prefix .github/release -- --dry-run
 *
 * On a v* tag in GitHub Actions: prepend CHANGELOG.md, commit it to main,
 * and publish the Release for that tag.
 * On a push to main (no tag): do not commit. Write the job summary and
 * update the rolling draft Release named "latest".
 * Local runs print the notes and do not publish.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const changelogPath = join(root, "CHANGELOG.md");
const teamPath = join(root, ".github", "bot-team.json");

const CHANGELOG_INTRO = `# Changelog

The release bot writes this file. Pushing a version tag (v*) adds a section here and publishes a GitHub Release. A push to main does not change this file. It updates the draft Release named latest and the Actions job summary.
`;

const BOT_ORDER = ["builder", "builder 2", "builder 3"];

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const forcedDry = flags.has("--dry-run") || process.env.RELEASE_NOTES_DRY_RUN === "true";
  return {
    selfCheck: flags.has("--self-check"),
    example: flags.has("--example"),
    writeChangelog: flags.has("--write-changelog"),
    dryRun: forcedDry || (!inActions && !flags.has("--publish")),
    publish: flags.has("--publish") || (inActions && !forcedDry),
  };
}

function redact(value) {
  return String(value).replace(/\/\/[^/\s@]+@/g, "//");
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const match = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot read the GitHub repo from origin (${redact(url)}).`);
  return match[1];
}

let cachedToken;

function token() {
  if (cachedToken) return cachedToken;
  if (process.env.GITHUB_TOKEN) cachedToken = process.env.GITHUB_TOKEN;
  else if (process.env.GH_TOKEN) cachedToken = process.env.GH_TOKEN;
  else {
    try {
      cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("No GitHub token. Set GITHUB_TOKEN or log in with gh.");
    }
  }
  return cachedToken;
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function gh(path, { method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "User-Agent": "saved-to-shipped-release-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    const error = new Error(`GitHub ${response.status} ${method} ${redact(path)}: ${detail.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return { data, next: nextLink(response.headers.get("link")) };
}

async function ghList(path) {
  const items = [];
  let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const page = await gh(url);
    if (!Array.isArray(page.data)) {
      throw new Error(`Expected a list from ${redact(path)}.`);
    }
    items.push(...page.data);
    url = page.next;
  }
  return items;
}

function loadTeam() {
  if (!existsSync(teamPath)) return { prs: {}, branchPrefixes: [] };
  return JSON.parse(readFileSync(teamPath, "utf8"));
}

function normalizeBot(name) {
  const compact = String(name).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (compact === "builder 2" || compact === "builder2") return "builder 2";
  if (compact === "builder 3" || compact === "builder3") return "builder 3";
  if (compact === "builder" || compact === "thinker" || compact === "tracker") return compact;
  return String(name).trim();
}

function botFromLabels(labels) {
  const found = [];
  for (const label of labels || []) {
    const raw = typeof label === "string" ? label : label.name || "";
    const bot = normalizeBot(raw.replace(/^bot:\s*/i, ""));
    if (BOT_ORDER.includes(bot)) found.push(bot);
  }
  found.sort((a, b) => b.length - a.length);
  return found[0] || null;
}

function botFromBody(body) {
  const lines = String(body || "").split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const match = line.match(/^\s*bot:\s*(.+?)\s*$/i);
    if (match) return normalizeBot(match[1]);
  }
  const builtBy = lines.join("\n").match(/built by (builder\s*3|builder\s*2|builder\b)/i);
  return builtBy ? normalizeBot(builtBy[1]) : null;
}

function botFromMap(pull, team) {
  const byNumber = team.prs && team.prs[String(pull.number)];
  if (byNumber) return normalizeBot(byNumber);
  const branch = pull.head?.ref || "";
  const hit = (team.branchPrefixes || [])
    .filter((entry) => branch.startsWith(entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return hit ? normalizeBot(hit.bot) : null;
}

function assignBot(pull, team) {
  return botFromLabels(pull.labels) || botFromBody(pull.body) || botFromMap(pull, team) || null;
}

function splitSentences(text) {
  const sentences = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if (!/[.!?]/.test(text[i])) continue;
    const next = text[i + 1];
    if (next === undefined || /\s/.test(next)) {
      const sentence = current.trim();
      if (sentence) sentences.push(sentence);
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function skipSentence(sentence) {
  return (
    /^step \d+\b/i.test(sentence) ||
    /^do not merge\b/i.test(sentence) ||
    /^rebased\b/i.test(sentence) ||
    /^this (pr|pull request) is not merged\b/i.test(sentence) ||
    /^not merged\b/i.test(sentence) ||
    /^addressed the review\b/i.test(sentence) ||
    /^fixed on this branch\b/i.test(sentence) ||
    /^follow-up\b/i.test(sentence) ||
    /^#{1,6}\s/.test(sentence)
  );
}

function finishSentence(sentence) {
  const trimmed = sentence.length > 280 ? `${sentence.slice(0, 277).trim()}...` : sentence;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function whatItDoes(pull) {
  const cleaned = String(pull.body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}[ \t]+.*$/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\r/g, "");
  for (const paragraph of cleaned.split(/\n\s*\n/)) {
    const usable = splitSentences(paragraph.replace(/\s+/g, " ").trim()).filter((sentence) => !skipSentence(sentence));
    if (!usable.length) continue;
    const picked = usable.sort((a, b) => b.length - a.length)[0];
    return finishSentence(picked);
  }
  return finishSentence(pull.title);
}

function trackerNote(body) {
  const line = String(body || "").trim().split(/\r?\n/, 1)[0] || "";
  const match = line.match(/^tracker (re-review|review)(?:\s*\([^)]*\))?\s*:\s*([\s\S]*)$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase() === "re-review" ? "re-review" : "review";
  const raw = match[2].trim();
  const bold = raw.match(/^\*\*([^*]+)\*\*/);
  let verdict = (bold ? bold[1] : raw.split(/(?<=\.)\s/)[0]).replace(/\*\*/g, "").trim();
  verdict = verdict.replace(/[.]+$/, "").trim();
  if (verdict.length > 80) {
    const cut = verdict.slice(0, 77);
    const space = cut.lastIndexOf(" ");
    verdict = `${(space > 40 ? cut.slice(0, space) : cut).trim()}...`;
  }
  return verdict ? { kind, verdict } : null;
}

function formatTracker(notes) {
  if (!notes.length) return "no comment starting with \"tracker review:\"";
  return notes
    .map((note) => (note.kind === "re-review" ? `re-review: ${note.verdict}` : note.verdict))
    .join("; ");
}

function compareBots(a, b) {
  const rank = (bot) => {
    if (bot === "unmapped") return BOT_ORDER.length + 1;
    const index = BOT_ORDER.indexOf(bot);
    return index === -1 ? BOT_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

function joinAnd(parts) {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function listNumbers(numbers) {
  return joinAnd(numbers.map((number) => `#${number}`));
}

function renderNotes({ title, intro, pulls }) {
  const lines = [`## ${title}`, "", intro, "", "### Changes", ""];
  if (!pulls.length) {
    lines.push("No pull requests in this range.");
  } else {
    for (const pull of pulls) {
      lines.push(`- [#${pull.number} ${pull.title}](${pull.html_url}) — ${whatItDoes(pull)}`);
    }
  }
  lines.push("", "### Bot team", "", "- **thinker** wrote the spec.");
  const grouped = new Map();
  for (const pull of pulls) {
    const bot = pull.bot || "unmapped";
    if (!grouped.has(bot)) grouped.set(bot, []);
    grouped.get(bot).push(pull);
  }
  if (!pulls.length) {
    lines.push("- No feature pull requests in this range, so no builder credit yet.");
    lines.push("- **tracker** has no pull request to review in this range.");
  } else {
    for (const bot of [...grouped.keys()].sort(compareBots)) {
      const described = joinAnd(grouped.get(bot).map((pull) => `#${pull.number} ${pull.title}`));
      if (bot === "unmapped") {
        lines.push(`- **unmapped** — ${described} (no bot label, Bot: line, or mapping entry).`);
      } else {
        lines.push(`- **${bot}** built ${described}.`);
      }
    }
    for (const pull of pulls) {
      lines.push(`- **tracker** reviewed #${pull.number}: ${formatTracker(pull.tracker)}.`);
    }
  }
  lines.push("", `_Release bot, ${new Date().toISOString().slice(0, 10)}._`, "");
  return lines.join("\n");
}

function upsertSection(fileText, section) {
  const heading = section.split("\n", 1)[0].trim();
  const text = fileText && fileText.trim() ? fileText : CHANGELOG_INTRO;
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  const block = section.trim();
  if (start === -1) {
    const first = lines.findIndex((line) => line.startsWith("## "));
    if (first === -1) return `${normalized.trim()}\n\n${block}\n`;
    const before = lines.slice(0, first).join("\n").trimEnd();
    const after = lines.slice(first).join("\n").trim();
    return `${before}\n\n${block}\n\n${after}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trim();
  return `${before}\n\n${block}\n${after ? `\n${after}\n` : ""}`;
}

function releaseHeadSha() {
  const onTag = currentTagName();
  const onMain = process.env.GITHUB_REF === "refs/heads/main";
  if (process.env.GITHUB_SHA && (onTag || onMain || process.env.GITHUB_ACTIONS === "true")) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
}

function currentTagName() {
  const ref = process.env.GITHUB_REF || "";
  if (ref.startsWith("refs/tags/v")) return ref.slice("refs/tags/".length);
  return null;
}

function previousTag(tags, tagName, headDate) {
  if (tagName) return tags.find((tag) => tag.name !== tagName && tag.date < headDate) || null;
  return tags.find((tag) => tag.date <= headDate) || null;
}

async function versionTags(repo) {
  const tags = await ghList(`/repos/${repo}/tags`);
  const versioned = tags.filter((tag) => /^v/.test(tag.name));
  const dated = [];
  for (const tag of versioned) {
    const commit = await gh(`/repos/${repo}/commits/${tag.commit.sha}`);
    dated.push({
      name: tag.name,
      sha: tag.commit.sha,
      date: commit.data.commit.committer.date,
    });
  }
  dated.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  return dated;
}

function landedOnMain(pull, mainShas) {
  if (pull.base?.ref === "main") return true;
  return Boolean(pull.merge_commit_sha && mainShas && mainShas.has(pull.merge_commit_sha));
}

function byNumber(pulls) {
  return pulls.sort((a, b) => a.number - b.number);
}

async function historyShas(repo, sha) {
  const commits = await ghList(`/repos/${repo}/commits?sha=${sha}`);
  return new Set(commits.map((commit) => commit.sha));
}

async function mergedPulls(repo, range) {
  const closed = await ghList(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`);
  const merged = closed.filter((pull) => pull.merged_at);
  if (!range.base) {
    const shas = await historyShas(repo, range.headSha);
    return byNumber(merged.filter((pull) => {
      if (!landedOnMain(pull, shas)) return false;
      return !range.headDate || pull.merged_at <= range.headDate;
    }));
  }
  const compared = await gh(`/repos/${repo}/compare/${range.base.sha}...${range.headSha}`);
  const commits = compared.data.commits || [];
  const shas = new Set(commits.map((commit) => commit.sha));
  if (compared.data.total_commits > commits.length) {
    console.error(`Compare listed ${commits.length} of ${compared.data.total_commits} commits. Using merge dates.`);
    return byNumber(merged.filter((pull) => {
      if (!landedOnMain(pull, shas)) return false;
      return pull.merged_at > range.base.date && pull.merged_at <= addMinutes(range.headDate, 5);
    }));
  }
  return byNumber(merged.filter((pull) => shas.has(pull.merge_commit_sha) && landedOnMain(pull, shas)));
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

async function trackerNotes(repo, number) {
  try {
    const comments = await ghList(`/repos/${repo}/issues/${number}/comments`);
    return comments.map((comment) => trackerNote(comment.body)).filter(Boolean);
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      console.error(`Tracker comments for #${number} were not readable (${error.status}).`);
      return [{ kind: "review", verdict: "comments were not readable with this token" }];
    }
    throw error;
  }
}

async function decorate(repo, pulls, team) {
  return Promise.all(pulls.map(async (pull) => ({
    number: pull.number,
    title: pull.title,
    html_url: pull.html_url,
    body: pull.body,
    merged_at: pull.merged_at,
    bot: assignBot(pull, team),
    tracker: await trackerNotes(repo, pull.number),
  })));
}

function exampleNumbers(team) {
  return (team.examplePrs || [])
    .map((number) => Number(number))
    .filter((number) => Number.isInteger(number))
    .sort((a, b) => a - b);
}

async function collectExample(repo, team) {
  const numbers = exampleNumbers(team);
  if (!numbers.length) throw new Error("No examplePrs in .github/bot-team.json.");
  const pulls = [];
  for (const number of numbers) {
    const result = await gh(`/repos/${repo}/pulls/${number}`);
    pulls.push(result.data);
  }
  const decorated = await decorate(repo, pulls, team);
  const open = decorated.every((pull) => !pull.merged_at);
  const title = numbers.join(",") === "1,2,3,4"
    ? "Example: PRs #1-#4"
    : `Example: PRs ${numbers.map((number) => `#${number}`).join(", ")}`;
  const intro = open
    ? `Sample notes covering pull requests ${listNumbers(numbers)}. They were open when these notes were written, so this section is not a GitHub Release.`
    : `Sample notes covering pull requests ${listNumbers(numbers)}. This section is an example, not a GitHub Release.`;
  return { notes: renderNotes({ title, intro, pulls: decorated }), tag: null, draft: false };
}

async function collectRelease(repo) {
  const team = loadTeam();
  const tags = await versionTags(repo);
  const tagName = currentTagName();
  const headSha = releaseHeadSha();
  const head = await gh(`/repos/${repo}/commits/${headSha}`);
  const headDate = head.data.commit.committer.date;
  const base = previousTag(tags, tagName, headDate);
  const pulls = await decorate(repo, await mergedPulls(repo, { base, headSha, headDate }), team);
  const since = base ? `the previous tag ${base.name}` : "the start of the repository";
  if (tagName) {
    return {
      tag: tagName,
      draft: false,
      notes: renderNotes({
        title: tagName,
        intro: `Pull requests merged since ${since}.`,
        pulls,
      }),
    };
  }
  return {
    tag: "latest",
    draft: true,
    notes: renderNotes({
      title: "Unreleased",
      intro: `Rolling notes for pull requests merged since ${since}. On a push to main this is the draft Release named latest. It is not a versioned release. Push a v* tag to publish one.`,
      pulls,
    }),
  };
}

function writeSummary(notes) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, notes, "utf8");
}

function writeChangelog(notes) {
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  writeFileSync(changelogPath, upsertSection(existing, notes), "utf8");
}

async function commitNotesOnMain(tag, notes) {
  execFileSync("git", ["fetch", "origin", "main"], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["checkout", "-B", "main", "origin/main"], { cwd: root, stdio: "inherit" });
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  writeFileSync(changelogPath, upsertSection(existing, notes), "utf8");
  execFileSync("git", ["add", "CHANGELOG.md"], { cwd: root, stdio: "inherit" });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" });
  if (!staged.trim()) {
    console.error("Changelog already has this section.");
    return;
  }
  execFileSync("git", [
    "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m", `chore: update changelog for ${tag} [skip release-notes]`,
  ], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: root, stdio: "inherit" });
}

async function findRelease(repo, tag) {
  const releases = await ghList(`/repos/${repo}/releases`);
  const listed = releases.find((release) => release.tag_name === tag)
    || releases.find((release) => release.draft && release.name === tag);
  if (listed) return listed;
  try {
    const byTag = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    return byTag.data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function publishRelease(repo, { tag, draft, notes }) {
  const existing = await findRelease(repo, tag);
  if (existing) {
    const updated = await gh(`/repos/${repo}/releases/${existing.id}`, {
      method: "PATCH",
      body: { tag_name: tag, name: tag, body: notes },
    });
    console.error(`Updated release ${updated.data.html_url}`);
    return;
  }
  try {
    const created = await gh(`/repos/${repo}/releases`, {
      method: "POST",
      body: {
        tag_name: tag,
        name: tag,
        body: notes,
        draft,
        target_commitish: process.env.GITHUB_SHA || "main",
      },
    });
    console.error(`${draft ? "Drafted" : "Published"} release ${created.data.html_url}`);
  } catch (error) {
    if (error.status !== 422) throw error;
    const raced = await findRelease(repo, tag);
    if (!raced) throw error;
    const updated = await gh(`/repos/${repo}/releases/${raced.id}`, {
      method: "PATCH",
      body: { tag_name: tag, name: tag, body: notes },
    });
    console.error(`Updated release ${updated.data.html_url}`);
  }
}

function selfCheck() {
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const stepOne = {
    title: "Paste an X post and get a sorted card in the feed",
    body: "Step 1 only. Do not merge until a reviewer has commented.\n\nPaste a public X post URL. The card shows up as `queued`, then the pipeline fills in author, text, kind, and summary.\n",
  };
  assert(
    whatItDoes(stepOne) === "The card shows up as queued, then the pipeline fills in author, text, kind, and summary.",
    `step 1 sentence was: ${whatItDoes(stepOne)}`,
  );
  const stepFour = {
    title: "Step 4: paper/idea actions",
    body: "Rebased onto the latest cursor/why-you-f351 (includes PR #1). Paper and idea saves write a one-page SPEC.md plus a starter folder, zip both, and link the zip from the feed card and the detail page. Repo runs stay as they are.\n",
  };
  assert(
    whatItDoes(stepFour).startsWith("Paper and idea saves write a one-page SPEC.md"),
    `step 4 sentence was: ${whatItDoes(stepFour)}`,
  );
  const team = loadTeam();
  assert(assignBot({ number: 2, labels: [], body: "", head: { ref: "other" } }, team) === "builder 2", "map number");
  assert(
    assignBot({ number: 9, labels: [], body: "", head: { ref: "cursor/paper-idea-29d1" } }, team) === "builder 3",
    "branch prefix",
  );
  assert(
    assignBot({ number: 9, labels: [{ name: "bot: builder-2" }], body: "Bot: builder", head: { ref: "cursor/paste-url" } }, team) === "builder 2",
    "label wins",
  );
  assert(
    assignBot({ number: 1, labels: [], body: "Bot: builder 3\n", head: { ref: "cursor/paste-url" } }, team) === "builder 3",
    "body wins over map",
  );
  const stepThree = {
    title: "why",
    body: "## Summary\nEach save gets a one-line why_you from the profile as soon as it is sorted. No new dependencies.\n",
  };
  assert(
    whatItDoes(stepThree).startsWith("Each save gets a one-line why_you"),
    `step 3 sentence was: ${whatItDoes(stepThree)}`,
  );
  assert(trackerNote("tracker review: needs fixes\n\nMore.")?.verdict === "needs fixes", "tracker review");
  assert(
    trackerNote("tracker review: needs fixes (small ones). The feature works today, but one demo line is fragile.")?.verdict
      === "needs fixes (small ones)",
    "tracker first sentence",
  );
  assert(
    trackerNote("tracker re-review: **passes, with 1 follow-up fix.** All four.")?.verdict === "passes, with 1 follow-up fix",
    "tracker re-review",
  );
  assert(trackerNote("tracker review (addendum): needs fixes")?.verdict === "needs fixes", "tracker review addendum");
  assert(trackerNote("tracker review (addendum): needs fixes")?.kind === "review", "addendum is a review");
  const rereview = trackerNote("tracker re-review (PR #1): **passes.**");
  assert(rereview?.verdict === "passes" && rereview?.kind === "re-review", "tracker re-review with a parenthetical");
  assert(trackerNote("Looks good.") === null, "ignore other comments");
  const first = renderNotes({
    title: "Example: PRs #1-#4",
    intro: "Sample.",
    pulls: [{
      number: 1,
      title: "Feed",
      html_url: "https://example.test/1",
      body: "Paste a public X post URL and sort it into the feed for the demo.",
      bot: "builder",
      tracker: [{ kind: "review", verdict: "needs fixes" }],
    }],
  });
  const file = upsertSection("", first);
  assert(file.startsWith("# Changelog"), "changelog header");
  assert(file.includes("## Example: PRs #1-#4"), "example section");
  const replaced = upsertSection(file, first.replace("Sample.", "Sample again."));
  assert(replaced.includes("Sample again."), "section replaced");
  assert(!replaced.includes("\nSample.\n"), "old intro removed");
  const prepended = upsertSection(replaced, "## v0.1.0\n\nPull requests merged since the start of the repository.\n");
  assert(prepended.indexOf("## v0.1.0") < prepended.indexOf("## Example: PRs #1-#4"), "tag section prepends");
  const separated = {
    examplePrs: [1, 2],
    prs: { 1: "builder", 2: "builder 2", 5: "builder 3" },
    branchPrefixes: [{ prefix: "cursor/release-bot", bot: "builder 3" }],
  };
  assert(exampleNumbers(separated).join(",") === "1,2", "example list is separate from the mapping");
  assert(!exampleNumbers(separated).includes(5), "example list ignores extra mapped pull requests");
  assert(
    assignBot({ number: 5, labels: [], body: "", head: { ref: "anywhere" } }, separated) === "builder 3",
    "mapped pull request number",
  );
  assert(
    assignBot({ number: 9, labels: [], body: "", head: { ref: "cursor/release-bot-c424" } }, separated) === "builder 3",
    "release-bot prefix",
  );
  assert(landedOnMain({ base: { ref: "cursor/paste-url" }, merge_commit_sha: "side" }, new Set(["on-main"])) === false, "stacked pull request");
  assert(landedOnMain({ base: { ref: "main" }, merge_commit_sha: "m" }, new Set()) === true, "base main");
  assert(landedOnMain({ base: { ref: "feature" }, merge_commit_sha: "landed" }, new Set(["landed"])) === true, "merge commit on main");
  assert(assignBot({ number: 5, labels: [], body: "", head: { ref: "cursor/release-bot-c424" } }, team) === "builder 3", "live map credits #5");
  const tags = [
    { name: "v0.2.0", date: "2026-02-01T00:00:00Z" },
    { name: "v0.1.0", date: "2026-01-01T00:00:00Z" },
  ];
  assert(previousTag(tags, "v0.2.0", "2026-02-01T00:00:00Z").name === "v0.1.0", "previous on the new tag");
  assert(previousTag(tags, null, "2026-02-01T00:00:00Z").name === "v0.2.0", "main sits on the latest tag");
  assert(previousTag(tags, null, "2026-03-01T00:00:00Z").name === "v0.2.0", "main after the latest tag");
  assert(previousTag([{ name: "v0.1.0", date: "2026-01-01T00:00:00Z" }], "v0.1.0", "2026-01-01T00:00:00Z") === null, "first tag");
  assert(previousTag([], null, "2026-03-01T00:00:00Z") === null, "no tags");
  console.log("self-check ok");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    selfCheck();
    return;
  }
  const repo = repository();
  const team = loadTeam();
  const result = args.example ? await collectExample(repo, team) : await collectRelease(repo);
  writeSummary(result.notes);
  process.stdout.write(result.notes);
  if (args.writeChangelog) writeChangelog(result.notes);
  if (args.dryRun || args.example || !args.publish) {
    console.error(args.example ? "Example only. Nothing published." : "Dry run. Nothing published.");
    return;
  }
  let changelogError = null;
  if (result.tag !== "latest") {
    try {
      await commitNotesOnMain(result.tag, result.notes);
    } catch (error) {
      changelogError = error;
      console.error(redact(error.message || error));
    }
  }
  await publishRelease(repo, result);
  if (changelogError) throw changelogError;
}

main().catch((error) => {
  console.error(redact(error.stack || error.message || error));
  process.exit(1);
});
