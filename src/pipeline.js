import { act } from "./act.js";
import { classify } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { expandPostLinks } from "./expand.js";
import { asCachedReplay } from "./runner/fallback.js";
import { isOffline } from "./runner/python.js";
import { combinedText, ingest, readSavedPost } from "./ingest.js";

/**
 * Stages for one save: ingest → sort → act.
 * Relate (why_you, from data/profile.json) is a later step and stays null.
 * A saved copy is sorted immediately from the committed repo run when one
 * exists. A live read, when it succeeds, may replace that run. A failed or
 * over-budget live run keeps the last good result.
 */
export async function runPipeline(db, id, options = {}) {
  const existing = getSave(db, id);
  if (!existing) return null;
  const snapshot = snapshotOf(existing);
  const offline = options.offline === true || isOffline();
  const opts = { ...options, offline };
  try {
    updateSave(db, id, { status: "sorting", error: null });
    if (!opts.offline && !opts.forceLive) {
      const saved = readSavedPost(existing.url, opts);
      if (saved) {
        const prepared = await expandPostLinks(saved, opts.fetchImpl || globalThis.fetch);
        const done = await storeSorted(db, id, prepared, { ...opts, repoMode: "cache" }, snapshot);
        const pending = refreshFromLive(db, id, existing.url, opts, snapshot);
        if (options.awaitLive) await pending;
        return done;
      }
    }
    const post = await ingest(existing.url, opts);
    return await storeSorted(
      db,
      id,
      post,
      { ...opts, repoMode: opts.repoMode || (opts.offline ? "cache" : "live") },
      snapshot,
    );
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

async function storeSorted(db, id, post, options, snapshot) {
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
  const action = await act(
    { ...current, details: sorted.details, previous: snapshot },
    {
      offline: options.offline === true,
      repoMode: options.repoMode,
      demoBudgetMs: options.demoBudgetMs,
      runRepo: options.runRepo,
      screenshotDir: options.screenshotDir,
    },
  );
  const failed = action?.status === "failed";
  if (failed && snapshot?.kind && snapshot?.action_result_json) {
    const preserved = preserveGood(snapshot, action.error);
    return updateSave(db, id, {
      status: "done",
      author: snapshot.author,
      text: snapshot.text,
      kind: snapshot.kind,
      summary: snapshot.summary,
      why_you: snapshot.why_you,
      screenshot_path: preserved.screenshot_path,
      action_result_json: preserved.json,
      error: null,
    });
  }
  const screenshotPath = action?.screenshot_path || (action?.warning ? snapshot?.screenshot_path || null : null);
  return updateSave(db, id, {
    status: failed ? "failed" : "done",
    screenshot_path: screenshotPath,
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
      act: { ...action, screenshot_path: screenshotPath },
    }),
    error: failed ? action?.error || "Repo run failed" : null,
  });
}

function refreshFromLive(db, id, url, options, snapshot) {
  return ingest(url, { ...options, skipSaved: true })
    .then((post) => storeSorted(db, id, post, { ...options, repoMode: "live" }, snapshot))
    .catch((error) => {
      const current = getSave(db, id);
      if (current?.status === "acting" && snapshot?.kind && snapshot?.action_result_json) {
        const preserved = preserveGood(snapshot, error instanceof Error ? error.message : String(error));
        updateSave(db, id, {
          status: "done",
          author: snapshot.author,
          text: snapshot.text,
          kind: snapshot.kind,
          summary: snapshot.summary,
          why_you: snapshot.why_you,
          screenshot_path: preserved.screenshot_path,
          action_result_json: preserved.json,
          error: null,
        });
      }
    });
}

function preserveGood(snapshot, attemptError) {
  let parsed = {};
  try {
    parsed = JSON.parse(snapshot.action_result_json);
  } catch {
    parsed = {};
  }
  const act = asCachedReplay(
    { ...(parsed.act || {}), screenshot_path: snapshot.screenshot_path || parsed.act?.screenshot_path || null },
    attemptError,
  );
  return {
    screenshot_path: act.screenshot_path,
    json: JSON.stringify({ ...parsed, act }),
  };
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
