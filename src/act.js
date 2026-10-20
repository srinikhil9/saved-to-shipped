import { DEMO_RUN_BUDGET_MS } from "./limits.js";
import { paths } from "./paths.js";
import { asCachedReplay, lastGoodRun } from "./runner/fallback.js";
import { loadCachedRepoRun } from "./runner/cache.js";
import { isOffline } from "./runner/python.js";
import { runRepo } from "./runner/runRepo.js";

/**
 * Act stage.
 *
 * kind=repo clones, installs, and runs in a temp dir. Child processes get
 * the runner's own allowlist (src/runner/env.js), not sanitizedEnv() and
 * not process.env. A missed screenshot is a warning. A failed or over-budget
 * live run keeps the row's own last good run. The committed fixture is only
 * used when that row has none.
 */
export async function act(save, options = {}) {
  if (save.kind === "repo") return actOnRepo(save, options);
  if (save.kind === "paper" || save.kind === "idea") return actOnWriteup(save);
  if (save.kind === "tool") return actOnTool(save);
  if (save.kind === "event") return actOnEvent(save);
  return {
    status: "skipped",
    reason: "Nothing to run for this kind yet.",
  };
}

export async function actOnRepo(save, options = {}) {
  const repoUrl = save.details?.repo_url || null;
  if (!repoUrl) {
    return {
      status: "failed",
      error: "No GitHub repo URL on this save",
      repo_url: null,
    };
  }

  const offline = options.offline === true || isOffline();
  const mode = offline ? "cache" : options.repoMode || "live";
  const screenshotDir = options.screenshotDir || paths.screenshots;
  if (mode !== "live") {
    const cached = loadCachedRepoRun(repoUrl, { screenshotDir });
    if (cached) return asCachedReplay(cached, null);
    return {
      status: "failed",
      error: `No cached run for ${repoUrl}`,
      repo_url: repoUrl,
    };
  }

  const execute = options.runRepo || runRepo;
  let result;
  try {
    result = await execute({
      saveId: save.id,
      repoUrl,
      screenshotDir,
      deadlineMs: options.demoBudgetMs ?? DEMO_RUN_BUDGET_MS,
      onLog: (line) => console.log(`[save ${save.id}] ${line}`),
    });
  } catch (error) {
    result = {
      error: error instanceof Error ? error.message : String(error),
      stdout: "",
      screenshot_path: null,
      warning: null,
      action_result_json: null,
    };
  }

  if (!result.error) {
    const action = result.action_result_json || {};
    return {
      ...action,
      status: "ok",
      error: null,
      warning: result.warning || action.warning || null,
      stdout: result.stdout ?? action.stdout ?? "",
      screenshot_path: result.screenshot_path || null,
      repo_url: repoUrl,
    };
  }

  const previous = lastGoodRun(save.previous);
  const cached = loadCachedRepoRun(repoUrl, { screenshotDir });
  const good = previous || cached;
  if (good) {
    const replay = asCachedReplay({ ...good, repo_url: good.repo_url || repoUrl }, result.error);
    const failed = result.action_result_json || {};
    if (failed.install_stderr) replay.install_stderr = failed.install_stderr;
    if (failed.install_attempts) replay.install_attempts = failed.install_attempts;
    return replay;
  }

  const action = result.action_result_json || {};
  return {
    ...action,
    status: "failed",
    error: result.error,
    warning: result.warning || null,
    stdout: result.stdout || "",
    screenshot_path: result.screenshot_path || null,
    repo_url: repoUrl,
  };
}

async function actOnWriteup() {
  return {
    status: "skipped",
    reason: "Paper and idea actions (a one-page spec and a starter folder) land in a later step.",
  };
}

async function actOnTool() {
  return {
    status: "skipped",
    reason: "Tool summaries land in a later step.",
  };
}

async function actOnEvent() {
  return {
    status: "skipped",
    reason: "Calendar files land in a later step.",
  };
}
