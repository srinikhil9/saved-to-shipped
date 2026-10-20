const KINDS = ["repo", "tool", "paper", "idea", "event", "other"];

export function renderFeed(saves) {
  const pending = saves.some((save) => isPending(save.status));
  return layout({
    title: "Saved to Shipped",
    body: `
      <header class="top">
        <div>
          <p class="brand">Saved to Shipped</p>
          <h1>Save it. Ship it.</h1>
          <p class="lede">Paste a public X post. It lands in the feed, then gets sorted into a repo, paper, idea, tool, or event.</p>
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
          const stillPending = cards.querySelector("[data-status='queued'], [data-status='sorting'], [data-status='acting']");
          cards.dataset.pending = stillPending ? "1" : "0";
          if (stillPending) setTimeout(refresh, 800);
        }
        if (cards.dataset.pending === "1") setTimeout(refresh, 800);
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
        <p class="source"><a href="${escapeHtml(save.url)}">${escapeHtml(save.url)}</a></p>
        ${save.text ? `<pre class="post">${escapeHtml(save.text)}</pre>` : ""}
        ${action?.sorted?.reply_text ? `<h2>Also in the thread</h2><pre class="post">${escapeHtml(action.sorted.reply_text)}</pre>` : ""}
        <h2>Sorted</h2>
        <dl class="details">
          ${detailRow("Kind", save.kind)}
          ${detailRow("Repo", details.repo_url)}
          ${detailRow("Paper", details.paper_url)}
          ${detailRow("Tool", details.tool_url)}
          ${detailRow("Date", details.date)}
          ${detailRow("Sorted by", action?.sorted?.source)}
        </dl>
        ${renderLinks(links)}
        ${save.why_you ? `<h2>Why you</h2><p>${escapeHtml(save.why_you)}</p>` : ""}
        <h2>Show last run</h2>
        <div class="last-run">
          ${renderLastRun(save, act)}
        </div>
        ${save.error ? `<p class="error">${escapeHtml(save.error)}</p>` : ""}
        <form method="post" action="/api/saves/${save.id}/rerun">
          <button type="submit">Run again</button>
        </form>
      </article>
    `,
  });
}

function renderCard(save) {
  const action = parseAction(save);
  const repo = action?.sorted?.details?.repo_url;
  return `
    <article class="card" data-status="${escapeHtml(save.status || "")}" data-kind="${escapeHtml(save.kind || "")}">
      <div class="meta">
        ${save.kind ? badge(save.kind) : `<span class="badge other">Unsorted</span>`}
        ${statusPill(save.status)}
      </div>
      <h2><a href="/saves/${save.id}">${escapeHtml(cardTitle(save))}</a></h2>
      <p>${escapeHtml(save.summary || excerpt(save.text) || save.url)}</p>
      ${repo ? `<p class="repo"><a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a></p>` : ""}
      ${save.error ? `<p class="error">${escapeHtml(save.error)}</p>` : ""}
    </article>
  `;
}

function renderLastRun(save, act) {
  if (save.screenshot_path) {
    return `<img class="shot" alt="Last run screenshot" src="${escapeHtml(save.screenshot_path)}">`;
  }
  const reason = act?.reason || "No cached run yet.";
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
    .wrap { max-width: 820px; margin: 0 auto; padding: 32px 20px 64px; }
    .brand { margin: 0; letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; color: var(--accent); font-weight: 700; }
    h1 { font-family: Palatino, "Iowan Old Style", Georgia, serif; font-size: 42px; line-height: 1.05; margin: 6px 0 8px; }
    .lede, .summary { color: var(--muted); }
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
    .cards { display: grid; gap: 12px; }
    .card, .detail { padding: 16px 18px; }
    .card h2, .detail h1 { font-family: Palatino, Georgia, serif; margin: 8px 0; }
    .card h2 { font-size: 26px; }
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
    .repo { font-size: 14px; word-break: break-all; }
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
    .shot { max-width: 100%; border-radius: 12px; }
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

function excerpt(text) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 180) return clean;
  return `${clean.slice(0, 177).trimEnd()}…`;
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

function isPending(status) {
  return status === "queued" || status === "sorting" || status === "acting";
}
