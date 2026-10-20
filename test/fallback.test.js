import assert from "node:assert/strict";
import test from "node:test";
import { actOnRepo } from "../src/act.js";
import { createSave, openDb } from "../src/db.js";
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
