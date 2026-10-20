import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actOnRepo } from "../src/act.js";
import { createSave, openDb, updateSave } from "../src/db.js";
import { runPipeline } from "../src/pipeline.js";

const URL = "https://x.com/hasantoxr/status/2025902150296236050";

test("a screenshot failure does not fail the run", async () => {
  const action = await actOnRepo(
    { id: 7, details: { repo_url: "https://github.com/D4Vinci/Scrapling" } },
    {
      repoMode: "live",
      demoBudgetMs: 1000,
      runRepo: async (opts) => {
        assert.equal(opts.deadlineMs, 1000);
        return {
          error: null,
          warning: "screenshot failed: executable doesn't exist",
          stdout: "['a real quote']",
          screenshot_path: null,
          action_result_json: {
            repo: "https://github.com/D4Vinci/Scrapling",
            stdout: "['a real quote']",
            extracted_sample: ["a real quote"],
            exit_code: 0,
            timestamp: "2026-10-20T00:00:00.000Z",
          },
        };
      },
    },
  );
  assert.equal(action.status, "ok");
  assert.equal(action.error, null);
  assert.match(action.warning, /screenshot failed/);
  assert.match(action.stdout, /a real quote/);
});

test("a failed rerun keeps the last good run and labels the fallback", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, URL);
  const first = await runPipeline(db, row.id, { offline: true, llm: { apiKey: "" } });
  assert.equal(first.status, "done");
  assert.equal(first.screenshot_path, "/screenshots/scrapling-seed.png");
  const goodStdout = JSON.parse(first.action_result_json).act.stdout;
  assert.ok(goodStdout.includes("quotes.toscrape") || goodStdout.includes("The world"));

  const again = await runPipeline(db, row.id, {
    offline: false,
    forceLive: true,
    llm: { apiKey: "" },
    fetchImpl: async () => {
      throw new Error("wifi down");
    },
    runRepo: async () => ({
      error: "clone timed out",
      warning: null,
      stdout: "",
      screenshot_path: null,
      action_result_json: { timestamp: "2026-10-20T01:00:00.000Z", stdout: "" },
    }),
  });

  assert.equal(again.status, "done");
  assert.equal(again.error, null);
  assert.equal(again.screenshot_path, first.screenshot_path);
  const act = JSON.parse(again.action_result_json).act;
  assert.equal(act.status, "cached");
  assert.equal(act.stdout, goodStdout);
  assert.equal(act.attempt_error, "clone timed out");
  assert.match(act.fallback_note, /^showing last good run from /);
  db.close();
});

test("a failed live run keeps the row's newer run ahead of the committed fixture", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, URL);
  const seeded = await runPipeline(db, row.id, { offline: true, llm: { apiKey: "" } });
  const fixture = JSON.parse(seeded.action_result_json);
  const liveStdout = "live scrape at 02:20 from quotes.toscrape.com";
  const liveTs = "2026-10-20T02:20:00.000Z";
  fixture.act = {
    ...fixture.act,
    status: "ok",
    stdout: liveStdout,
    timestamp: liveTs,
    screenshot_path: seeded.screenshot_path,
  };
  updateSave(db, row.id, {
    status: "done",
    action_result_json: JSON.stringify(fixture),
    screenshot_path: seeded.screenshot_path,
  });

  let runs = 0;
  const again = await runPipeline(db, row.id, {
    offline: false,
    awaitLive: true,
    llm: { apiKey: "" },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "saves-order-")),
    fetchImpl: scraplingLiveFetch,
    runRepo: async () => {
      runs += 1;
      return {
        error: "exceeded demo time budget of 1ms",
        warning: null,
        stdout: "",
        screenshot_path: null,
        action_result_json: { timestamp: "2026-10-20T02:21:00.000Z", stdout: "" },
      };
    },
  });

  assert.equal(runs, 1);
  assert.equal(again.status, "done");
  assert.equal(again.error, null);
  assert.equal(again.screenshot_path, seeded.screenshot_path);
  const act = JSON.parse(again.action_result_json).act;
  assert.equal(act.stdout, liveStdout);
  assert.equal(act.timestamp, liveTs);
  assert.equal(act.attempt_error, "exceeded demo time budget of 1ms");
  assert.match(act.fallback_note, /2026-10-20T02:20:00.000Z/);
  assert.equal(JSON.parse(again.action_result_json).sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  db.close();
});

test("Grok does not run the repo again when kind and repo_url stay the same", async () => {
  const db = openDb(":memory:");
  const row = createSave(db, URL);
  let runs = 0;
  const result = await runPipeline(db, row.id, {
    offline: false,
    awaitLive: true,
    llm: { apiKey: "test-key", baseUrl: "https://api.x.ai/v1", model: "grok-4.7" },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "saves-grok-same-")),
    fetchImpl: scraplingLiveFetch,
    llmFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "repo",
                summary: "Scrapling is a scraping library.",
                repo_url: "https://github.com/D4Vinci/Scrapling",
                paper_url: null,
                tool_url: null,
                date: null,
              }),
            },
          },
        ],
      }),
    }),
    runRepo: async () => {
      runs += 1;
      return {
        error: null,
        warning: null,
        stdout: "ran once",
        screenshot_path: null,
        action_result_json: { stdout: "ran once", timestamp: "2026-10-20T02:20:00.000Z" },
      };
    },
  });

  assert.equal(runs, 1);
  assert.equal(result.kind, "repo");
  const parsed = JSON.parse(result.action_result_json);
  assert.equal(parsed.sorted.source, "llm");
  assert.equal(parsed.sorted.details.repo_url, "https://github.com/D4Vinci/Scrapling");
  assert.equal(parsed.act.stdout, "ran once");
  db.close();
});

function scraplingLiveFetch(target) {
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
      text: async () => "",
    };
  }
  if (href.startsWith("https://x.com/") || href.startsWith("https://twitter.com/")) {
    return { ok: true, text: async () => "", json: async () => ({}) };
  }
  throw new Error(`unexpected ${href}`);
}
