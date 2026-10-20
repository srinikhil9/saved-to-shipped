import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import test from "node:test";
import { createSave, getSave, openDb, updateSave } from "../src/db.js";
import { loadProfile } from "../src/profile.js";
import { runPipeline } from "../src/pipeline.js";
import { backfillWhyYou, refreshWhyYou, whyCacheKey, whyYou } from "../src/why.js";

const profile = loadProfile();
const LOOP = "A blueprint for running your scrape-and-recommend agents as a self-verifying loop; Saved to Shipped is one.";
const BRAIN = "Turn your saved posts, founders, and YC/a16z products into a living wiki your recommender can draw on.";
const SCRAPE = "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.";
const GROK_LINE = "Scrapling slots straight into the scrape loop you already run for product picks.";

const FIXTURES = {
  scrapling: JSON.parse(fs.readFileSync(new URL("../fixtures/2025902150296236050.json", import.meta.url))),
  loop: JSON.parse(fs.readFileSync(new URL("../fixtures/2069736449902027136.json", import.meta.url))),
  brain: JSON.parse(fs.readFileSync(new URL("../fixtures/2069651792678510894.json", import.meta.url))),
};

const llm = { apiKey: "xai-test", baseUrl: "https://api.x.ai/v1", model: "grok-4.7" };

test("keyword hits use the profile slots for the three seed shapes", () => {
  assert.equal(whyYou({ kind: "repo", text: "Scrapling scrapes websites with Python." }, profile), SCRAPE);
  assert.equal(whyYou({ kind: "paper", text: "Loop Engineering for agentic systems." }, profile), LOOP);
  assert.equal(whyYou({ kind: "idea", text: "Karpathy's second brain is a living wiki." }, profile), BRAIN);
});

test("each seed keeps its stage line when sorted as another likely kind", () => {
  assert.equal(whyYou({ kind: "tool", text: FIXTURES.scrapling.text }, profile), SCRAPE);
  assert.equal(whyYou({ kind: "idea", text: FIXTURES.loop.text, summary: "An idea about loops." }, profile), LOOP);
  assert.equal(whyYou({ kind: "paper", text: FIXTURES.brain.text }, profile), BRAIN);
  assert.equal(whyYou({ kind: "other", text: FIXTURES.brain.text }, profile), BRAIN);
});

test("fallback lines stay short and do not paste the profile sentence", () => {
  const line = whyYou({ kind: "event", text: "RSVP for the meetup." }, profile);
  assert.equal(line, "An event for people building your social-data recommender.");
  assert.equal(line.includes("\n"), false);
  assert.ok(line.length < 80);
  assert.equal(line.includes(profile.building), false);

  const tool = whyYou({ kind: "tool", text: "A calendar app." }, { ...profile, building: profile.building });
  assert.equal(tool, "A tool to put in front of your social-data recommender.");
  assert.equal(tool.includes("niche consumer products"), false);
});

test("backfill writes why_you only for rows that already have a kind and an empty line", () => {
  const db = openDb(":memory:");
  const empty = createSave(db, "https://x.com/a/status/1");
  const ready = createSave(db, "https://x.com/a/status/2");
  updateSave(db, ready.id, { kind: "tool", text: "pip install scrapling and scrape", status: "done" });
  const filled = updateSave(db, createSave(db, "https://x.com/a/status/3").id, {
    kind: "other",
    why_you: "already set",
    status: "done",
  });

  assert.equal(backfillWhyYou(db, profile), 1);
  assert.equal(db.prepare("SELECT why_you FROM saves WHERE id = ?").get(empty.id).why_you, null);
  assert.match(db.prepare("SELECT why_you FROM saves WHERE id = ?").get(ready.id).why_you, /scraping pipeline/);
  assert.equal(db.prepare("SELECT why_you FROM saves WHERE id = ?").get(filled.id).why_you, "already set");
  assert.equal(backfillWhyYou(db, profile), 0);
  db.close();
});

test("Grok success replaces the template, then a replay does not call again", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, FIXTURES.scrapling.url);
  updateSave(db, row.id, { kind: "repo", text: FIXTURES.scrapling.text, summary: "Scrapling scrapes.", status: "done" });
  const save = getSave(db, row.id);
  let seen = null;
  const updated = await refreshWhyYou(db, row.id, save, profile, {
    llm,
    whyFetch: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: `Why you: ${GROK_LINE}` } }] }),
      };
    },
  });
  assert.equal(updated.why_you, GROK_LINE);
  assert.equal(updated.why_you_source, "grok");
  assert.equal(updated.why_you_profile_hash, whyCacheKey(profile, save));
  assert.equal(seen.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer xai-test");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "grok-4.7");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.temperature, 0);
  assert.match(body.messages[1].content, /social media data/);
  assert.match(body.messages[1].content, /Scrapling scrapes/);

  let calls = 0;
  const replay = await refreshWhyYou(db, row.id, save, profile, {
    offline: true,
    llm,
    whyFetch: () => {
      calls += 1;
      throw new Error("cached grok line should not call");
    },
  });
  assert.equal(calls, 0);
  assert.equal(replay.why_you, GROK_LINE);
  db.close();
});

test("a Grok timeout or error leaves the template line", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, FIXTURES.scrapling.url);
  const save = {
    id: row.id,
    kind: "repo",
    text: FIXTURES.scrapling.text,
    summary: "Scrapling scrapes.",
  };
  updateSave(db, row.id, { kind: "repo", text: save.text, summary: save.summary, status: "done", why_you: SCRAPE, why_you_source: "template" });

  const started = Date.now();
  const timedOut = await refreshWhyYou(db, row.id, save, profile, {
    llm,
    whyTimeoutMs: 40,
    whyFetch: () => new Promise(() => {}),
  });
  assert.equal(timedOut.why_you, SCRAPE);
  assert.equal(timedOut.why_you_source, "template");
  assert.ok(Date.now() - started < 1000);

  const broken = await refreshWhyYou(db, row.id, save, profile, {
    llm,
    whyFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(broken.why_you, SCRAPE);
  assert.equal(broken.why_you_source, "template");
  db.close();
});

test("no key keeps the template, and Grok sorting still stores that line before the model answers", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, FIXTURES.loop.url);
  let whyCalls = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const done = await runPipeline(db, row.id, {
    offline: true,
    profile,
    llm,
    llmFetch: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "idea",
                summary: "Loop Engineering, read as an idea.",
                repo_url: null,
                paper_url: null,
                tool_url: null,
                date: null,
              }),
            },
          },
        ],
      }),
    }),
    whyFetch: async () => {
      whyCalls += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Grok: run the scrape-and-recommend agents as one loop." } }],
        }),
      };
    },
  });
  assert.equal(done.kind, "idea");
  assert.equal(done.status, "done");
  assert.equal(done.why_you, LOOP);
  assert.equal(done.why_you_source, "pending");
  assert.ok(whyCalls >= 1);
  release();
  const replaced = await waitForSource(db, row.id, "grok");
  assert.match(replaced.why_you, /Grok: run the scrape-and-recommend agents/);

  const quiet = createSave(db, FIXTURES.brain.url);
  let calls = 0;
  const templateOnly = await runPipeline(db, quiet.id, {
    offline: true,
    profile,
    llm: { apiKey: "", baseUrl: "https://api.x.ai/v1", model: "grok-4.7" },
    llmFetch: () => {
      calls += 1;
      throw new Error("no key should not sort with Grok");
    },
    whyFetch: () => {
      calls += 1;
      throw new Error("no key should not write why_you with Grok");
    },
  });
  assert.equal(calls, 0);
  assert.equal(templateOnly.kind, "idea");
  assert.equal(templateOnly.why_you, BRAIN);
  assert.equal(templateOnly.why_you_source, "template");
  db.close();
});

test("a changed kind or summary does not reuse the cached Grok line", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, FIXTURES.loop.url);
  const first = { id: row.id, kind: "paper", text: FIXTURES.loop.text, summary: "Loop paper." };
  updateSave(db, row.id, { ...first, status: "done" });
  await refreshWhyYou(db, row.id, first, profile, {
    llm,
    whyFetch: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "First Grok line for the loop paper you saved." } }] }),
    }),
  });
  let calls = 0;
  const next = { ...first, kind: "idea", summary: "Loop idea." };
  const again = await refreshWhyYou(db, row.id, next, profile, {
    llm,
    whyFetch: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Second Grok line after the kind changed." } }] }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(again.why_you, "Second Grok line after the kind changed.");
  assert.notEqual(again.why_you_profile_hash, whyCacheKey(profile, first));
  db.close();
});

test("a stalled Grok connection leaves the card done with the template line", async () => {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const db = openDb(":memory:");
  const row = createSave(db, FIXTURES.scrapling.url);
  const started = Date.now();
  const pending = runPipeline(db, row.id, {
    offline: false,
    fetchImpl: async () => {
      throw new Error("x down");
    },
    profile,
    llm: { apiKey: "stalled-key", baseUrl: `http://127.0.0.1:${port}/v1`, model: "grok-4.7" },
    awaitLive: true,
    awaitWhy: true,
  });
  const done = await waitFor(db, row.id, (save) => save.status === "done");
  assert.ok(Date.now() - started < 2000);
  assert.equal(done.kind, "repo");
  assert.equal(done.why_you, SCRAPE);
  assert.notEqual(done.status, "sorting");
  assert.ok(sockets.length >= 1);

  const settled = await pending;
  assert.ok(Date.now() - started < 12000);
  assert.equal(settled.status, "done");
  assert.equal(settled.why_you, SCRAPE);
  assert.notEqual(settled.why_you_source, "pending");
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function waitFor(db, id, ready) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const row = getSave(db, id);
      if (row && ready(row)) return resolve(row);
      if (Date.now() - started > 2000) return reject(new Error(`save ${id} stayed ${row?.status}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function waitForSource(db, id, source) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const row = getSave(db, id);
      if (row?.why_you_source === source) return resolve(row);
      if (Date.now() - started > 1000) return reject(new Error(`why_you_source stayed ${row?.why_you_source}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
