import assert from "node:assert/strict";
import { once } from "node:events";
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
  const app = createApp(db, { offline: true, env: {} });
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
  assert.equal(done[0].why_you, null);
  assert.equal(done[0].action_result_json.act.status, "skipped");

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
  assert.match(html, /data-kind="repo"/);
  assert.match(html, /data-kind="paper"/);
  assert.match(html, /data-kind="idea"/);
  assert.match(html, /Hasan Toor/);
  assert.match(html, /github\.com\/D4Vinci\/Scrapling/);

  const detail = await fetch(`${base}/saves/${ids[0]}`);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Show last run/);
  assert.match(detailHtml, /Repo runner lands in the next step/);

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
