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
  assert.match(html, new RegExp(`Works: installed and ran in ${seconds}s \\(Python 3\\.10\\+\\)`));
  assert.match(html, /Why you/);
  assert.match(html, /social-data scraping pipeline/);
  assert.match(html, /from scrapling\.fetchers import Fetcher/);
  assert.match(html, /yc-oss\.github\.io\/api\/tags\/consumer\.json/);
  const snippetLines = String(action.snippet || "").trim().split("\n");
  assert.ok(snippetLines.length >= 8 && snippetLines.length <= 12, snippetLines.length);
  assert.match(html, /Next step/);
  assert.match(html, /Drop this into your ingestion job/);
  assert.match(html, /Show last run/);
  assert.match(html, new RegExp(`<td class="name">${escapeRegExp(products[0].name)}</td>`));
  assert.match(html, new RegExp(escapeRegExp(products[0].one_liner)));
  assert.match(html, new RegExp(escapeRegExp(products[9].name)));
  assert.equal((html.match(/<tr><td class="name">/g) || []).length, 10);

  const folded = html.slice(detailsAt);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
