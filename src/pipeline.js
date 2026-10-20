import { act } from "./act.js";
import { classify } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { expandPostLinks } from "./expand.js";
import { combinedText, ingest, readCachedPost, readSavedPost } from "./ingest.js";
import { loadProfile } from "./profile.js";
import { parseXStatusUrl } from "./xurl.js";
import { refreshWhyYou, storeWhyLine } from "./why.js";

/**
 * Stages for one save: ingest → sort → why_you → act.
 * A saved copy is sorted immediately. why_you is the template line first;
 * Grok may replace it in the background. A live read, when it succeeds,
 * updates the card and is cached for the next offline replay.
 */
export async function runPipeline(db, id, options = {}) {
  const existing = getSave(db, id);
  if (!existing) return null;
  const snapshot = snapshotOf(existing);
  try {
    updateSave(db, id, { status: "sorting", error: null });
    if (!options.offline) {
      const saved = readSavedPost(existing.url, options);
      if (saved) {
        const prepared = await expandPostLinks(saved, options.fetchImpl || globalThis.fetch);
        // A fixture can paint the card before the live read returns. Replaying
        // the committed repo cache keeps that paint fast; the live refresh
        // runs the repo for real once the post is fetched.
        const previewFromFixture = !hasLiveCache(existing.url, options);
        const done = await storeSorted(
          db,
          id,
          prepared,
          previewFromFixture ? { ...options, offline: true } : options,
        );
        const pending = refreshFromLive(db, id, existing.url, options);
        if (options.awaitLive) await pending;
        return done;
      }
    }
    const post = await ingest(existing.url, options);
    return await storeSorted(db, id, post, options);
  } catch (error) {
    if (snapshot.kind && snapshot.action_result_json) {
      return updateSave(db, id, {
        status: "done",
        author: snapshot.author,
        text: snapshot.text,
        kind: snapshot.kind,
        summary: snapshot.summary,
        why_you: snapshot.why_you,
        why_you_source: snapshot.why_you_source,
        why_you_profile_hash: snapshot.why_you_profile_hash,
        action_result_json: snapshot.action_result_json,
        screenshot_path: snapshot.screenshot_path,
        error: null,
      });
    }
    return updateSave(db, id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function storeSorted(db, id, post, options) {
  const sorted = await classify(
    { text: combinedText(post), links: post.links || [] },
    { llm: options.llm, fetchImpl: options.llmFetch },
  );
  const profile = options.profile || loadProfile();
  const save = {
    id,
    url: post.url,
    author: formatAuthor(post),
    text: post.text || "",
    kind: sorted.kind,
    summary: sorted.summary,
  };
  updateSave(db, id, {
    status: "acting",
    author: save.author,
    text: save.text,
    kind: save.kind,
    summary: save.summary,
    error: null,
  });
  storeWhyLine(db, id, save, profile);
  const pendingWhy = refreshWhyYou(db, id, save, profile, options);
  const current = getSave(db, id);
  const action = await act(
    { ...current, details: sorted.details },
    { offline: options.offline === true, env: options.childEnv || {} },
  );
  const failed = action?.status === "failed";
  const stored = updateSave(db, id, {
    status: failed ? "failed" : "done",
    screenshot_path: action?.screenshot_path || null,
    action_result_json: JSON.stringify({
      sorted: {
        source: sorted.source,
        details: sorted.details,
        links: post.links || [],
        posted_at: post.posted_at || null,
        handle: post.handle || null,
        reply_text: post.reply_text || "",
        quote: post.quote || null,
      },
      act: action,
    }),
    error: failed ? action?.error || "Repo run failed" : null,
  });
  if (options.awaitWhy) await pendingWhy;
  return getSave(db, id) || stored;
}

function refreshFromLive(db, id, url, options) {
  return ingest(url, { ...options, skipSaved: true })
    .then((post) => storeSorted(db, id, post, options))
    .catch(() => {});
}

function hasLiveCache(url, options) {
  const parsed = parseXStatusUrl(url);
  if (!parsed) return false;
  return Boolean(readCachedPost(parsed.id, options.cacheDir));
}

function snapshotOf(row) {
  return {
    author: row.author,
    text: row.text,
    kind: row.kind,
    summary: row.summary,
    why_you: row.why_you,
    why_you_source: row.why_you_source,
    why_you_profile_hash: row.why_you_profile_hash,
    action_result_json: row.action_result_json,
    screenshot_path: row.screenshot_path,
  };
}

function formatAuthor(post) {
  if (post.author && post.handle) return `${post.author} (@${post.handle})`;
  return post.author || (post.handle ? `@${post.handle}` : null);
}
