import { act } from "./act.js";
import { classifyHeuristic, classifyWithGrok } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { expandPostLinks } from "./expand.js";
import { combinedText, ingest, readSavedPost } from "./ingest.js";

const generations = new WeakMap();
const flights = new WeakMap();

/**
 * Stages for one save: ingest → sort → act.
 * Relate (why_you, from data/profile.json) is a later step and stays null.
 * A saved copy is sorted immediately. A live read, when it succeeds, updates
 * that card and is cached for the next offline replay.
 *
 * The regex result is stored before Grok is called. One Grok flight runs per
 * pipeline generation, so the live refresh does not call Grok again.
 */
export async function runPipeline(db, id, options = {}) {
  const existing = getSave(db, id);
  if (!existing) return null;
  const snapshot = snapshotOf(existing);
  const generation = bumpGeneration(db, id);
  const runOptions = { ...options, generation };
  try {
    updateSave(db, id, { status: "sorting", error: null });
    if (!runOptions.offline) {
      const saved = readSavedPost(existing.url, runOptions);
      if (saved) {
        const prepared = await expandPostLinks(saved, runOptions.fetchImpl || globalThis.fetch);
        const done = await storeSorted(db, id, prepared, runOptions);
        const pending = refreshFromLive(db, id, existing.url, runOptions);
        if (runOptions.awaitLive) await pending;
        await upgradeFor(db, id, generation);
        return getSave(db, id) || done;
      }
    }
    const post = await ingest(existing.url, runOptions);
    const done = await storeSorted(db, id, post, runOptions);
    await upgradeFor(db, id, generation);
    return getSave(db, id) || done;
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
  const generation = options.generation;
  if (!generation || generation !== generationOf(db, id)) return getSave(db, id);

  const input = { text: combinedText(post), links: post.links || [] };
  const heuristic = classifyHeuristic(input);
  updateSave(db, id, {
    status: "acting",
    author: formatAuthor(post),
    text: post.text || "",
    error: null,
  });
  if (generation !== generationOf(db, id)) return getSave(db, id);

  const current = getSave(db, id);
  const action = await act(
    { ...current, kind: current.kind || heuristic.kind, details: heuristic.details },
    { env: options.childEnv || {} },
  );
  if (generation !== generationOf(db, id)) return getSave(db, id);

  const latest = getSave(db, id);
  const plan = planSort(latest, heuristic, generation, options.llm);
  const saved = updateSave(db, id, {
    status: "done",
    kind: plan.kind,
    summary: plan.summary,
    action_result_json: JSON.stringify({
      sorted: {
        source: plan.source,
        details: plan.details,
        links: post.links || [],
        posted_at: post.posted_at || null,
        handle: post.handle || null,
        reply_text: post.reply_text || "",
        quote: post.quote || null,
        upgrade: plan.upgrade,
        generation,
      },
      act: plan.keepAct || action,
    }),
    error: null,
  });

  if (plan.schedule && reserveFlight(db, id, generation)) {
    const upgrade = classifyWithGrok(input, heuristic, {
      llm: options.llm,
      fetchImpl: options.llmFetch,
      timeoutMs: options.llmTimeoutMs,
      signalFactory: options.llmSignalFactory,
    })
      .then((upgraded) => applyUpgrade(db, id, generation, upgraded, options))
      .catch(() => applyUpgrade(db, id, generation, null, options));
    rememberUpgrade(db, id, generation, upgrade);
  }
  return saved;
}

function refreshFromLive(db, id, url, options) {
  return ingest(url, { ...options, skipSaved: true })
    .then((post) => storeSorted(db, id, post, options))
    .catch(() => {});
}

async function applyUpgrade(db, id, generation, upgraded, options) {
  if (generation !== generationOf(db, id)) return;
  const row = getSave(db, id);
  if (!row) return;
  const action = parseAction(row.action_result_json);
  if (!action?.sorted || action.sorted.generation !== generation) return;
  if (!upgraded) {
    action.sorted.upgrade = null;
    updateSave(db, id, { action_result_json: JSON.stringify(action) });
    return;
  }
  const acted = await act({ ...row, kind: upgraded.kind, details: upgraded.details }, { env: options.childEnv || {} });
  if (generation !== generationOf(db, id)) return;
  const latest = getSave(db, id);
  const latestAction = parseAction(latest?.action_result_json);
  if (!latestAction?.sorted || latestAction.sorted.generation !== generation) return;
  latestAction.sorted.source = "llm";
  latestAction.sorted.details = upgraded.details;
  latestAction.sorted.upgrade = "done";
  latestAction.act = acted;
  updateSave(db, id, {
    status: "done",
    kind: upgraded.kind,
    summary: upgraded.summary || latest.summary,
    action_result_json: JSON.stringify(latestAction),
    error: null,
  });
}

function planSort(row, heuristic, generation, llm) {
  const action = parseAction(row?.action_result_json);
  const sorted = action?.sorted;
  if (sorted?.source === "llm" && sorted.generation === generation) {
    return {
      kind: row.kind,
      summary: row.summary,
      source: "llm",
      details: sorted.details,
      upgrade: "done",
      schedule: false,
      keepAct: action.act,
    };
  }
  return {
    kind: heuristic.kind,
    summary: heuristic.summary,
    source: "heuristic",
    details: heuristic.details,
    upgrade: llm?.apiKey ? "pending" : null,
    schedule: Boolean(llm?.apiKey),
    keepAct: null,
  };
}

function bumpGeneration(db, id) {
  let byId = generations.get(db);
  if (!byId) {
    byId = new Map();
    generations.set(db, byId);
  }
  const next = (byId.get(id) || 0) + 1;
  byId.set(id, next);
  return next;
}

function generationOf(db, id) {
  return generations.get(db)?.get(id) || 0;
}

function reserveFlight(db, id, generation) {
  let set = flights.get(db);
  if (!set) {
    set = new Set();
    flights.set(db, set);
  }
  const key = `${id}:${generation}`;
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

const upgrades = new WeakMap();

function rememberUpgrade(db, id, generation, promise) {
  let byId = upgrades.get(db);
  if (!byId) {
    byId = new Map();
    upgrades.set(db, byId);
  }
  byId.set(`${id}:${generation}`, promise);
}

function upgradeFor(db, id, generation) {
  return upgrades.get(db)?.get(`${id}:${generation}`) || Promise.resolve();
}

function parseAction(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
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
