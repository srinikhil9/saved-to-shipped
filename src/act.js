/**
 * Act stage.
 *
 * Step 1 records the sort and stops. Step 2 replaces `actOnRepo`:
 * clone the repo into a temp directory, detect the language, install
 * into a local venv or node_modules, run the README quickstart or a
 * small smoke script, capture stdout plus a screenshot, and enforce a
 * timeout of about 90 seconds. Cache that result on the save
 * (action_result_json + screenshot_path) so the detail page can replay
 * "show last run" with no network.
 *
 * `env` is the sanitized child environment from sanitizedEnv(). Step 2
 * passes that object to the install and run processes. It has no API keys.
 */
export async function act(save, { env } = {}) {
  if (save.kind === "repo") return actOnRepo(save, env);
  if (save.kind === "paper" || save.kind === "idea") return actOnWriteup(save);
  if (save.kind === "tool") return actOnTool(save);
  if (save.kind === "event") return actOnEvent(save);
  return {
    status: "skipped",
    reason: "Nothing to run for this kind yet.",
  };
}

export async function actOnRepo(save, _env = {}) {
  return {
    status: "skipped",
    reason:
      "Repo runner lands in the next step: clone, install, and run in a temp dir with a 90s timeout, then cache stdout and a screenshot.",
    repo_url: save.details?.repo_url || null,
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
