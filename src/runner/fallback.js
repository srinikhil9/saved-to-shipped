/** The previous save row, when it already holds a finished repo run. */
export function lastGoodRun(previous) {
  if (!previous?.action_result_json) return null;
  let parsed;
  try {
    parsed = JSON.parse(previous.action_result_json);
  } catch {
    return null;
  }
  const act = parsed?.act;
  if (!act || act.status === "failed") return null;
  if (!act.stdout && !previous.screenshot_path && !act.screenshot_path) return null;
  return {
    ...act,
    screenshot_path: previous.screenshot_path || act.screenshot_path || null,
  };
}

export const README_ONLY_NOTE = "README cached, live install skipped";

/** A README summary with no install and no timed run. */
export function isReadmeOnlyCache(act) {
  if (!act || typeof act !== "object") return false;
  if (act.skipped_live_install) return true;
  const noRun =
    act.exit_code == null &&
    act.duration_ms == null &&
    act.run_duration_ms == null &&
    (!Array.isArray(act.commands) || act.commands.length === 0);
  return act.smoke_source === "readme" && noRun;
}

/** Keep a finished run on screen and record why the new attempt was discarded. */
export function asCachedReplay(good, attemptError) {
  const when = good.timestamp || "the last run";
  return {
    ...good,
    status: "cached",
    error: null,
    attempt_error: attemptError || null,
    fallback_note: isReadmeOnlyCache(good) ? README_ONLY_NOTE : `showing last good run from ${when}`,
    screenshot_path: good.screenshot_path || null,
  };
}
