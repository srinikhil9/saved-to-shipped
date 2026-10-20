import { paths } from "./paths.js";
import { loadCachedRepoRun } from "./runner/cache.js";
import { runRepo } from "./runner/runRepo.js";

/**
 * Act stage.
 *
 * kind=repo clones the repo into a temp directory, installs into a venv
 * or local node_modules, runs the README quickstart (or a generated scrape),
 * and stores stdout plus a screenshot. Offline mode replays the committed
 * fixture instead of cloning. Other kinds stay as stubs.
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

  if (options.offline) {
    const cached = loadCachedRepoRun(repoUrl, { screenshotDir: paths.screenshots });
    if (cached) return cached;
    return {
      status: "failed",
      error: `No cached run for ${repoUrl}`,
      repo_url: repoUrl,
    };
  }

  const result = await runRepo({
    saveId: save.id,
    repoUrl,
    screenshotDir: paths.screenshots,
    onLog: (line) => console.log(`[save ${save.id}] ${line}`),
  });
  const action = result.action_result_json || {};
  return {
    ...action,
    status: result.error ? "failed" : "ok",
    error: result.error,
    stdout: result.stdout,
    screenshot_path: result.screenshot_path,
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
