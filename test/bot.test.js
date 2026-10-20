import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { buildDigest, scoreSave } from "../src/digest.js";
import { createSave, openDb, updateSave } from "../src/db.js";
import { loadProfile } from "../src/profile.js";
import { whyYou } from "../src/why.js";

const profile = loadProfile();
const SCRAPE = "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.";
const LOOP = "A blueprint for running your scrape-and-recommend agents as a self-verifying loop; Saved to Shipped is one.";
const BRAIN = "Turn your saved posts, founders, and YC/a16z products into a living wiki your recommender can draw on.";
const SEEDS = [
  ["https://x.com/hasantoxr/status/2025902150296236050", SCRAPE],
  ["https://twitter.com/0xCodez/status/2069736449902027136", LOOP],
  ["https://x.com/cyrilXBT/status/2069651792678510894", BRAIN],
];
const REALISTIC = {
  startup: "the social-data recommender",
  stack: ["Node", "Express", "SQLite"],
  interests: ["consumer products", "AI agents"],
};
const HOSTILE = {
  startup: "a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups",
  stack: ["Node", "Express", "SQLite"],
  interests: ["consumer products", "AI agents"],
  building: "a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups",
  why: {
    pipeline: "Node, Express, SQLite",
    use: "ship a startup that scrapes users' social media data to recommend niche consumer products",
    agents: "consumer products, AI agents",
    reader: "a startup that scrapes users' social media data",
    memory: "consumer products, AI agents",
    focus: "a startup that scrapes users' social media data to recommend niche consumer products",
    product: "Node, Express, SQLite",
    wiki: "Node, Express, SQLite",
  },
};

test("digest counts the window, ranks by profile keywords, and writes the briefing", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const db = openDb(":memory:");
  const recent = (url) => createSave(db, url);
  const scrape = stamp(db, recent("https://x.com/a/status/1"), {
    created_at: "2026-10-19T12:00:00.000Z",
    author: "Ada",
    kind: "repo",
    text: "Scrapling scrapes social data for product recommendations.",
    summary: "A scraping pipeline.",
    why_you: "Drop-in for your social-data scraping pipeline.",
    status: "done",
    action_result_json: JSON.stringify({
      act: { status: "ok", exit_code: 0, duration_ms: 2500, repo: "https://github.com/example/scrapling" },
    }),
  });
  const wiki = stamp(db, recent("https://x.com/a/status/2"), {
    created_at: "2026-10-18T12:00:00.000Z",
    author: "Bea",
    kind: "idea",
    text: "Build a living wiki of saved posts.",
    summary: "A living wiki.",
    why_you: "Turn saved posts into a living wiki.",
    status: "done",
    action_result_json: JSON.stringify({
      act: { status: "done", type: "starter", zipUrl: "/artifacts/2/second-brain.zip", summary: "Spec ready." },
    }),
  });
  stamp(db, recent("https://x.com/a/status/3"), {
    created_at: "2026-10-17T12:00:00.000Z",
    author: "Cal",
    kind: "event",
    text: "A meetup with no overlap.",
    summary: "Unrelated meetup.",
    status: "done",
  });
  stamp(db, recent("https://x.com/a/status/4"), {
    created_at: "2026-10-01T12:00:00.000Z",
    author: "Old",
    kind: "repo",
    text: "Scrapling scrapes social data for product recommendations.",
    status: "done",
    action_result_json: JSON.stringify({ act: { status: "ok", duration_ms: 1000 } }),
  });

  const digest = buildDigest(db.prepare("SELECT * FROM saves").all(), profile, { now });
  assert.equal(digest.saved, 3);
  assert.equal(digest.tried, 2);
  assert.equal(digest.top.length, 2);
  assert.equal(digest.top[0].id, scrape.id);
  assert.equal(digest.top[1].id, wiki.id);
  assert.ok(digest.top[0].score > digest.top[1].score);
  assert.equal(digest.top[0].action, "repo run ok in 2.5s");
  assert.equal(digest.top[1].action, "spec zip /artifacts/2/second-brain.zip");
  const absolute = buildDigest(db.prepare("SELECT * FROM saves").all(), profile, {
    now,
    baseUrl: "https://demo.example/",
  });
  assert.equal(absolute.top[1].action, "spec zip https://demo.example/artifacts/2/second-brain.zip");
  assert.match(digest.markdown, /^You saved 3, I tried 2, here are the 2 worth your time\n/);
  assert.match(digest.markdown, /Ada · repo/);
  assert.match(digest.markdown, /Drop-in for your social-data scraping pipeline\./);
  assert.match(digest.markdown, /repo run ok in 2\.5s/);
  assert.match(digest.markdown, /Bea · idea/);
  assert.match(digest.markdown, /spec zip \/artifacts\/2\/second-brain\.zip/);
  assert.match(absolute.markdown, /spec zip https:\/\/demo\.example\/artifacts\/2\/second-brain\.zip/);

  const narrow = buildDigest(db.prepare("SELECT * FROM saves").all(), profile, {
    since: new Date("2026-10-19T00:00:00.000Z"),
  });
  assert.equal(narrow.saved, 1);
  assert.equal(narrow.tried, 1);
  assert.equal(narrow.top[0].id, scrape.id);

  const calendar = {
    summary: "A calendar studio for scheduling meetups.",
    building: "calendar studio",
    startup: "calendar studio",
    why: {
      focus: "calendar studio",
      pipeline: "calendar scheduling",
      use: "plan meetups",
      agents: "calendar bots",
      product: "MeetupKit",
      memory: "meetup notes",
      wiki: "calendar wiki",
      reader: "scheduler",
    },
  };
  const flipped = buildDigest(
    [
      { ...scrape, text: "Scrapling scrapes websites.", summary: "A scraper.", why_you: "" },
      {
        id: wiki.id,
        created_at: wiki.created_at,
        author: "Bea",
        kind: "idea",
        text: "Calendar scheduling meetup notes for the studio.",
        summary: "Calendar scheduling.",
        why_you: "",
        action_result_json: wiki.action_result_json,
      },
    ],
    calendar,
    { now },
  );
  assert.equal(flipped.top[0].author || flipped.top[0].title, "Bea");
  assert.ok(scoreSave(flipped.top[0], calendar) >= scoreSave({ text: "Scrapling scrapes websites." }, calendar));
  db.close();
});

test("profile round-trip, badge, and why_you follow the pushed memory", async (t) => {
  const db = openDb(":memory:");
  const prior = updateSave(db, createSave(db, "https://x.com/someone/status/9").id, {
    kind: "repo",
    text: "Scrapling scrapes websites.",
    status: "done",
    author: "Prior",
    why_you: "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
    why_you_source: "template",
  });
  const app = createApp(db, { offline: true, env: {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).finally(() => db.close()));

  const before = await fetch(`${base}/api/profile`).then((response) => response.json());
  assert.equal(before.source, "default");
  assert.equal(before.synced_at, null);
  assert.equal(before.name, "Srinikhil");
  const homeHtml = await fetch(`${base}/`).then((response) => response.text());
  assert.match(homeHtml, /data-profile="default"/);
  assert.match(homeHtml, /Default profile/);

  const pushed = {
    startup: "desk tools",
    stack: "browser-extension pipeline",
    projects: ["DeskKit"],
    interests: ["local-first notes"],
  };
  const put = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(pushed),
  });
  assert.equal(put.status, 200);
  const stored = await put.json();
  assert.equal(stored.source, "bot");
  assert.equal(stored.startup, "desk tools");
  assert.equal(stored.stack, "browser-extension pipeline");
  assert.deepEqual(stored.projects, ["DeskKit"]);
  assert.deepEqual(stored.interests, ["local-first notes"]);
  assert.equal(stored.why.pipeline, "social-data scraping pipeline");
  assert.equal(stored.why.use, "pull user posts at scale for product recommendations");
  assert.equal(stored.why.product, "Saved to Shipped");
  assert.match(stored.synced_at, /^\d{4}-\d{2}-\d{2}T/);

  const again = await fetch(`${base}/api/profile`).then((response) => response.json());
  assert.equal(again.source, "bot");
  assert.equal(again.synced_at, stored.synced_at);
  assert.equal(again.why.pipeline, profile.why.pipeline);

  const retargeted = await fetch(`${base}/api/saves/${prior.id}`).then((response) => response.json());
  assert.equal(retargeted.why_you, SCRAPE);
  assert.equal(retargeted.why_you_source, "template");

  const feed = await fetch(`${base}/`).then((response) => response.text());
  assert.match(feed, /data-profile="bot"/);
  assert.match(feed, /Profile from Grok Bot memory, synced [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC/);
  assert.doesNotMatch(feed, /synced \d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(feed, /Default profile/);

  const plain = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "startup=nope",
  });
  assert.equal(plain.status, 400);
  const broken = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(broken.status, 400);
  const arrayBody = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(["nope"]),
  });
  assert.equal(arrayBody.status, 400);
  const badStack = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stack: 12 }),
  });
  assert.equal(badStack.status, 400);
  const still = await fetch(`${base}/api/profile`).then((response) => response.json());
  assert.equal(still.startup, "desk tools");

  const created = await fetch(`${base}/api/saves`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ url: SEEDS[0][0] }),
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  const done = await waitUntilSettled(base, id);
  assert.equal(done.why_you, SCRAPE);
  assert.equal(whyYou({ kind: "repo", text: "Scrapling scrapes websites." }, again), SCRAPE);
  assert.equal(whyYou({ kind: "repo", text: "Scrapling scrapes websites." }, HOSTILE), SCRAPE);

  const digest = await fetch(`${base}/api/digest`).then((response) => response.json());
  assert.equal(digest.saved, 2);
  assert.equal(digest.tried, 1);
  assert.equal(digest.top[0].id, id);
  assert.match(digest.top[0].action, /^repo run ok in \d+(\.\d)?s$/);
  assert.match(digest.markdown, /You saved 2, I tried 1, here are the 2 worth your time/);
  assert.match(digest.markdown, /social-data scraping pipeline/);

  const badSince = await fetch(`${base}/api/digest?since=yesterday`);
  assert.equal(badSince.status, 400);

  const removed = await fetch(`${base}/api/profile`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const reset = await removed.json();
  assert.equal(reset.source, "default");
  assert.equal(reset.synced_at, null);
  assert.equal(reset.startup, undefined);
  assert.equal(reset.why.pipeline, profile.why.pipeline);
  const after = await fetch(`${base}/`).then((response) => response.text());
  assert.match(after, /data-profile="default"/);
  assert.match(after, /Default profile/);
  const grok = updateSave(db, prior.id, {
    why_you: "Grok kept this Scrapling line.",
    why_you_source: "grok",
    why_you_profile_hash: "stale",
  });
  await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(HOSTILE),
  });
  const kept = await fetch(`${base}/api/saves/${grok.id}`).then((response) => response.json());
  assert.equal(kept.why_you, "Grok kept this Scrapling line.");
  assert.equal(kept.why_you_source, "grok");
});

test("a pushed profile leaves the three seed lines untouched", async (t) => {
  const db = openDb(":memory:");
  const app = createApp(db, { offline: true, env: { BASE_URL: "https://demo.example" } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).finally(() => db.close()));

  const ids = [];
  for (const [url] of SEEDS) {
    const created = await fetch(`${base}/api/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url }),
    });
    ids.push((await created.json()).id);
  }
  const settled = [];
  for (const id of ids) settled.push(await waitUntilSettled(base, id));
  assert.deepEqual(settled.map((row) => row.why_you), [SCRAPE, LOOP, BRAIN]);

  for (const body of [REALISTIC, HOSTILE]) {
    const put = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(put.status, 200);
    const lines = [];
    for (const id of ids) {
      lines.push((await fetch(`${base}/api/saves/${id}`).then((response) => response.json())).why_you);
    }
    assert.deepEqual(lines, [SCRAPE, LOOP, BRAIN]);
  }

  assert.match(settled[0].why_you, /drop-in for your social-data scraping pipeline/i);
  const digest = await fetch(`${base}/api/digest`).then((response) => response.json());
  assert.equal(digest.saved, 3);
  assert.equal(digest.tried, 3);
  assert.match(digest.markdown, /social-data scraping pipeline/);
  assert.match(digest.markdown, /spec zip https:\/\/demo\.example\/artifacts\/2069651792678510894\/second-brain\.zip/);
  assert.doesNotMatch(digest.markdown, /spec zip \/artifacts\//);
});

function stamp(db, row, fields) {
  return updateSave(db, row.id, fields);
}

async function waitUntilSettled(base, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`save ${id} did not settle`);
}
