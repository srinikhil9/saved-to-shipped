import { act } from "./act.js";
import { classify } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { expandPostLinks } from "./expand.js";
import { combinedText, ingest, readSavedPost } from "./ingest.js";

/**
 * Stages for one save: ingest → sort → act.
 * Relate (why_you, from data/profile.json) is a later step and stays null.
 * A saved copy is sorted immediately. A live read, when it succeeds, updates
 * that card and is cached for the next offline replay.
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
        const done = await storeSorted(db, id, prepared, options);
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
  updateSave(db, id, {
    status: "acting",
    author: formatAuthor(post),
    text: post.text || "",
    kind: sorted.kind,
    summary: sorted.summary,
    error: null,
  });
  const current = getSave(db, id);
  const action = await act({ ...current, details: sorted.details }, { env: options.childEnv || {} });
  return updateSave(db, id, {
    status: "done",
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
    error: null,
  });
}

function refreshFromLive(db, id, url, options) {
  return ingest(url, { ...options, skipSaved: true })
    .then((post) => storeSorted(db, id, post, options))
    .catch(() => {});
}

function snapshotOf(row) {
  return {
    author: row.author,
    text: row.text,
    kind: row.kind,
    summary: row.summary,
    why_you: row.why_you,
    action_result_json: row.action_result_json,
    screenshot_path: row.screenshot_path,
  };
}

function formatAuthor(post) {
  if (post.author && post.handle) return `${post.author} (@${post.handle})`;
  return post.author || (post.handle ? `@${post.handle}` : null);
}
