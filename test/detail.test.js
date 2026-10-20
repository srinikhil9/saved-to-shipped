import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderDetail } from "../src/html.js";

const runDir = path.join(import.meta.dirname, "..", "fixtures", "repo-runs", "scrapling");

test("scrapling detail leads with the verdict and product table from the cached run", () => {
  const action = JSON.parse(fs.readFileSync(path.join(runDir, "action_result.json"), "utf8"));
  const stdout = fs.readFileSync(path.join(runDir, "stdout.txt"), "utf8");
  const products = JSON.parse(stdout);
  assert.equal(products.length, 10);
  for (const product of products) {
    assert.equal(typeof product.name, "string");
    assert.ok(product.name.trim());
    assert.equal(typeof product.one_liner, "string");
    assert.ok(product.one_liner.trim());
    assert.match(product.url, /^https?:\/\//);
  }

  const post = "Full post about Scrapling that should stay folded away.";
  const html = renderDetail({
    id: 1,
    author: "Hasan Toor (@hasantoxr)",
    url: "https://x.com/hasantoxr/status/2025902150296236050",
    text: post,
    kind: "repo",
    status: "done",
    summary: "Scrapling scrapes sites.",
    why_you:
      "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
    screenshot_path: action.screenshot_path,
    action_result_json: JSON.stringify({
      sorted: {
        source: "heuristic",
        details: { repo_url: "https://github.com/D4Vinci/Scrapling" },
        links: [{ expanded: "https://github.com/D4Vinci/Scrapling" }],
      },
      act: { ...action, stdout },
    }),
  });

  const verdictAt = html.indexOf('id="verdict"');
  const tableAt = html.indexOf("<table");
  const detailsAt = html.indexOf("<details");
  assert.ok(verdictAt > 0 && tableAt > verdictAt && detailsAt > tableAt);
  const seconds = (action.duration_ms / 1000).toFixed(1);
  const scrape = (action.run_duration_ms / 1000).toFixed(1);
  assert.match(html, new RegExp(`Works: installed and ran in ${seconds}s \\(scrape ${scrape}s\\)`));
  assert.doesNotMatch(html, /Python 3\.10\+/);
  assert.match(html, /Why you/);
  assert.match(html, /social-data scraping pipeline/);
  assert.match(html, /from scrapling\.fetchers import Fetcher/);
  assert.match(html, /yc-oss\.github\.io\/api\/tags\/consumer\.json/);
  const snippetLines = String(action.snippet || "").trim().split("\n");
  assert.ok(snippetLines.length >= 8 && snippetLines.length <= 12, snippetLines.length);
  assert.match(html, /Next step/);
  assert.match(html, /Run the snippet above in Scrapling/);
  assert.doesNotMatch(html, /Drop this into your ingestion job/);
  assert.match(html, /Show last run/);
  assert.match(html, new RegExp(`<td class="name">${escapeRegExp(products[0].name)}</td>`));
  assert.match(html, new RegExp(escapeRegExp(products[0].one_liner)));
  assert.match(html, new RegExp(escapeRegExp(products[9].name)));
  assert.equal((html.match(/<tr><td class="name">/g) || []).length, 10);

  const shotAt = html.indexOf("scrapling-seed.png");
  assert.ok(shotAt > tableAt && shotAt < detailsAt);
  const folded = html.slice(detailsAt);
  assert.doesNotMatch(folded, /scrapling-seed\.png/);
  assert.match(folded, /<summary>Details<\/summary>/);
  assert.match(folded, /Full post about Scrapling/);
  assert.match(folded, /Sorted by/);
  assert.match(folded, />heuristic</);
  assert.match(folded, /id="stdout"/);
  assert.match(folded, /github\.com\/D4Vinci\/Scrapling/);
  assert.doesNotMatch(html.slice(0, detailsAt), /Full post about Scrapling/);
  assert.doesNotMatch(html.slice(0, detailsAt), /id="stdout"/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
});

test("verdict follows the run status instead of always saying Works", () => {
  const timedOut = renderDetail(repoSave({ exit_code: 1, timed_out: true, duration_ms: 90_000 }));
  assert.match(timedOut, /Timed out after 90\.0s/);
  assert.doesNotMatch(timedOut, /Works/);

  const install = renderDetail(
    repoSave({
      exit_code: 1,
      timed_out: false,
      duration_ms: 4000,
      install_stderr: "pip failed",
      commands: [{ cmd: ".venv/bin/pip install .", exit_code: 1 }],
    }),
  );
  assert.match(install, /Failed at install/);
  assert.doesNotMatch(install, /Works/);
  assert.doesNotMatch(install, /Python 3\.10\+/);
  assert.doesNotMatch(install, /Drop this into your ingestion job/);

  const other = renderDetail(
    repoSave({
      exit_code: 0,
      timed_out: false,
      duration_ms: 1500,
      run_duration_ms: 400,
      language: "javascript",
      repo: "https://github.com/acme/widget",
      snippet: "console.log('hi')\n",
      stdout: "",
      products: [],
    }),
  );
  assert.match(other, /Works: installed and ran in 1\.5s \(scrape 0\.4s\)/);
  assert.match(other, /Run the snippet above in widget/);
  assert.doesNotMatch(other, /Python 3\.10\+/);
  assert.doesNotMatch(other, /ingestion job/);
  assert.doesNotMatch(other, /Scrapling/);
});

function repoSave(act) {
  return {
    id: 9,
    author: "Ada",
    url: "https://x.com/ada/status/1",
    text: "A different repo.",
    kind: "repo",
    status: "done",
    summary: "Some project.",
    why_you: "A repo to use while you build your social-data recommender.",
    action_result_json: JSON.stringify({
      sorted: { source: "heuristic", details: { repo_url: act.repo || "https://github.com/acme/widget" } },
      act,
    }),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
