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

/** Keep a finished run on screen and record why the new attempt was discarded. */
export function asCachedReplay(good, attemptError) {
  const when = good.timestamp || "the last run";
  return {
    ...good,
    status: "cached",
    error: null,
    attempt_error: attemptError || null,
    fallback_note: `showing last good run from ${when}`,
    screenshot_path: good.screenshot_path || null,
  };
}
