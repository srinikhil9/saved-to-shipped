import assert from "node:assert/strict";
import test from "node:test";
import { openDb, updateSave, createSave } from "../src/db.js";
import { loadProfile } from "../src/profile.js";
import { backfillWhyYou, whyYou } from "../src/why.js";

const profile = loadProfile();

test("keyword hits use the profile slots for the three seed shapes", () => {
  assert.equal(
    whyYou({ kind: "repo", text: "Scrapling scrapes websites with Python." }, profile),
    "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
  );
  assert.equal(
    whyYou({ kind: "paper", text: "Loop Engineering for agentic systems." }, profile),
    "A blueprint for running your scrape-and-recommend agents as a self-verifying loop; Saved to Shipped is one.",
  );
  assert.equal(
    whyYou({ kind: "idea", text: "Karpathy's second brain is a living wiki." }, profile),
    "Turn your saved posts, founders, and YC/a16z products into a living wiki your recommender can draw on.",
  );
});

test("other kinds fall back to a one-line template from the profile", () => {
  const line = whyYou({ kind: "event", text: "RSVP for the meetup." }, profile);
  assert.match(line, /An event for people building/);
  assert.match(line, /YC \/ a16z startups/);
  assert.equal(line.includes("\n"), false);
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
