import assert from "node:assert/strict";
import test from "node:test";
import { classify, classifyHeuristic } from "../src/classify.js";
import { combinedText, ingest } from "../src/ingest.js";

const SEEDS = [
  ["https://x.com/hasantoxr/status/2025902150296236050", "repo", "https://github.com/D4Vinci/Scrapling", null],
  ["https://x.com/0xCodez/status/2069736449902027136", "paper", null, "https://drive.google.com/file/d/1qzKI4DKnyHRpXK1J3ATPqwaqLc0iNu-M/view?usp=sharing"],
  ["https://x.com/cyrilXBT/status/2069651792678510894", "idea", null, null],
];

test("heuristic classifier labels the three seed posts with no API key", async () => {
  for (const [url, kind, repo, paper] of SEEDS) {
    const post = await ingest(url, { offline: true, fetchImpl: async () => { throw new Error("network"); } });
    const sorted = await classify(
      { text: combinedText(post), links: post.links },
      { env: {} },
    );
    assert.equal(sorted.source, "heuristic", url);
    assert.equal(sorted.kind, kind, url);
    assert.equal(sorted.details.repo_url, repo, url);
    assert.equal(sorted.details.paper_url, paper, url);
    assert.ok(sorted.summary.length > 20, url);
  }
});

test("regex fallback: github repo, arxiv paper, event, and a plain idea", () => {
  const repo = classifyHeuristic({
    text: "Check this out https://github.com/D4Vinci/Scrapling/tree/main",
    links: [],
  });
  assert.equal(repo.kind, "repo");
  assert.equal(repo.details.repo_url, "https://github.com/D4Vinci/Scrapling");

  const paper = classifyHeuristic({
    text: "New preprint https://arxiv.org/pdf/2607.00038",
    links: [],
  });
  assert.equal(paper.kind, "paper");
  assert.equal(paper.details.paper_url, "https://arxiv.org/pdf/2607.00038");

  const event = classifyHeuristic({
    text: "RSVP for the meetup on May 2, 2026 https://lu.ma/example",
    links: [],
  });
  assert.equal(event.kind, "event");
  assert.equal(event.details.date, "May 2, 2026");

  const idea = classifyHeuristic({
    text: "A simple idea: keep a folder of notes and reread them.",
    links: [],
  });
  assert.equal(idea.kind, "idea");
});

test("Grok is used only when XAI_API_KEY is set, and a bad response falls back", async () => {
  const input = { text: "A simple idea about notes.", links: [] };
  let requested = null;
  const llmFetch = async (url, init) => {
    requested = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "event",
                summary: "A dated meetup.",
                repo_url: null,
                paper_url: null,
                tool_url: null,
                date: "May 2, 2026",
              }),
            },
          },
        ],
      }),
    };
  };
  const withKey = await classify(input, {
    env: { XAI_API_KEY: "test-key" },
    fetchImpl: llmFetch,
  });
  assert.equal(withKey.source, "llm");
  assert.equal(withKey.kind, "event");
  assert.equal(withKey.details.date, "May 2, 2026");
  assert.equal(requested.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(requested.body.model, "grok-4.7");

  requested = null;
  const override = await classify(input, {
    env: { XAI_API_KEY: "test-key", XAI_MODEL: "grok-4" },
    fetchImpl: llmFetch,
  });
  assert.equal(override.source, "llm");
  assert.equal(requested.body.model, "grok-4");

  const withoutKey = await classify(input, { env: {}, fetchImpl: llmFetch });
  assert.equal(withoutKey.source, "heuristic");
  assert.equal(withoutKey.kind, "idea");

  const broken = await classify(
    { text: "Ship https://github.com/D4Vinci/Scrapling", links: [] },
    {
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "nope" } }] }) }),
    },
  );
  assert.equal(broken.source, "heuristic");
  assert.equal(broken.kind, "repo");
});
