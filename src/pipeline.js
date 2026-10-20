import { act } from "./act.js";
import { classifyHeuristic, classifyWithGrok } from "./classify.js";
import { getSave, updateSave } from "./db.js";
import { expandPostLinks } from "./expand.js";
import { combinedText, ingest, readSavedPost } from "./ingest.js";
import { loadProfile } from "./profile.js";
import { asCachedReplay } from "./runner/fallback.js";
import { isOffline } from "./runner/python.js";
import { refreshWhyYou, storeWhyLine } from "./why.js";

const generations = new WeakMap();
const flights = new WeakMap();
const upgrades = new WeakMap();

/**
 * Stages for one save: ingest → sort → why_you → act.
 * The regex card, including its template why_you, is stored before Grok.
 * Fixture preview replays the repo cache, but why_you still sees the real
 * offline flag, so Grok runs when X is down and XAI_API_KEY is set.
 * A live refresh does not take a seed repo card off kind repo.
 */
export async function runPipeline(db, id, options = {}) {
  const existing = getSave(db, id);
  if (!existing) return null;
  const snapshot = snapshotOf(existing);
  const offline = options.offline === true || isOffline();
  const generation = bumpGeneration(db, id);
  const runOptions = { ...options, offline, generation };
  try {
    updateSave(db, id, { status: "sorting", error: null });
    if (!runOptions.offline && !runOptions.forceLive) {
      const saved = readSavedPost(existing.url, runOptions);
      if (saved) {
        const prepared = await expandPostLinks(saved, runOptions.fetchImpl || globalThis.fetch);
        const done = await storeSorted(db, id, prepared, { ...runOptions, repoMode: "cache" }, snapshot);
        const pending = refreshFromLive(db, id, existing.url, runOptions, snapshot);
        if (runOptions.awaitLive) await pending;
        await upgradeFor(db, id, generation);
        if (runOptions.awaitWhy) await whyFor(db, id);
        return getSave(db, id) || done;
      }
    }
    const post = await ingest(existing.url, runOptions);
    const done = await storeSorted(
      db,
      id,
      post,
      { ...runOptions, repoMode: runOptions.repoMode || (runOptions.offline ? "cache" : "live") },
      snapshot,
    );
    await upgradeFor(db, id, generation);
    if (runOptions.awaitWhy) await whyFor(db, id);
    return getSave(db, id) || done;
  } catch (error) {
    if (snapshot.kind && snapshot.action_result_json) {
      return restoreSnapshot(db, id, snapshot);
    }
    return updateSave(db, id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function storeSorted(db, id, post, options, snapshot) {
  const generation = options.generation;
  if (!generation || generation !== generationOf(db, id)) return getSave(db, id);

  const input = { text: combinedText(post), links: post.links || [] };
  const heuristic = classifyHeuristic(input);
  const basis = options.refresh ? preserveSeedRepo(getSave(db, id), heuristic) : heuristic;
  updateSave(db, id, {
    status: "acting",
    text: post.text || "",
    error: null,
  });
  if (generation !== generationOf(db, id)) return getSave(db, id);

  const current = getSave(db, id);
  const action = await act(
    { ...current, kind: basis.kind, details: basis.details, previous: snapshot },
    actOptions(options),
  );
  if (generation !== generationOf(db, id)) return getSave(db, id);

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
      why_you_source: snapshot.why_you_source,
      why_you_profile_hash: snapshot.why_you_profile_hash,
      screenshot_path: preserved.screenshot_path,
      action_result_json: preserved.json,
      error: null,
    });
  }

  const latest = getSave(db, id);
  const plan = planSort(latest, basis, generation, options.llm);
  const profile = options.profile || loadProfile();
  const save = {
    id,
    url: post.url || latest?.url,
    author: formatAuthor(post),
    text: post.text || "",
    kind: plan.kind,
    summary: plan.summary,
  };
  storeWhyLine(db, id, save, profile);
  const pendingWhy = refreshWhyYou(db, id, save, profile, options);
  rememberWhy(db, id, pendingWhy);
  const screenshotPath = action?.screenshot_path || (action?.warning ? snapshot?.screenshot_path || null : null);
  updateSave(db, id, {
    status: failed ? "failed" : "done",
    author: save.author,
    kind: plan.kind,
    summary: plan.summary,
    screenshot_path: screenshotPath,
    action_result_json: JSON.stringify({
      sorted: {
        source: plan.source,
        details: plan.details,
        links: ensureRepoLink(post.links || [], plan.details?.repo_url),
        posted_at: post.posted_at || null,
        handle: post.handle || null,
        reply_text: post.reply_text || "",
        quote: post.quote || null,
        upgrade: plan.upgrade,
        generation,
      },
      act: { ...(plan.keepAct || action), screenshot_path: screenshotPath || action?.screenshot_path || null },
    }),
    error: failed ? action?.error || "Repo run failed" : null,
  });
  return afterSort(db, id, input, basis, generation, options, plan);
}

function afterSort(db, id, input, basis, generation, options, plan) {
  if (plan.schedule && reserveFlight(db, id, generation)) {
    const upgrade = classifyWithGrok(input, basis, {
      llm: options.llm,
      fetchImpl: options.llmFetch,
      timeoutMs: options.llmTimeoutMs,
      signalFactory: options.llmSignalFactory,
    })
      .then((upgraded) => applyUpgrade(db, id, generation, upgraded, options))
      .catch(() => applyUpgrade(db, id, generation, null, options));
    rememberUpgrade(db, id, generation, upgrade);
  }
  return getSave(db, id);
}

function refreshFromLive(db, id, url, options, snapshot) {
  return ingest(url, { ...options, skipSaved: true })
    .then((post) =>
      storeSorted(db, id, post, { ...options, refresh: true, repoMode: options.repoMode || "cache" }, snapshot),
    )
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
          why_you_source: snapshot.why_you_source,
          why_you_profile_hash: snapshot.why_you_profile_hash,
          screenshot_path: preserved.screenshot_path,
          action_result_json: preserved.json,
          error: null,
        });
      }
    });
}

function preserveSeedRepo(row, heuristic) {
  const previousUrl = parseAction(row?.action_result_json)?.sorted?.details?.repo_url || null;
  const hadRepo = row?.kind === "repo" || Boolean(previousUrl);
  if (!hadRepo) return heuristic;
  if (heuristic.kind === "repo" && (heuristic.details.repo_url || !previousUrl)) return heuristic;
  return {
    ...heuristic,
    kind: "repo",
    details: {
      ...heuristic.details,
      repo_url: heuristic.details.repo_url || previousUrl,
    },
  };
}

function ensureRepoLink(links, repoUrl) {
  if (!repoUrl) return links;
  if (links.some((link) => link.expanded === repoUrl)) return links;
  return [...links, { short: null, expanded: repoUrl }];
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
  const acted = await act(
    { ...row, kind: upgraded.kind, details: upgraded.details, previous: snapshotFrom(row) },
    actOptions(options),
  );
  if (generation !== generationOf(db, id)) return;
  const latest = getSave(db, id);
  const latestAction = parseAction(latest?.action_result_json);
  if (!latestAction?.sorted || latestAction.sorted.generation !== generation) return;
  latestAction.sorted.source = "llm";
  latestAction.sorted.details = upgraded.details;
  latestAction.sorted.upgrade = "done";
  latestAction.act = acted;
  const summary = upgraded.summary || latest.summary;
  updateSave(db, id, {
    status: "done",
    kind: upgraded.kind,
    summary,
    screenshot_path: acted?.screenshot_path || latest.screenshot_path,
    action_result_json: JSON.stringify(latestAction),
    error: null,
  });
  const profile = options.profile || loadProfile();
  const save = {
    id,
    url: latest.url,
    author: latest.author,
    text: latest.text,
    kind: upgraded.kind,
    summary,
  };
  storeWhyLine(db, id, save, profile);
  rememberWhy(db, id, refreshWhyYou(db, id, save, profile, options));
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

function actOptions(options) {
  return {
    offline: options.offline === true,
    repoMode: options.repoMode,
    demoBudgetMs: options.demoBudgetMs,
    runRepo: options.runRepo,
    screenshotDir: options.screenshotDir,
    env: options.childEnv || {},
  };
}

function preserveGood(snapshot, attemptError) {
  let parsed = {};
  try {
    parsed = JSON.parse(snapshot.action_result_json);
  } catch {
    parsed = {};
  }
  const acted = asCachedReplay(
    { ...(parsed.act || {}), screenshot_path: snapshot.screenshot_path || parsed.act?.screenshot_path || null },
    attemptError,
  );
  return {
    screenshot_path: acted.screenshot_path,
    json: JSON.stringify({ ...parsed, act: acted }),
  };
}

function restoreSnapshot(db, id, snapshot) {
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

function snapshotFrom(row) {
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

const whyJobs = new WeakMap();

function rememberWhy(db, id, promise) {
  let byId = whyJobs.get(db);
  if (!byId) {
    byId = new Map();
    whyJobs.set(db, byId);
  }
  const previous = byId.get(id) || Promise.resolve();
  const job = Promise.resolve(previous).then(() => promise);
  byId.set(id, job);
  return job;
}

function whyFor(db, id) {
  return whyJobs.get(db)?.get(id) || Promise.resolve();
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
  return snapshotFrom(row);
}

function formatAuthor(post) {
  if (post.author && post.handle) return `${post.author} (@${post.handle})`;
  return post.author || (post.handle ? `@${post.handle}` : null);
}
