import { renderFileList, renderZipLink } from "./act/snippet.js";
import { isReadmeOnlyCache, README_ONLY_NOTE } from "./runner/fallback.js";
import { extractProducts } from "./runner/quickstart.js";

const KINDS = ["repo", "tool", "paper", "idea", "event", "other"];

export function renderFeed(saves, profileState = {}) {
  const pending = saves.some((save) => needsRefresh(save));
  return layout({
    title: "Saved to Shipped",
    body: `
      <header class="top">
        <div>
          <p class="brand">Saved to Shipped</p>
          <h1>Save it. Ship it.</h1>
          <p class="lede">Paste a public X post. It lands in the feed, then gets sorted into a repo, paper, idea, tool, or event. A paper or an idea comes back as a spec and a starter zip.</p>
          ${profileBadge(profileState)}
        </div>
      </header>
      <form class="paste" method="post" action="/api/saves">
        <label for="url">X post URL</label>
        <div class="row">
          <input id="url" name="url" type="url" required placeholder="https://x.com/user/status/123" autocomplete="off">
          <button type="submit">Save it</button>
        </div>
      </form>
      <section id="cards" class="cards" data-pending="${pending ? "1" : "0"}">
        ${renderCards(saves)}
      </section>
      <script>
        const form = document.querySelector(".paste");
        const cards = document.querySelector("#cards");
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const input = document.querySelector("#url");
          const button = form.querySelector("button");
          button.disabled = true;
          try {
            const response = await fetch("/api/saves", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ url: input.value })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "Could not save");
            input.value = "";
            await refresh();
          } catch (error) {
            alert(error.message);
          } finally {
            button.disabled = false;
          }
        });
        async function refresh() {
          const response = await fetch("/feed/cards");
          cards.innerHTML = await response.text();
          const stillPending = cards.querySelector("[data-status='queued'], [data-status='sorting'], [data-status='acting'], [data-upgrade='pending'], [data-why='pending']");
          cards.dataset.pending = stillPending ? "1" : "0";
          if (stillPending) setTimeout(refresh, 800);
        }
        if (cards.dataset.pending === "1") setTimeout(refresh, 800);
        document.querySelectorAll("time[data-synced]").forEach((node) => {
          const date = new Date(node.dateTime || node.getAttribute("data-synced"));
          if (Number.isNaN(date.getTime())) return;
          node.textContent = date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit"
          });
        });
      </script>
    `,
  });
}

export function renderCards(saves) {
  if (!saves.length) {
    return `<p class="empty">No saves yet. Paste a post and a card will show up here.</p>`;
  }
  return saves.map(renderCard).join("");
}

export function renderNotFound() {
  return layout({
    title: "Not found · Saved to Shipped",
    body: `<p class="back"><a href="/">← Feed</a></p><h1>That save does not exist.</h1>`,
  });
}

export function renderDetail(save) {
  const action = parseAction(save);
  const details = action?.sorted?.details || {};
  const links = action?.sorted?.links || [];
  const act = action?.act;
  const products = productsFromRun(act);
  if (save.kind === "repo" && act && (products.length || act.snippet || act.duration_ms != null)) {
    return layout({
      title: save.author ? `${save.author} · Saved to Shipped` : "Save · Saved to Shipped",
      body: renderRepoDetail(save, action, details, links, act, products),
    });
  }
  return layout({
    title: save.author ? `${save.author} · Saved to Shipped` : "Save · Saved to Shipped",
    body: `
      <p class="back"><a href="/">← Feed</a></p>
      <article class="detail">
        <div class="meta">
          ${save.kind ? badge(save.kind) : ""}
          ${statusPill(save.status)}
        </div>
        <h1>${escapeHtml(save.author || save.url)}</h1>
        ${save.summary ? `<p class="summary">${escapeHtml(save.summary)}</p>` : ""}
        ${renderZipLink(act)}
        <p class="source"><a href="${escapeHtml(save.url)}">${escapeHtml(save.url)}</a></p>
        ${save.text ? `<pre class="post">${escapeHtml(save.text)}</pre>` : ""}
        ${action?.sorted?.reply_text ? `<h2>Also in the thread</h2><pre class="post">${escapeHtml(action.sorted.reply_text)}</pre>` : ""}
        <h2>Sorted</h2>
        <dl class="details">
          ${detailRow("Kind", save.kind)}
          ${detailRow("Repo", details.repo_url)}
          ${detailRow("Paper", details.paper_url)}
          ${detailRow("Tool", details.tool_url)}
          ${detailRow("Event", details.event_url)}
          ${detailRow("Date", details.date)}
          ${detailRow("Sorted by", action?.sorted?.source)}
        </dl>
        ${renderLinks(links)}
        ${save.why_you ? `<h2>Why you</h2><p class="why">${escapeHtml(save.why_you)}</p>` : ""}
        <h2>Show last run</h2>
        <div class="last-run">
          ${renderLastRun(save, act)}
        </div>
        ${save.error ? `<p class="error">${escapeHtml(save.error)}</p>` : ""}
        <form method="post" action="/api/saves/${save.id}/rerun">
          <button type="submit">Run again</button>
        </form>
      </article>
      ${needsRefresh(save) ? `<script>setTimeout(function () { location.reload(); }, 800);</script>` : ""}
    `,
  });
}

function renderRepoDetail(save, action, details, links, act, products) {
  const works = verdictLine(act);
  const snippet = String(act.snippet || "").replace(/\s+$/, "");
  const next = nextStep(act, details);
  return `
      <p class="back"><a href="/">← Feed</a></p>
      <article class="detail lead">
        <div class="meta">
          ${save.kind ? badge(save.kind) : ""}
          ${statusPill(save.status)}
        </div>
        <h1>${escapeHtml(save.author || save.url)}</h1>
        <section class="verdict" id="verdict">
          <p class="works">${escapeHtml(works)}</p>
          ${save.why_you ? `<p class="why"><span class="k">Why you</span> ${escapeHtml(save.why_you)}</p>` : ""}
          ${snippet ? `<pre class="snippet">${escapeHtml(snippet)}</pre>` : ""}
          <p class="next"><span class="k">Next step</span> ${escapeHtml(next)}</p>
        </section>
        <p class="run-label">Show last run</p>
        ${renderProductTable(products)}
        ${save.screenshot_path ? `<img class="shot" alt="Last run screenshot" src="${escapeHtml(save.screenshot_path)}">` : ""}
        <details class="more">
          <summary>Details</summary>
          ${save.summary ? `<p class="summary">${escapeHtml(save.summary)}</p>` : ""}
          <p class="source"><a href="${escapeHtml(save.url)}">${escapeHtml(save.url)}</a></p>
          ${save.text ? `<pre class="post">${escapeHtml(save.text)}</pre>` : ""}
          ${action?.sorted?.reply_text ? `<h2>Also in the thread</h2><pre class="post">${escapeHtml(action.sorted.reply_text)}</pre>` : ""}
          <h2>Sorted</h2>
          <dl class="details">
            ${detailRow("Kind", save.kind)}
            ${detailRow("Repo", details.repo_url)}
            ${detailRow("Paper", details.paper_url)}
            ${detailRow("Tool", details.tool_url)}
            ${detailRow("Event", details.event_url)}
            ${detailRow("Date", details.date)}
            ${detailRow("Sorted by", action?.sorted?.source)}
          </dl>
          ${renderLinks(links)}
          <div class="last-run">
            ${renderLastRun(save, act, { screenshot: false })}
          </div>
        </details>
        ${save.error ? `<p class="error">${escapeHtml(save.error)}</p>` : ""}
        ${needsRefresh(save) ? `<script>setTimeout(function () { location.reload(); }, 800);</script>` : ""}
        <form method="post" action="/api/saves/${save.id}/rerun">
          <button type="submit">Run again</button>
        </form>
      </article>
    `;
}

function renderProductTable(products) {
  if (!products.length) return `<p class="empty">No products in this run.</p>`;
  return `
    <table class="products">
      <thead>
        <tr><th>Product</th><th>One-liner</th><th>URL</th></tr>
      </thead>
      <tbody>
        ${products
          .map((product) => {
            const href = safeHref(product.url);
            const urlCell = href
              ? `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`
              : escapeHtml(product.url);
            return `<tr><td class="name">${escapeHtml(product.name)}</td><td>${escapeHtml(product.one_liner)}</td><td class="url">${urlCell}</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function productsFromRun(act) {
  const parsed = extractProducts(act?.stdout);
  if (parsed.length) return parsed;
  if (!Array.isArray(act?.products)) return [];
  return act.products
    .filter((product) => product && product.name && product.one_liner && product.url)
    .slice(0, 10);
}

function formatRunSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${(n / 1000).toFixed(1)}s`;
}

function verdictLine(act) {
  const wall = formatRunSeconds(act?.duration_ms);
  const scrape = formatRunSeconds(act?.run_duration_ms);
  if (act?.timed_out === true) {
    return `Timed out after ${wall || scrape || "the budget"}`;
  }
  if (act?.exit_code !== 0) {
    if (act?.exit_code == null) return "No finished run";
    return installFailed(act) ? "Failed at install" : "Failed";
  }
  const runtime = act?.python ? ` (Python ${act.python})` : "";
  return `Works: ${timingClause(wall, scrape)}${runtime}`;
}

function timingClause(wall, scrape) {
  if (wall && scrape && wall !== scrape) return `installed and ran in ${wall} (scrape ${scrape})`;
  if (wall) return `installed and ran in ${wall}`;
  if (scrape) return `installed and ran (scrape ${scrape})`;
  return "installed and ran";
}

function installFailed(act) {
  if (act?.install_stderr) return true;
  const commands = Array.isArray(act?.commands) ? act.commands : [];
  return commands.some((command) => {
    const cmd = String(command?.cmd || "");
    return command?.exit_code && /pip |npm |pnpm |yarn |venv|install/.test(cmd);
  });
}

function nextStep(act, details) {
  const repoUrl = act?.repo || details?.repo_url || "";
  const name = String(repoUrl).split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "";
  if (act?.snippet && name) return `Run the snippet above in ${name}`;
  if (act?.snippet) return "Run the snippet from this save";
  if (name) return `Clone ${name} and try its quickstart`;
  return "Try the quickstart from this save";
}

function renderCard(save) {
  const action = parseAction(save);
  const verdict = cardVerdict(save, action);
  const summary = cardSummary(save);
  return `
    <article class="card" data-status="${escapeHtml(save.status || "")}" data-kind="${escapeHtml(save.kind || "")}" data-verdict="${escapeHtml(verdict)}" data-why="${save.why_you_source === "pending" ? "pending" : ""}"${upgradeAttr(save)}>
      <div class="meta">
        ${save.kind ? badge(save.kind) : `<span class="badge other">Unsorted</span>`}
        ${statusPill(save.status)}
      </div>
      <h2><a href="/saves/${save.id}">${escapeHtml(cardTitle(save))}</a></h2>
      ${verdict ? `<p class="verdict-line">${escapeHtml(verdict)}</p>` : ""}
      ${save.why_you ? `<p class="why"><span class="k">Why you</span> ${escapeHtml(save.why_you)}</p>` : ""}
      ${summary ? `<p class="summary">${escapeHtml(summary)}</p>` : ""}
      ${renderZipLink(action?.act)}
      ${actionLinks(save, action)}
      ${cardNotes(action?.act)}
    </article>
  `;
}

function cardNotes(act) {
  if (!act) return "";
  const bits = [];
  if (act.status === "cached") bits.push(`<span class="badge other">cached</span>`);
  if (act.attempt_error) {
    if (act.fallback_note) bits.push(`<p class="note">${escapeHtml(act.fallback_note)}</p>`);
    bits.push(`<p class="error">${escapeHtml(clip(act.attempt_error))}</p>`);
  }
  const install = installNote(act);
  if (install) bits.push(install);
  return bits.join("");
}

export function cardVerdict(save, action = parseAction(save)) {
  const act = action?.act;
  if (save?.kind === "repo" && act && hasRunTiming(act)) return verdictLine(act);
  if (act?.verdict) return String(act.verdict);
  if (act?.summary) return excerpt(act.summary, 120);
  if (act?.reason) return excerpt(act.reason, 90);
  if (save?.summary) return excerpt(save.summary, 90);
  return "";
}

function hasRunTiming(act) {
  if (act.timed_out === true || act.exit_code != null) return true;
  if (act.duration_ms != null && Number.isFinite(Number(act.duration_ms))) return true;
  if (act.run_duration_ms != null && Number.isFinite(Number(act.run_duration_ms))) return true;
  return false;
}

function cardSummary(save) {
  const summary = save?.summary || excerpt(save?.text, 140) || "";
  return excerpt(summary, 140);
}

function actionLinks(save, action) {
  const act = action?.act;
  const details = action?.sorted?.details || {};
  const links = [];
  const repo = act?.repo_url || details.repo_url;
  if (repo && safeHref(repo)) links.push(`<a href="${escapeHtml(repo)}">Repo</a>`);
  if (save.kind === "tool") {
    const tool = act?.tool_url || details.tool_url;
    if (tool && safeHref(tool)) links.push(`<a href="${escapeHtml(tool)}">Try it</a>`);
    else links.push(`<a href="/saves/${save.id}#try-it">Try it</a>`);
  }
  if (save.kind === "event" && act?.ics) {
    const name = act.ics_filename || "event.ics";
    links.push(`<a href="/saves/${save.id}/event.ics">${escapeHtml(name)}</a>`);
  } else if (details.event_url && safeHref(details.event_url)) {
    links.push(`<a href="${escapeHtml(details.event_url)}">Event</a>`);
  }
  if (act?.zip_path && localHref(act.zip_path)) {
    links.push(`<a href="${escapeHtml(localHref(act.zip_path))}">Zip</a>`);
  }
  if (save.screenshot_path && localHref(save.screenshot_path)) {
    links.push(`<a href="${escapeHtml(save.screenshot_path)}">Screenshot</a>`);
  }
  if (!links.length) return "";
  return `<p class="actions">${links.join("")}</p>`;
}

function renderLastRun(save, act, options = {}) {
  if (act?.zipUrl) {
    return `
      <p>${escapeHtml(act.summary || "Spec and starter are ready.")}</p>
      ${renderZipLink(act)}
      ${renderFileList(act.files)}
      <p class="note">${act.cached ? "Cached on disk. Run again reuses this zip." : "Written just now. The next run reuses this zip."}</p>
    `;
  }
  const sample = Array.isArray(act?.extracted_sample) ? act.extracted_sample : [];
  const readmeOnly = isReadmeOnlyCache(act);
  const parts = [];
  if (act?.status === "cached") parts.push(`<p class="badge other">cached</p>`);
  if (readmeOnly) parts.push(`<p class="repo">${escapeHtml(README_ONLY_NOTE)}</p>`);
  else if (act?.fallback_note) parts.push(`<p class="repo">${escapeHtml(act.fallback_note)}</p>`);
  if (act?.warning) parts.push(`<p class="repo">${escapeHtml(act.warning)}</p>`);
  if (act?.attempt_error) parts.push(`<p class="error">${escapeHtml(act.attempt_error)}</p>`);
  if (act?.install_step) parts.push(`<p class="repo">install ${escapeHtml(act.install_step)}</p>`);
  if (act?.install_stderr && !String(act.attempt_error || "").includes(String(act.install_stderr).slice(0, 80))) {
    parts.push(`<h3>install</h3><pre class="post">${escapeHtml(clip(act.install_stderr, 2000))}</pre>`);
  }
  if (!readmeOnly && act && (save.screenshot_path || act.stdout)) {
    const bits = [
      act.language || "",
      act.exit_code == null ? "" : `exit ${act.exit_code}`,
      act.smoke_source ? `${act.smoke_source} quickstart` : "",
      act.timestamp || "",
    ].filter(Boolean);
    if (bits.length) parts.push(`<p class="repo">${escapeHtml(bits.join(" · "))}</p>`);
  }
  if (sample.length) {
    parts.push(`<ul class="sample">${sample.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  }
  if (save.screenshot_path && options.screenshot !== false) {
    parts.push(`<img class="shot" alt="Last run screenshot" src="${escapeHtml(save.screenshot_path)}">`);
  }
  if (Array.isArray(act?.steps) && act.steps.length) {
    parts.push(`<ol class="steps" id="try-it">${act.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`);
  }
  if (act?.ics) {
    const name = act.ics_filename || "event.ics";
    parts.push(`<p><a href="/saves/${save.id}/event.ics">${escapeHtml(name)}</a></p>`);
  }
  if (act?.stdout) {
    parts.push(`<h3>stdout</h3><pre class="post" id="stdout">${escapeHtml(act.stdout)}</pre>`);
  }
  if (parts.length) return parts.join("");
  const reason = act?.reason || act?.error || "No cached run yet.";
  return `<p>${escapeHtml(reason)} When a run exists, this spot replays the cached stdout and screenshot without calling the network again.</p>`;
}

function renderLinks(links) {
  const visible = (links || []).filter((link) => link.expanded);
  if (!visible.length) return "";
  return `
    <h2>Links</h2>
    <ul class="links">
      ${visible
        .map((link) => {
          const href = safeHref(link.expanded);
          if (!href) return "";
          return `<li><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></li>`;
        })
        .join("")}
    </ul>
  `;
}

function cardTitle(save) {
  if (save.author) return save.author;
  if (save.status === "failed") return "Couldn't read this post";
  return "Fetching post";
}

function layout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1d1914;
      --muted: #5e564c;
      --paper: #f3efe6;
      --card: #fffdf8;
      --line: #e3d9c8;
      --accent: #b8431f;
      --good: #1f6b45;
      --warn: #8a5a12;
      --bad: #9d2430;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 17px/1.5 "Avenir Next", "Segoe UI", sans-serif;
    }
    a { color: var(--accent); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 16px 20px 48px; }
    .back { margin: 0 0 8px; }
    .brand { margin: 0; letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; color: var(--accent); font-weight: 700; }
    .profile-badge {
      display: inline-block;
      margin: 10px 0 0;
      padding: 2px 10px;
      border-radius: 999px;
      background: #eeeae3;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    h1 { font-family: Palatino, "Iowan Old Style", Georgia, serif; font-size: 42px; line-height: 1.05; margin: 6px 0 8px; }
    .lede, .summary { color: var(--muted); }
    .why { margin: 8px 0 0; }
    .paste, .card, .detail, .last-run {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
    }
    .paste { padding: 16px; margin: 22px 0; }
    label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 8px; }
    .row { display: flex; gap: 8px; }
    input[type="url"] {
      flex: 1;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px 14px;
      font: inherit;
      background: #fff;
    }
    button {
      border: 0;
      border-radius: 999px;
      background: var(--ink);
      color: #fff;
      font: inherit;
      font-weight: 700;
      padding: 12px 18px;
      cursor: pointer;
    }
    .cards { display: grid; gap: 10px; }
    .card, .detail { padding: 16px 18px; }
    .card { padding: 12px 14px; }
    .card h2, .detail h1 { font-family: Palatino, Georgia, serif; margin: 8px 0; }
    .card h2 { font-size: 20px; line-height: 1.2; margin: 4px 0; }
    .card .summary { margin: 4px 0 0; font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card .why { margin: 2px 0 0; font-size: 14px; }
    .verdict-line { margin: 2px 0 0; font-weight: 700; font-size: 15px; }
    .actions { margin: 8px 0 0; font-size: 13px; }
    .actions a { display: inline-block; margin: 0 8px 0 0; }
    .k { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 700; margin-right: 6px; }
    .card h2 a, .back a { text-decoration: none; }
    .meta { display: flex; gap: 8px; align-items: center; }
    .badge, .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .badge.repo { background: #e5f4ea; color: var(--good); }
    .badge.paper { background: #e7eefc; color: #234a93; }
    .badge.idea { background: #f8edd8; color: var(--warn); }
    .badge.tool { background: #f3e8f8; color: #6d2d86; }
    .badge.event { background: #fde8e4; color: var(--bad); }
    .badge.other { background: #eeeae3; color: var(--muted); }
    .status.queued, .status.sorting { background: #eeeae3; color: var(--muted); }
    .status.acting { background: #f8edd8; color: var(--warn); }
    .status.done { background: #e5f4ea; color: var(--good); }
    .status.failed { background: #fde8e4; color: var(--bad); }
    .repo, .artifact { font-size: 14px; word-break: break-all; }
    .action-summary, .note { color: var(--muted); font-size: 15px; }
    .artifact a { font-weight: 700; }
    .files { margin: 8px 0 0; padding-left: 18px; }
    .files code { font-size: 14px; }
    .empty { color: var(--muted); }
    .post {
      white-space: pre-wrap;
      font: 15px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      background: #faf7f1;
      border-radius: 12px;
      padding: 12px;
      overflow-wrap: anywhere;
    }
    .details { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; }
    .details dt { color: var(--muted); }
    .details dd { margin: 0; overflow-wrap: anywhere; }
    .last-run { padding: 14px; margin-top: 8px; }
    .error { color: var(--bad); }
    .shot { max-width: 100%; border-radius: 12px; margin-top: 10px; display: block; }
    .sample { margin: 8px 0 4px; padding-left: 18px; }
    .last-run h3 { margin: 14px 0 6px; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .detail.lead { padding: 10px 14px 12px; }
    .detail.lead h1 { font-size: 26px; margin: 0 0 6px; }
    .verdict {
      background: #f3faf6;
      border: 1px solid #b7d7c4;
      border-radius: 12px;
      padding: 6px 12px 8px;
      margin: 0 0 6px;
    }
    .verdict .works { margin: 0; font-weight: 700; color: var(--good); }
    .verdict .why, .verdict .next { margin: 2px 0 0; }
    .verdict .k { margin-right: 6px; }
    .snippet {
      margin: 4px 0 0;
      padding: 6px 8px;
      font-size: 12px;
      line-height: 1.25;
      white-space: pre;
      overflow: auto;
    }
    .run-label { margin: 0 0 2px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    table.products { width: 100%; border-collapse: collapse; }
    table.products th, table.products td { text-align: left; padding: 2px 10px 2px 0; vertical-align: baseline; }
    table.products th { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
    table.products td { border-top: 1px solid var(--line); font-size: 14px; line-height: 1.2; }
    table.products td.name { font-weight: 700; white-space: nowrap; }
    table.products td.url { font-size: 13px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
    details.more { margin-top: 12px; }
    details.more summary { cursor: pointer; font-weight: 700; }
    details.more .post { margin-top: 8px; }
    @media (min-width: 960px) {
      .cards { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 640px) {
      h1 { font-size: 34px; }
      .row { flex-direction: column; }
      .details { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    ${body}
  </main>
</body>
</html>`;
}

function profileBadge(state) {
  if (state?.source === "bot" && state.synced_at) {
    const iso = escapeHtml(state.synced_at);
    return `<p class="profile-badge" data-profile="bot">Profile from Grok Bot memory, synced <time data-synced="${iso}" datetime="${iso}"></time></p>`;
  }
  return `<p class="profile-badge" data-profile="default">Default profile</p>`;
}

function badge(kind) {
  const safe = KINDS.includes(kind) ? kind : "other";
  return `<span class="badge ${safe}">${escapeHtml(safe)}</span>`;
}

function statusPill(status) {
  const safe = ["queued", "sorting", "acting", "done", "failed"].includes(status) ? status : "queued";
  return `<span class="status ${safe}">${escapeHtml(safe)}</span>`;
}

function detailRow(label, value) {
  if (!value) return "";
  const href = typeof value === "string" ? safeHref(value) : null;
  const shown = href ? `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>` : escapeHtml(String(value));
  return `<dt>${escapeHtml(label)}</dt><dd>${shown}</dd>`;
}

function clip(text, max = 600) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function installNote(act) {
  if (!act?.install_stderr) return "";
  const head = String(act.install_stderr).slice(0, 80);
  if (act.attempt_error && String(act.attempt_error).includes(head)) return "";
  return `<p class="error">${escapeHtml(clip(act.install_stderr))}</p>`;
}

function excerpt(text, max = 180) {
  if (!text) return "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function localHref(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("/") && !value.includes("..") && !value.includes("\\")) return value;
  return safeHref(value);
}

function parseAction(save) {
  if (!save?.action_result_json) return null;
  try {
    return JSON.parse(save.action_result_json);
  } catch {
    return null;
  }
}

function safeHref(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return null;
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPending(save) {
  const status = typeof save === "string" ? save : save?.status;
  if (status === "queued" || status === "sorting" || status === "acting") return true;
  return save?.why_you_source === "pending";
}

function needsRefresh(save) {
  return isPending(save) || upgradeOf(save) === "pending";
}

function upgradeAttr(save) {
  return upgradeOf(save) === "pending" ? ` data-upgrade="pending"` : "";
}

function upgradeOf(save) {
  return parseAction(save)?.sorted?.upgrade || null;
}
