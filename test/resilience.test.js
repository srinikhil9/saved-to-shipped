import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createSave, failStuckSaves, openDb, updateSave } from "../src/db.js";
import { sanitizedEnv } from "../src/env.js";
import { ingest, READ_FAILED } from "../src/ingest.js";

const JACK = "https://x.com/jack/status/20";

test("a successful live read is cached and replays offline", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-cache-"));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return jackFetch(url);
  };
  const post = await ingest(JACK, { cacheDir, fetchImpl, fixturesDir: emptyDir() });
  assert.match(post.text, /twttr/);
  assert.equal(fs.existsSync(path.join(cacheDir, "20.json")), true);

  let offlineCalls = 0;
  const replayed = await ingest(JACK, {
    offline: true,
    cacheDir,
    fixturesDir: emptyDir(),
    fetchImpl: async () => {
      offlineCalls += 1;
      throw new Error("fetch failed");
    },
  });
  assert.equal(offlineCalls, 0);
  assert.match(replayed.text, /twttr/);
  assert.ok(calls > 0);
});

test("run again keeps the previous card when the refetch fails", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-rerun-"));
  let online = true;
  const db = openDb(":memory:");
  const app = createApp(db, {
    env: {},
    cacheDir,
    fixturesDir: emptyDir(),
    fetchImpl: async (url) => {
      if (!online) throw new Error("fetch failed");
      return jackFetch(url);
    },
  });
  const { base, close } = await listen(app);
  t.after(close);

  const created = await postJson(base, JACK);
  assert.equal(created.status, 201);
  const first = await waitUntilSettled(base, (await created.json()).id);
  assert.equal(first.status, "done");
  assert.equal(first.kind, "other");
  assert.match(first.summary, /twttr/);

  fs.rmSync(path.join(cacheDir, "20.json"));
  online = false;
  const rerun = await fetch(`${base}/api/saves/${first.id}/rerun`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  assert.equal((await rerun.json()).status, "queued");
  const again = await waitUntilSettled(base, first.id);
  assert.equal(again.status, "done");
  assert.equal(again.kind, "other");
  assert.equal(again.summary, first.summary);
  assert.equal(again.author, first.author);
  assert.equal(again.error, null);

  const missed = await postJson(base, "https://x.com/jack/status/21");
  const failed = await waitUntilSettled(base, (await missed.json()).id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, READ_FAILED);
  const cards = await fetch(`${base}/feed/cards`).then((response) => response.text());
  assert.match(cards, /Couldn't read this post/);
  assert.doesNotMatch(cards, /Fetching post/);
});

test("server startup marks stuck cards failed and leaves finished cards", () => {
  const db = openDb(":memory:");
  const queued = createSave(db, "https://x.com/a/status/1");
  const sorting = createSave(db, "https://x.com/a/status/2");
  updateSave(db, sorting.id, { status: "sorting" });
  const acting = createSave(db, "https://x.com/a/status/3");
  updateSave(db, acting.id, { status: "acting", kind: "idea" });
  const done = createSave(db, "https://x.com/a/status/4");
  updateSave(db, done.id, { status: "done", kind: "paper", summary: "kept" });

  assert.equal(failStuckSaves(db), 3);
  assert.equal(getStatus(db, queued.id), "failed");
  assert.equal(getStatus(db, sorting.id), "failed");
  assert.equal(getStatus(db, acting.id), "failed");
  const finished = db.prepare("SELECT status, kind, summary FROM saves WHERE id = ?").get(done.id);
  assert.deepEqual(finished, { status: "done", kind: "paper", summary: "kept" });
  db.close();
});

test("pasting the same link twice returns the existing card", async (t) => {
  const db = openDb(":memory:");
  const app = createApp(db, { offline: true, env: {} });
  const { base, close } = await listen(app);
  t.after(close);
  const url = "https://x.com/hasantoxr/status/2025902150296236050";
  const first = await postJson(base, url);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const second = await postJson(base, "https://twitter.com/hasantoxr/status/2025902150296236050");
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.id, firstBody.id);
  const list = await fetch(`${base}/api/saves`).then((response) => response.json());
  assert.equal(list.length, 1);
});

test("a seed card is sorted from the fixture while live fetch is still pending", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-slow-"));
  let rejectLive = () => {};
  const live = new Promise((_, reject) => {
    rejectLive = reject;
  });
  const db = openDb(":memory:");
  const app = createApp(db, {
    env: {},
    cacheDir,
    fetchImpl: () => live,
  });
  const { base, close } = await listen(app);
  t.after(async () => {
    rejectLive(new Error("stopped"));
    await close();
  });
  const started = Date.now();
  const created = await postJson(base, "https://x.com/hasantoxr/status/2025902150296236050");
  const row = await waitUntilSettled(base, (await created.json()).id);
  assert.equal(row.status, "done");
  assert.equal(row.kind, "repo");
  assert.ok(Date.now() - started < 1500);
});

test("sanitized env keeps PATH and drops API keys", () => {
  const env = sanitizedEnv({
    PATH: "/usr/bin",
    HOME: "/home/demo",
    LANG: "en_US.UTF-8",
    XAI_API_KEY: "secret-xai",
    OPENAI_API_KEY: "secret-openai",
    AWS_SECRET_ACCESS_KEY: "secret-aws",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/demo");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(JSON.stringify(env).includes("secret"), false);
  assert.equal(env.XAI_API_KEY, undefined);
});

function jackFetch(url) {
  if (url === "https://api.fxtwitter.com/status/20") {
    return {
      ok: true,
      json: async () => ({
        tweet: {
          id: "20",
          text: "just setting up my twttr",
          author: { name: "Jack", screen_name: "jack" },
          raw_text: { facets: [] },
        },
      }),
      text: async () => "",
    };
  }
  if (url === "https://x.com/jack/status/20") {
    return { ok: true, text: async () => "<html></html>" };
  }
  throw new Error(`unexpected ${url}`);
}

function emptyDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "saves-empty-"));
}

function getStatus(db, id) {
  return db.prepare("SELECT status FROM saves WHERE id = ?").get(id).status;
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function postJson(base, url) {
  return fetch(`${base}/api/saves`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ url }),
  });
}

async function waitUntilSettled(base, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`save ${id} did not settle`);
}
