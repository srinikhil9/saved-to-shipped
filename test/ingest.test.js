import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandTcoUrl } from "../src/expand.js";
import { combinedText, ingest } from "../src/ingest.js";

const SEEDS = {
  loop: "https://x.com/0xCodez/status/2069736449902027136",
  karpathy: "https://x.com/cyrilXBT/status/2069651792678510894",
  scrapling: "https://x.com/hasantoxr/status/2025902150296236050",
};

test("ingest reads the three seed posts from fixtures without the network", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("network");
  };
  const posts = [];
  for (const url of Object.values(SEEDS)) {
    posts.push(await ingest(url, { offline: true, fetchImpl }));
  }
  assert.equal(calls, 0);
  const scrapling = posts[2];
  assert.equal(scrapling.author, "Hasan Toor");
  assert.match(scrapling.text, /Scrapling/);
  assert.equal(
    scrapling.links.some((link) => link.expanded === "https://github.com/D4Vinci/Scrapling"),
    true,
  );
  assert.match(combinedText(scrapling), /https:\/\/github\.com\/D4Vinci\/Scrapling/);
  assert.match(posts[0].text, /Loop Engineering/);
  assert.match(posts[1].text, /second brain/);
});

test("a failed live fetch falls back to the cached fixture", async () => {
  const post = await ingest(SEEDS.scrapling, {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.match(combinedText(post), /https:\/\/github\.com\/D4Vinci\/Scrapling/);
});

test("live ingest keeps an author self-reply and expands its t.co link", async () => {
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-fixtures-"));
  const fetchImpl = async (url) => {
    if (url === "https://api.fxtwitter.com/status/111") {
      return json({
        tweet: {
          id: "111",
          text: "Scrapling scrapes the web. Link in first comment",
          author: { name: "Hasan Toor", screen_name: "hasantoxr" },
          raw_text: { facets: [] },
        },
      });
    }
    if (url === "https://x.com/hasantoxr/status/111") {
      return {
        ok: true,
        text: async () => '<a href="https://x.com/hasantoxr/status/222">reply</a>',
      };
    }
    if (url === "https://api.fxtwitter.com/status/222") {
      return json({
        tweet: {
          id: "222",
          text: "Link: https://t.co/abc123XYZ",
          author: { name: "Hasan Toor", screen_name: "hasantoxr" },
          replying_to_status: "111",
          raw_text: {
            facets: [{ type: "url", original: "https://t.co/abc123XYZ", replacement: "https://t.co/abc123XYZ" }],
          },
        },
      });
    }
    if (url === "https://t.co/abc123XYZ") {
      return { ok: true, url: "https://github.com/D4Vinci/Scrapling", text: async () => "" };
    }
    throw new Error(`unexpected ${url}`);
  };

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "saves-live-"));
  const post = await ingest("https://x.com/hasantoxr/status/111", { fetchImpl, fixturesDir, cacheDir });
  assert.match(combinedText(post), /https:\/\/github\.com\/D4Vinci\/Scrapling/);
  assert.equal(
    post.links.some((link) => link.expanded === "https://github.com/D4Vinci/Scrapling"),
    true,
  );
});

test("expandTcoUrl follows the redirect", async () => {
  const expanded = await expandTcoUrl("https://t.co/abc123XYZ", async () => ({
    url: "https://github.com/D4Vinci/Scrapling",
  }));
  assert.equal(expanded, "https://github.com/D4Vinci/Scrapling");
});

function json(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
