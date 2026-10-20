import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createSave, openDb, updateSave } from "../src/db.js";
import { listFixturePosts } from "../src/ingest.js";
import { cardVerdict, renderCards } from "../src/html.js";
import { runPipeline } from "../src/pipeline.js";

const LINES = {
  cua: "Cua Spaces is infra for the scraping agents that pull social data for your YC/a16z product recommender.",
  wabi: "Wabi is the kind of a16z consumer product your recommender should surface to the right users.",
  veeza: "Veeza is the kind of YC consumer product your recommender should surface to the right users.",
  event: "AcceleratorCON is where you meet the YC and a16z founders whose products feed your catalog.",
  fortress: "Fortress is stealth-browser infra so your scraping agents stop getting blocked.",
  scrapling: "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
  loop: "A blueprint for running your scrape-and-recommend agents as a self-verifying loop; Saved to Shipped is one.",
  brain: "Turn your saved posts, founders, and YC/a16z products into a living wiki your recommender can draw on.",
};

test("feed renders every seed offline with kind, verdict, and why_you", async (t) => {
  const posts = listFixturePosts();
  assert.equal(posts.length, 8);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("network");
  };
  const db = openDb(":memory:");
  const app = createApp(db, { offline: true, env: {}, fetchImpl });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).finally(() => db.close()));

  const ids = [];
  for (const post of posts) {
    const created = await fetch(`${base}/api/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: post.url }),
    });
    assert.equal(created.status, 201, post.url);
    ids.push((await created.json()).id);
  }

  const done = [];
  for (const id of ids) done.push(await waitUntilSettled(base, id));
  assert.equal(calls, 0);
  assert.equal(done.every((row) => row.status === "done"), true);

  const byUrl = new Map(done.map((row) => [row.url, row]));
  const expectRow = (url, kind, why, verdict) => {
    const row = byUrl.get(url);
    assert.ok(row, url);
    assert.equal(row.kind, kind, url);
    assert.equal(row.why_you, why, url);
    assert.equal(row.why_you_source, "template", url);
    if (verdict != null) assert.equal(row.action_result_json.act.verdict, verdict, url);
    assert.equal(row.error, null, url);
    return row;
  };

  const scrapling = expectRow(
    "https://x.com/hasantoxr/status/2025902150296236050",
    "repo",
    LINES.scrapling,
    null,
  );
  assert.equal(scrapling.action_result_json.act.status, "cached");
  assert.equal(scrapling.action_result_json.act.verdict, undefined);
  assert.equal(cardVerdict(asSave(scrapling)), "Works: installed and ran in 11.3s (scrape 0.2s)");
  const loop = expectRow(
    "https://x.com/0xCodez/status/2069736449902027136",
    "paper",
    LINES.loop,
    null,
  );
  assert.equal(loop.action_result_json.act.zipUrl, "/artifacts/2069736449902027136/loop-engineering.zip");
  assert.equal(loop.action_result_json.act.status, "done");
  assert.match(loop.action_result_json.act.summary, /one-page spec/i);
  const brain = expectRow(
    "https://x.com/cyrilXBT/status/2069651792678510894",
    "idea",
    LINES.brain,
    null,
  );
  assert.equal(brain.action_result_json.act.zipUrl, "/artifacts/2069651792678510894/second-brain.zip");
  assert.equal(brain.action_result_json.act.status, "done");

  const cua = expectRow(
    "https://x.com/trycua/status/2112228154651881479",
    "repo",
    LINES.cua,
    "README cached · live install skipped (macOS Spaces app)",
  );
  assert.equal(cua.action_result_json.act.status, "cached");
  assert.equal(cua.action_result_json.act.smoke_source, "readme");
  assert.equal(cua.action_result_json.sorted.details.repo_url, "https://github.com/trycua/cua");
  assert.match(cua.action_result_json.act.stdout, /Live install skipped/);

  const wabi = expectRow(
    "https://x.com/ekuyda/status/2112212804979880239",
    "tool",
    LINES.wabi,
    "Try it: start a thread with your people",
  );
  assert.equal(wabi.action_result_json.act.status, "ok");
  assert.equal(wabi.action_result_json.act.steps.length, 3);

  const veeza = expectRow(
    "https://x.com/alymoursy/status/2112227566362992893",
    "tool",
    LINES.veeza,
    "Try it: pick a destination and let it file the visa",
  );
  assert.equal(veeza.action_result_json.sorted.details.tool_url, "https://www.veeza.ai");
  assert.deepEqual(veeza.action_result_json.act.steps, [
    "Open https://www.veeza.ai.",
    "Pick the destination.",
    "Let Veeza do the paperwork and book the appointment.",
  ]);

  const event = expectRow(
    "https://x.com/seobrien/status/2111233458081251384",
    "event",
    LINES.event,
    "All-day Oct 23, 2026 · New York, NY",
  );
  assert.equal(event.action_result_json.sorted.details.date, "2026-10-23");
  assert.equal(event.action_result_json.sorted.details.event_url, "https://luma.com/tuwo7wrd");
  assert.equal(event.action_result_json.act.all_day, true);
  assert.equal(event.action_result_json.act.location, "New York, NY");
  const ics = event.action_result_json.act.ics;
  assert.match(ics, /DTSTART;VALUE=DATE:20261023/);
  assert.match(ics, /DTEND;VALUE=DATE:20261024/);
  assert.match(ics, /LOCATION:New York\\, NY/);
  assert.match(ics, /URL:https:\/\/luma\.com\/tuwo7wrd/);
  assert.match(ics, /SUMMARY:AcceleratorCON 2026/);
  assert.doesNotMatch(ics, /DTSTART[^:\r\n]*T\d/);
  assert.doesNotMatch(ics, /DTEND[^:\r\n]*T\d/);

  const fortress = expectRow(
    "https://x.com/NextoraInsights/status/2112033075400184127",
    "tool",
    LINES.fortress,
    "Try it: point scraping agents at stealth Chromium",
  );
  assert.equal(fortress.action_result_json.act.steps[0].includes("Fortress"), true);

  const feed = await fetch(`${base}/`);
  const html = await feed.text();
  assert.match(html, /data-profile="default"/);
  assert.match(html, /Default profile/);
  for (const row of done) {
    const verdict = cardVerdict(asSave(row));
    assert.ok(verdict, row.url);
    assert.match(html, new RegExp(`data-kind="${row.kind}"`));
    assert.match(html, new RegExp(`data-verdict="${escapeRegExp(verdict)}"`));
    assert.match(html, new RegExp(escapeRegExp(row.why_you)));
    assert.match(html, new RegExp(`<span class="badge ${row.kind}">`));
  }
  const articles = [...html.matchAll(/<article class="card"[\s\S]*?<\/article>/g)].map((match) => match[0]);
  const list = await fetch(`${base}/api/saves`).then((response) => response.json());
  const restIds = list.map((row) => row.id).filter((id) => id !== scrapling.id);
  const feedIds = articles.map((card) => Number(card.match(/\/saves\/(\d+)/)[1]));
  assert.deepEqual(feedIds, [scrapling.id, ...restIds]);
  assert.match(articles[0], /Works: installed and ran in 11\.3s \(scrape 0\.2s\)/);
  assert.match(articles[0], /badge other">cached/);
  const cuaCard = articles.find((card) => card.includes(`/saves/${cua.id}`));
  assert.match(cuaCard, /README cached · live install skipped/);
  assert.doesNotMatch(cuaCard, /badge other">cached/);
  const fortressCard = articles.find((card) => card.includes(`/saves/${fortress.id}`));
  assert.match(fortressCard, /badge tool/);
  assert.match(fortressCard, /Try it: point scraping agents at stealth Chromium/);
  assert.match(fortressCard, /stealth-browser infra/);
  assert.doesNotMatch(fortressCard, /badge other">cached/);
  const cardsHtml = await fetch(`${base}/feed/cards`).then((response) => response.text());
  const cardIds = [...cardsHtml.matchAll(/<h2><a href="\/saves\/(\d+)">/g)].map((match) => Number(match[1]));
  assert.deepEqual(cardIds, feedIds);
  assert.match(html, /Works: installed and ran in 11\.3s \(scrape 0\.2s\)/);
  assert.match(html, /loop-engineering\.zip/);
  assert.match(html, /second-brain\.zip/);
  for (const zipPath of [
    "/artifacts/2069736449902027136/loop-engineering.zip",
    "/artifacts/2069651792678510894/second-brain.zip",
  ]) {
    const zip = await fetch(`${base}${zipPath}`);
    assert.equal(zip.status, 200, zipPath);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK", zipPath);
  }
  assert.doesNotMatch(html, /comes next/);
  assert.match(html, /acceleratorcon-2026\.ics/);
  assert.match(html, /href="https:\/\/www\.veeza\.ai"/);
  assert.match(html, /href="https:\/\/github\.com\/trycua\/cua"/);
  assert.match(html, /Screenshot/);
  assert.doesNotMatch(html, /bank statements/);
  assert.doesNotMatch(html, /preschool moms/);

  const cuaPage = await fetch(`${base}/saves/${cua.id}`);
  const cuaHtml = await cuaPage.text();
  assert.match(cuaHtml, /README cached, live install skipped/);
  assert.doesNotMatch(cuaHtml, /badge other">cached/);
  assert.doesNotMatch(cuaHtml, /last good run/);
  assert.doesNotMatch(cuaHtml, /2026-10-20T02:40:00/);
  assert.doesNotMatch(cuaHtml, /readme quickstart/);

  const detail = await fetch(`${base}/saves/${veeza.id}`);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /bank statements/);
  assert.match(detailHtml, /id="try-it"/);

  const calendar = await fetch(`${base}/saves/${event.id}/event.ics`);
  assert.equal(calendar.status, 200);
  assert.match(calendar.headers.get("content-type"), /text\/calendar/);
  assert.match(calendar.headers.get("content-disposition"), /acceleratorcon-2026\.ics/);
  const body = await calendar.text();
  assert.match(body, /DTSTART;VALUE=DATE:20261023/);
  assert.doesNotMatch(body, /DTSTART[^:\r\n]*T\d/);
  const committed = fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "events", "acceleratorcon-2026.ics"), "utf8");
  assert.equal(body, committed);

  for (const row of done) {
    const id = row.url.split("/").pop();
    const file = path.join(import.meta.dirname, "..", "fixtures", "seed-cache", `${id}.json`);
    if (!fs.existsSync(file)) continue;
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(row.kind, cached.kind, id);
    assert.equal(row.summary, cached.summary, id);
    assert.equal(row.why_you, cached.why_you, id);
    assert.equal(row.action_result_json.act.verdict, cached.verdict, id);
    assert.deepEqual(row.action_result_json.act, cached.act, id);
  }
});

test("badge and digest stay up with the new cards", async (t) => {
  const posts = listFixturePosts();
  assert.equal(posts.length, 8);
  const db = openDb(":memory:");
  const app = createApp(db, { offline: true, env: { BASE_URL: "https://demo.example" } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).finally(() => db.close()));

  const ids = [];
  for (const post of posts) {
    const created = await fetch(`${base}/api/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: post.url }),
    });
    assert.equal(created.status, 201, post.url);
    ids.push((await created.json()).id);
  }
  const done = [];
  for (const id of ids) done.push(await waitUntilSettled(base, id));
  const before = await fetch(`${base}/`).then((response) => response.text());
  assert.match(before, /data-profile="default"/);
  assert.match(before, /Default profile/);
  assert.doesNotMatch(before, /Profile from Grok Bot memory/);
  assert.match(before, /data-kind="event"/);
  assert.match(before, /Try it: pick a destination/);

  const put = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      startup: "desk tools",
      stack: "browser-extension pipeline",
      interests: ["local-first notes"],
    }),
  });
  assert.equal(put.status, 200);
  const stored = await put.json();
  assert.equal(stored.source, "bot");
  assert.match(stored.synced_at, /^\d{4}-\d{2}-\d{2}T/);

  const feed = await fetch(`${base}/`).then((response) => response.text());
  assert.match(feed, /data-profile="bot"/);
  assert.match(feed, /Profile from Grok Bot memory/);
  assert.match(feed, new RegExp(`data-synced="${stored.synced_at}"`));
  assert.match(feed, /data-kind="tool"/);
  assert.match(feed, /README cached/);
  assert.match(feed, /acceleratorcon-2026\.ics/);
  assert.doesNotMatch(feed, /Default profile/);

  const lines = new Map(done.map((row) => [row.url, row.why_you]));
  for (const id of ids) {
    const row = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (
      row.url.endsWith("2025902150296236050") ||
      row.url.endsWith("2069736449902027136") ||
      row.url.endsWith("2069651792678510894")
    ) {
      assert.equal(row.why_you, lines.get(row.url));
    }
  }
  assert.equal(lines.get("https://x.com/hasantoxr/status/2025902150296236050"), LINES.scrapling);
  assert.equal(lines.get("https://x.com/0xCodez/status/2069736449902027136"), LINES.loop);
  assert.equal(lines.get("https://x.com/cyrilXBT/status/2069651792678510894"), LINES.brain);

  const digest = await fetch(`${base}/api/digest`).then((response) => response.json());
  assert.equal(digest.saved, 8);
  assert.equal(digest.tried, 8);
  assert.match(digest.markdown, /You saved 8, I tried 8/);
  assert.equal(digest.top.length, 2);
  const profile = await fetch(`${base}/api/profile`).then((response) => response.json());
  assert.equal(profile.source, "bot");
  assert.equal(profile.startup, "desk tools");
});

const SCRAPLING_URL = "https://x.com/hasantoxr/status/2025902150296236050";

test("a pasted Scrapling card leads while it runs and after it finishes", async (t) => {
  const posts = listFixturePosts();
  const db = openDb(":memory:");
  const app = createApp(db, { offline: true, env: {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).finally(() => db.close()));

  const ids = [];
  for (const post of posts) {
    const created = await fetch(`${base}/api/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: post.url }),
    });
    assert.equal(created.status, 201);
    ids.push((await created.json()).id);
  }
  const done = [];
  for (const id of ids) done.push(await waitUntilSettled(base, id));
  const seeded = done.find((row) => row.url === SCRAPLING_URL);
  assert.ok(seeded);
  assert.equal(cardIds(await fetch(`${base}/`).then((response) => response.text()))[0], seeded.id);

  db.prepare("DELETE FROM saves WHERE id = ?").run(seeded.id);
  const afterDelete = cardIds(await fetch(`${base}/feed/cards`).then((response) => response.text()));
  assert.equal(afterDelete.length, 7);
  assert.equal(afterDelete.includes(seeded.id), false);

  const fresh = createSave(db, SCRAPLING_URL);
  assert.notEqual(fresh.id, seeded.id);
  updateSave(db, fresh.id, { status: "sorting", created_at: "2020-01-01T00:00:00.000Z" });
  assert.equal(cardIds(await fetch(`${base}/`).then((response) => response.text()))[0], fresh.id);
  assert.equal(cardIds(await fetch(`${base}/feed/cards`).then((response) => response.text()))[0], fresh.id);

  const finished = await runPipeline(db, fresh.id, { offline: true, env: {} });
  assert.equal(finished.status, "done");
  assert.equal(finished.kind, "repo");
  const act = JSON.parse(finished.action_result_json).act;
  assert.equal(act.exit_code, 0);
  assert.equal(act.duration_ms != null, true);
  updateSave(db, fresh.id, { created_at: "2020-01-01T00:00:00.000Z" });
  const html = await fetch(`${base}/`).then((response) => response.text());
  const idsAfter = cardIds(html);
  assert.equal(idsAfter[0], fresh.id);
  assert.equal(idsAfter.length, 8);
  assert.equal(cardIds(await fetch(`${base}/feed/cards`).then((response) => response.text()))[0], fresh.id);
  const card = html.slice(html.indexOf(`<article`), html.indexOf("</article>") + "</article>".length);
  assert.match(card, new RegExp(`/saves/${fresh.id}`));
  assert.match(card, /Works: installed and ran in 11\.3s \(scrape 0\.2s\)/);
});

test("cards truncate a long summary and still show kind, verdict, and why_you", () => {
  const summary = `${"niche consumer products from YC startups ".repeat(8)}TAILMARK`;
  const html = renderCards([
    {
      id: 4,
      author: "Ada",
      url: "https://x.com/ada/status/4",
      kind: "tool",
      status: "done",
      summary,
      why_you: "Wabi is the kind of a16z consumer product your recommender should surface to the right users.",
      text: summary,
      action_result_json: JSON.stringify({
        act: { status: "ok", verdict: "Try it: start a thread with your people", steps: ["Open Wabi and start a thread."] },
      }),
    },
  ]);
  assert.match(html, /data-kind="tool"/);
  assert.match(html, /data-verdict="Try it: start a thread with your people"/);
  assert.match(html, /class="badge tool"/);
  assert.match(html, /Why you/);
  assert.match(html, /surface to the right users/);
  assert.match(html, /#try-it/);
  assert.doesNotMatch(html, /TAILMARK/);
  assert.match(html, /…/);
});

async function waitUntilSettled(base, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`save ${id} did not settle`);
}

function cardIds(html) {
  return [...html.matchAll(/<h2><a href="\/saves\/(\d+)">/g)].map((match) => Number(match[1]));
}

function asSave(row) {
  return { ...row, action_result_json: JSON.stringify(row.action_result_json) };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
