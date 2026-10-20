import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classify } from "../src/classify.js";
import { createSave, openDb } from "../src/db.js";
import { combinedText, ingest } from "../src/ingest.js";
import { loadProfile } from "../src/profile.js";
import { cacheKey, fallbackWhyYou, relate, relateAndStore, writeWhyYou } from "../src/relate.js";

const SEEDS = [
  {
    url: "https://x.com/hasantoxr/status/2025902150296236050",
    kind: "repo",
    phrase: /drop-in for the scraping pipeline/,
  },
  {
    url: "https://x.com/0xCodez/status/2069736449902027136",
    kind: "paper",
    phrase: /agent and scrape loops/,
    also: /Saved to Shipped is itself one of those loops/,
  },
  {
    url: "https://x.com/cyrilXBT/status/2069651792678510894",
    kind: "idea",
    phrase: /knowledge base of products, founders, and user signals/,
  },
];

function offlineFetch() {
  return async () => {
    throw new Error("offline");
  };
}

async function seedSave(url) {
  const post = await ingest(url, { offline: true, fetchImpl: offlineFetch() });
  const sorted = await classify({ text: combinedText(post), links: post.links || [] }, { env: {} });
  return {
    id: post.id,
    url: post.url,
    author: post.author,
    text: combinedText(post),
    kind: sorted.kind,
    summary: sorted.summary,
  };
}

test("fallback why_you for the three seeds with no API key", async () => {
  const profile = loadProfile();
  for (const seed of SEEDS) {
    const save = await seedSave(seed.url);
    assert.equal(save.kind, seed.kind, seed.url);
    const whyYou = await relate(save, profile, { env: {}, cache: false });
    assert.match(whyYou, seed.phrase, whyYou);
    if (seed.also) assert.match(whyYou, seed.also, whyYou);
    assert.ok(whyYou.split(/(?<=[.!?])\s+/).length <= 2, whyYou);
    let calls = 0;
    const ignored = await relate(save, profile, {
      env: { LLM_API_KEY: "not-the-grok-key" },
      cache: false,
      fetchImpl: () => {
        calls += 1;
        throw new Error("LLM_API_KEY must not call the model");
      },
    });
    assert.equal(calls, 0);
    assert.equal(ignored, whyYou);
    const quiet = fallbackWhyYou(save, profile);
    assert.equal(quiet, whyYou);
  }
});

test("keyword fallback stays specific for other kinds and a mismatched profile", async () => {
  const profile = loadProfile();
  const tool = fallbackWhyYou(
    {
      id: "tool-1",
      url: "https://x.com/a/status/1",
      kind: "tool",
      text: "A small tool listing a16z consumer product recommendations.",
      summary: "A tool for a16z consumer product recommendations.",
    },
    profile,
  );
  assert.match(tool, /a16z/);
  assert.match(tool, /Try the tool on that work/);
  assert.doesNotMatch(tool, /drop-in for the scraping pipeline/);

  const event = fallbackWhyYou(
    {
      id: "event-1",
      url: "https://x.com/a/status/2",
      kind: "event",
      text: "RSVP for the YC meetup on consumer products this Friday.",
      summary: "YC meetup",
    },
    profile,
  );
  assert.match(event, /\bYC\b/);
  assert.match(event, /Put the event on the calendar/);

  const repo = fallbackWhyYou(
    {
      id: "repo-1",
      url: "https://x.com/a/status/3",
      kind: "repo",
      text: "Check https://github.com/acme/widget for a tiny CLI.",
      summary: "A tiny CLI.",
    },
    profile,
  );
  assert.match(repo, /widget/);
  assert.match(repo, /while you build/);
  assert.doesNotMatch(repo, /drop-in for the scraping pipeline/);

  const music = fallbackWhyYou(await seedSave(SEEDS[0].url), {
    name: "Sam",
    summary: "Sam writes jazz piano lessons.",
    building: "jazz piano lessons",
  });
  assert.match(music, /Scrapling/);
  assert.match(music, /jazz piano/);
  assert.doesNotMatch(music, /drop-in for the scraping pipeline/);
});

test("profile shapes are read defensively", async () => {
  const save = await seedSave(SEEDS[0].url);
  const shapes = [
    loadProfile(),
    "Srinikhil is building a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups.",
    { bio: "scrapes users' social media data to recommend niche consumer products from YC and a16z startups" },
    { user: { name: "Srinikhil" }, description: "scrapes social media data to recommend consumer products from YC and a16z" },
    { interests: "scraping, social data, agents", building: "a startup that scrapes users' social media data to recommend products from YC and a16z" },
    { profile: { summary: "scrapes social media to recommend products from YC and a16z" } },
  ];
  for (const shape of shapes) {
    const whyYou = fallbackWhyYou(save, shape);
    assert.match(whyYou, /drop-in for the scraping pipeline/, JSON.stringify(shape));
  }
});

test("cache key is save id, url, and profile hash, and replay skips the network", async () => {
  const profile = loadProfile();
  const save = await seedSave(SEEDS[1].url);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relate-")), "cache.json");
  const first = await relate(save, profile, { env: {}, cachePath: file });
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = cacheKey(save, profile);
  assert.equal(stored.entries[key].text, first);
  assert.equal(stored.entries[key].source, "fallback");

  stored.entries[key] = { text: "CACHED SENTINEL", source: "fallback" };
  fs.writeFileSync(file, JSON.stringify(stored));
  const replay = await relate(save, profile, { env: {}, cachePath: file });
  assert.equal(replay, "CACHED SENTINEL");

  const otherId = cacheKey({ ...save, id: "other" }, profile);
  assert.notEqual(otherId, key);
  const reordered = cacheKey(save, { ...profile, interests: [...profile.interests].reverse() });
  assert.equal(reordered, key);
  const renamed = cacheKey(save, { ...profile, summary: `${profile.summary} extra` });
  assert.notEqual(renamed, key);

  stored.entries[key] = { text: "LLM LINE FROM LAST RUN", source: "llm" };
  fs.writeFileSync(file, JSON.stringify(stored));
  let calls = 0;
  const offline = await relate(save, profile, {
    env: { XAI_API_KEY: "present-but-offline", LLM_API_KEY: "ignored" },
    cachePath: file,
    fetchImpl: () => {
      calls += 1;
      throw new Error("network down");
    },
  });
  assert.equal(offline, "LLM LINE FROM LAST RUN");
  assert.equal(calls, 0);
});

test("Grok is used only when XAI_API_KEY is set, and errors fall back", async () => {
  const profile = loadProfile();
  const save = await seedSave(SEEDS[0].url);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relate-llm-")), "cache.json");
  let seen = null;
  const llm = await relate(save, profile, {
    env: { XAI_API_KEY: "xai-test", LLM_API_KEY: "ignored" },
    cachePath: file,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Why you: Scrapling slots straight into the scrape loop you already run for product picks." } }],
        }),
      };
    },
  });
  assert.equal(llm, "Scrapling slots straight into the scrape loop you already run for product picks.");
  assert.equal(seen.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer xai-test");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "grok-4.7");
  assert.equal(body.temperature, 0);
  assert.equal(body.reasoning_effort, "low");

  const override = await relate({ ...save, id: "override" }, profile, {
    env: { XAI_API_KEY: "xai-test", XAI_BASE_URL: "https://llm.test/v1", XAI_MODEL: "grok-test" },
    cache: false,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Override line for the scraping pipeline you already run." } }] }),
      };
    },
  });
  assert.equal(seen.url, "https://llm.test/v1/chat/completions");
  assert.equal(JSON.parse(seen.init.body).model, "grok-test");
  assert.match(override, /Override line/);

  const cached = await relate(save, profile, {
    env: { XAI_API_KEY: "xai-test" },
    cachePath: file,
    fetchImpl: () => {
      throw new Error("should have replayed");
    },
  });
  assert.equal(cached, llm);

  const broken = await relate(save, { ...profile, summary: "scrapes social data for products from YC and a16z" }, {
    env: { XAI_API_KEY: "xai-test" },
    cache: false,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.match(broken, /drop-in for the scraping pipeline/);

  const started = Date.now();
  const slow = await relate(save, profile, {
    env: { XAI_API_KEY: "xai-test" },
    cache: false,
    timeoutMs: 40,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.match(slow, /drop-in for the scraping pipeline/);
  assert.ok(Date.now() - started < 1000);
});

test("writeWhyYou and relateAndStore fill saves.why_you", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, "https://x.com/hasantoxr/status/2025902150296236050");
  const save = await seedSave(SEEDS[0].url);
  const stored = await relateAndStore(db, { ...save, id: row.id }, loadProfile(), { env: {}, cache: false });
  assert.match(stored.why_you, /drop-in for the scraping pipeline/);
  const replaced = writeWhyYou(db, row.id, "Hand written.");
  assert.equal(replaced.why_you, "Hand written.");
  db.close();
});
