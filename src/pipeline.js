import { act } from "./act.js";
import { classify } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { combinedText, ingest } from "./ingest.js";

/**
 * Stages for one save: ingest → sort → act.
 * Relate (why_you, from data/profile.json) is a later step and stays null.
 * Show reads whatever this pipeline stored.
 */
export async function runPipeline(db, id, options = {}) {
  const existing = getSave(db, id);
  if (!existing) return null;
  try {
    updateSave(db, id, { status: "sorting", error: null });
    const post = await ingest(existing.url, options);
    updateSave(db, id, {
      author: formatAuthor(post),
      text: post.text || "",
    });

    const sorted = await classify(
      { text: combinedText(post), links: post.links || [] },
      { env: options.env, fetchImpl: options.llmFetch },
    );
    updateSave(db, id, {
      status: "acting",
      kind: sorted.kind,
      summary: sorted.summary,
    });

    const current = getSave(db, id);
    const action = await act({ ...current, details: sorted.details });
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
  } catch (error) {
    return updateSave(db, id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatAuthor(post) {
  if (post.author && post.handle) return `${post.author} (@${post.handle})`;
  return post.author || (post.handle ? `@${post.handle}` : null);
}
