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
  const rerunning = createSave(db, "https://x.com/a/status/5");
  updateSave(db, rerunning.id, {
    status: "sorting",
    author: "Hasan",
    kind: "repo",
    summary: "kept",
    action_result_json: JSON.stringify({
      sorted: { source: "heuristic", upgrade: "pending", details: { repo_url: "https://github.com/D4Vinci/Scrapling" } },
      act: { status: "skipped" },
    }),
  });
  const upgrading = createSave(db, "https://x.com/a/status/6");
  updateSave(db, upgrading.id, {
    status: "done",
    kind: "idea",
    summary: "still here",
    action_result_json: JSON.stringify({ sorted: { source: "heuristic", upgrade: "pending" }, act: { status: "skipped" } }),
  });

  assert.deepEqual(failStuckSaves(db), { failed: 3, restored: 1, cleared: 1, total: 4 });
  assert.equal(getStatus(db, queued.id), "failed");
  assert.equal(getStatus(db, sorting.id), "failed");
  assert.equal(getStatus(db, acting.id), "failed");
  const finished = db.prepare("SELECT status, kind, summary FROM saves WHERE id = ?").get(done.id);
  assert.deepEqual(finished, { status: "done", kind: "paper", summary: "kept" });
  const restored = db.prepare("SELECT status, kind, summary, author, error, action_result_json FROM saves WHERE id = ?").get(rerunning.id);
  assert.equal(restored.status, "done");
  assert.equal(restored.kind, "repo");
  assert.equal(restored.summary, "kept");
  assert.equal(restored.author, "Hasan");
  assert.equal(restored.error, null);
  assert.equal(JSON.parse(restored.action_result_json).sorted.upgrade, null);
  const cleared = db.prepare("SELECT status, summary, action_result_json FROM saves WHERE id = ?").get(upgrading.id);
  assert.equal(cleared.status, "done");
  assert.equal(cleared.summary, "still here");
  assert.equal(JSON.parse(cleared.action_result_json).sorted.upgrade, null);
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

test("a slow Grok call saves the heuristic first and the live refresh does not call Grok again", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-grok-"));
  const url = "https://x.com/hasantoxr/status/2025902150296236050";
  let grokCalls = 0;
  let releaseGrok = () => {};
  let grok = armGrok((release) => {
    releaseGrok = release;
  });
  let releaseLive = () => {};
  const liveGate = new Promise((resolve) => {
    releaseLive = resolve;
  });
  const db = openDb(":memory:");
  const app = createApp(db, {
    env: { XAI_API_KEY: "test-key" },
    cacheDir,
    runRepo: instantRepoRun(),
    fetchImpl: async (url) => {
      await liveGate;
      return liveScrapling(url);
    },
    llmFetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!body.response_format) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "Scrapling fits the scrape you already run for product picks." } }],
          }),
        };
      }
      grokCalls += 1;
      assert.equal(body.reasoning_effort, "low");
      assert.equal(body.temperature, 0);
      assert.deepEqual(body.response_format, { type: "json_object" });
      await grok;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "tool",
                  summary: "Grok calls Scrapling a tool.",
                  repo_url: "https://github.com/D4Vinci/Scrapling",
                  paper_url: null,
                  tool_url: null,
                  date: null,
                }),
              },
            },
          ],
        }),
      };
    },
  });
  const { base, close } = await listen(app);
  t.after(async () => {
    releaseLive();
    releaseGrok();
    await close();
  });

  const started = Date.now();
  const created = await postJson(base, url);
  const id = (await created.json()).id;
  const first = await waitUntil(base, id, (row) => row.status === "done" && row.action_result_json.sorted.upgrade === "pending");
  assert.equal(first.kind, "repo");
  assert.equal(first.action_result_json.sorted.source, "heuristic");
  assert.equal(first.action_result_json.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  assert.ok(Date.now() - started < 1500);

  releaseLive();
  const refreshed = await waitUntil(base, id, (row) => String(row.author || "").includes("Live"));
  assert.equal(grokCalls, 1);
  assert.equal(refreshed.action_result_json.sorted.source, "heuristic");
  const detail = await fetch(`${base}/saves/${id}`).then((response) => response.text());
  assert.match(detail, /location\.reload/);
  assert.doesNotMatch(detail, /http-equiv="refresh"/);
  const cards = await fetch(`${base}/feed/cards`).then((response) => response.text());
  assert.match(cards, /data-upgrade="pending"/);

  releaseGrok();
  const upgraded = await waitUntil(base, id, (row) => row.action_result_json.sorted.source === "llm");
  assert.equal(upgraded.kind, "tool");
  assert.equal(upgraded.summary, "Grok calls Scrapling a tool.");
  assert.equal(upgraded.action_result_json.sorted.upgrade, "done");
  assert.equal(upgraded.action_result_json.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  assert.equal(grokCalls, 1);
  const quiet = await fetch(`${base}/saves/${id}`).then((response) => response.text());
  assert.doesNotMatch(quiet, /location\.reload/);

  grok = armGrok((release) => {
    releaseGrok = release;
  });
  const rerun = await fetch(`${base}/api/saves/${id}/rerun`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  assert.equal((await rerun.json()).status, "queued");
  const queuedPage = await fetch(`${base}/saves/${id}`).then((response) => response.text());
  assert.match(queuedPage, /location\.reload/);
  releaseGrok();
  const again = await waitUntil(base, id, (row) => row.status === "done" && row.action_result_json.sorted.source === "llm");
  assert.equal(grokCalls, 2);
  assert.equal(again.kind, "tool");
});

test("live refresh keeps Scrapling as a repo when x.com returns no reply", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-noreply-"));
  const url = "https://x.com/hasantoxr/status/2025902150296236050";
  let releaseLive = () => {};
  const liveGate = new Promise((resolve) => {
    releaseLive = resolve;
  });
  let sawStatusPage = false;
  const db = openDb(":memory:");
  const app = createApp(db, {
    env: {},
    cacheDir,
    runRepo: instantRepoRun(),
    fetchImpl: async (target) => {
      await liveGate;
      const href = String(target);
      if (href === "https://api.fxtwitter.com/status/2025902150296236050") {
        return {
          ok: true,
          json: async () => ({
            tweet: {
              id: "2025902150296236050",
              text: "Scrapling without the reply. pip install scrapling",
              author: { name: "Hasan Live", screen_name: "hasantoxr" },
            },
          }),
        };
      }
      if (href.startsWith("https://x.com/") || href.startsWith("https://twitter.com/")) {
        sawStatusPage = true;
        return { ok: true, text: async () => "" };
      }
      throw new Error(`unexpected ${href}`);
    },
  });
  const { base, close } = await listen(app);
  t.after(async () => {
    releaseLive();
    await close();
  });

  const created = await postJson(base, url);
  const id = (await created.json()).id;
  const first = await waitUntilSettled(base, id);
  assert.equal(first.kind, "repo");
  assert.equal(first.action_result_json.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");

  releaseLive();
  const refreshed = await waitUntil(
    base,
    id,
    (row) => String(row.author || "").includes("Live") && row.status === "done",
  );
  assert.equal(sawStatusPage, true);
  assert.equal(refreshed.status, "done");
  assert.equal(refreshed.kind, "repo");
  assert.equal(refreshed.action_result_json.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  assert.equal(refreshed.action_result_json.act.repo_url, "https://github.com/D4Vinci/Scrapling");
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

function instantRepoRun() {
  return async () => ({
    error: null,
    warning: null,
    stdout: "ran",
    screenshot_path: "/screenshots/scrapling-seed.png",
    action_result_json: {
      stdout: "ran",
      timestamp: "2026-10-20T02:20:00.000Z",
      repo: "https://github.com/D4Vinci/Scrapling",
    },
  });
}

function armGrok(capture) {
  return new Promise((resolve) => {
    capture(resolve);
  });
}

function liveScrapling(url) {
  const target = String(url);
  if (target === "https://api.fxtwitter.com/status/2025902150296236050") {
    return {
      ok: true,
      json: async () => ({
        tweet: {
          id: "2025902150296236050",
          text: "Scrapling live refresh text for the card.",
          author: { name: "Hasan Toor Live", screen_name: "hasantoxr" },
          url: "https://x.com/hasantoxr/status/2025902150296236050",
        },
      }),
      text: async () => "",
    };
  }
  if (target === "https://x.com/hasantoxr/status/2025902150296236050") {
    return { ok: true, text: async () => `<a href="/hasantoxr/status/2025902162409316607">reply</a>` };
  }
  if (target === "https://api.fxtwitter.com/status/2025902162409316607") {
    return {
      ok: true,
      json: async () => ({
        tweet: {
          id: "2025902162409316607",
          text: "Link: https://github.com/D4Vinci/Scrapling",
          author: { name: "Hasan Toor Live", screen_name: "hasantoxr" },
          replying_to_status: "2025902150296236050",
        },
      }),
      text: async () => "",
    };
  }
  throw new Error(`unexpected ${target}`);
}

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
  return waitUntil(base, id, (body) => body.status === "done" || body.status === "failed");
}

async function waitUntil(base, id, ready) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await fetch(`${base}/api/saves/${id}`).then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`save ${id} did not settle`);
}
