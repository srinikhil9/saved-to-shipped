import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";

const SEEDS = [
  ["https://x.com/hasantoxr/status/2025902150296236050", "repo"],
  ["https://twitter.com/0xCodez/status/2069736449902027136", "paper"],
  ["https://x.com/cyrilXBT/status/2069651792678510894", "idea"],
];

test("API and HTML feed sort pasted seed URLs", async (t) => {
  const db = openDb(":memory:");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-api-"));
  const app = createApp(db, { offline: true, env: {}, cacheDir });
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
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.equal(row.status, "queued");
    assert.equal(row.kind, null);
    ids.push(row.id);
  }

  const done = [];
  for (const id of ids) done.push(await waitUntilSettled(base, id));
  assert.deepEqual(done.map((row) => row.kind), ["repo", "paper", "idea"]);
  assert.equal(done[0].action_result_json.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  assert.equal(
    done[1].action_result_json.sorted.details.paper_url,
    "https://drive.google.com/file/d/1qzKI4DKnyHRpXK1J3ATPqwaqLc0iNu-M/view?usp=sharing",
  );
  assert.equal(done[0].status, "done");
  assert.equal(
    done[0].why_you,
    "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
  );
  assert.equal(
    done[1].why_you,
    "A blueprint for running your scrape-and-recommend agents as a self-verifying loop; Saved to Shipped is one.",
  );
  assert.equal(
    done[2].why_you,
    "Turn your saved posts, founders, and YC/a16z products into a living wiki your recommender can draw on.",
  );
  assert.equal(done[0].error, null);
  assert.equal(done[0].action_result_json.act.status, "cached");
  assert.equal(done[0].action_result_json.act.repo, "https://github.com/D4Vinci/Scrapling");
  assert.equal(done[0].screenshot_path, "/screenshots/scrapling-seed.png");
  assert.ok(done[0].action_result_json.act.extracted_sample.length >= 1);
  assert.equal(done[1].screenshot_path, null);

  const list = await fetch(`${base}/api/saves`).then((response) => response.json());
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((row) => row.id), [...ids].reverse());

  const one = await fetch(`${base}/api/saves/${ids[0]}`);
  assert.equal(one.status, 200);
  const body = await one.json();
  assert.equal(body.author.includes("Hasan Toor"), true);

  const feed = await fetch(`${base}/`);
  assert.equal(feed.status, 200);
  const html = await feed.text();
  assert.match(html, /Save it\. Ship it\./);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /data-upgrade="pending"/);
  assert.match(html, /data-kind="repo"/);
  assert.match(html, /data-kind="paper"/);
  assert.match(html, /data-kind="idea"/);
  assert.match(html, /Hasan Toor/);
  assert.match(html, /github\.com\/D4Vinci\/Scrapling/);
  assert.match(html, /Drop-in for your social-data scraping pipeline/);
  assert.match(html, /self-verifying loop/);
  assert.match(html, /living wiki your recommender can draw on/);

  const detail = await fetch(`${base}/saves/${ids[0]}`);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Show last run/);
  assert.doesNotMatch(detailHtml, /location\.reload/);
  assert.match(detailHtml, /Why you/);
  assert.match(detailHtml, /social-data scraping pipeline/);
  assert.match(detailHtml, /scrapling-seed\.png/);
  assert.match(detailHtml, /id="stdout"/);
  const quote = done[0].action_result_json.act.extracted_sample[0].slice(0, 24);
  assert.match(detailHtml, new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const shot = await fetch(`${base}${done[0].screenshot_path}`);
  assert.equal(shot.status, 200);
  const png = Buffer.from(await shot.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  const paper = done[1];
  const idea = done[2];
  assert.equal(paper.action_result_json.act.status, "done");
  assert.equal(paper.action_result_json.act.type, "spec");
  assert.equal(paper.action_result_json.act.source, "template");
  assert.equal(paper.action_result_json.act.cached, true);
  assert.equal(paper.action_result_json.act.zipUrl, "/artifacts/2069736449902027136/loop-engineering.zip");
  assert.equal(idea.action_result_json.act.type, "starter");
  assert.equal(idea.action_result_json.act.zipUrl, "/artifacts/2069651792678510894/second-brain.zip");
  assert.equal(idea.action_result_json.act.files.includes("INSTRUCTIONS.md"), true);
  assert.match(html, /\/artifacts\/2069736449902027136\/loop-engineering\.zip/);
  assert.match(html, /\/artifacts\/2069651792678510894\/second-brain\.zip/);
  assert.doesNotMatch(html, /data-kind="repo"[\s\S]*Download starter/);

  const paperPage = await fetch(`${base}/saves/${ids[1]}`);
  const paperHtml = await paperPage.text();
  assert.match(paperHtml, /Download starter/);
  assert.match(paperHtml, /loop\/verify\.mjs/);
  assert.match(paperHtml, /Saved to Shipped is this loop|Cached on disk/);

  const ideaPage = await fetch(`${base}/saves/${ids[2]}`);
  const ideaHtml = await ideaPage.text();
  assert.match(ideaHtml, /wiki\/index\.md/);
  assert.match(ideaHtml, /INSTRUCTIONS\.md/);

  const zip = await fetch(`${base}/artifacts/2069736449902027136/loop-engineering.zip`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get("content-type") || "", /zip/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const specPage = await fetch(`${base}/artifacts/2069651792678510894/SPEC.md`);
  assert.equal(specPage.status, 200);
  assert.match(await specPage.text(), /second brain/i);
  const missingZip = await fetch(`${base}/artifacts/nope/missing.zip`);
  assert.equal(missingZip.status, 404);

  const missing = await fetch(`${base}/api/saves/99999`);
  assert.equal(missing.status, 404);
  const missingPage = await fetch(`${base}/saves/99999`);
  assert.equal(missingPage.status, 404);

  const bad = await fetch(`${base}/api/saves`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ url: "https://example.com/not-a-post" }),
  });
  assert.equal(bad.status, 400);

  const rerun = await fetch(`${base}/api/saves/${ids[0]}/rerun`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  assert.equal(rerun.status, 200);
  assert.equal((await rerun.json()).status, "queued");
  const again = await waitUntilSettled(base, ids[0]);
  assert.equal(again.status, "done");
  assert.equal(again.kind, "repo");

  const missingRerun = await fetch(`${base}/api/saves/99999/rerun`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  assert.equal(missingRerun.status, 404);
});

async function waitUntilSettled(base, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`save ${id} did not settle`);
}
