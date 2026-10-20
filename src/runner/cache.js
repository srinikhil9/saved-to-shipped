import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

function runsDir() {
  return path.join(paths.fixtures, "repo-runs");
}

function readRun(dir) {
  const resultPath = path.join(dir, "action_result.json");
  if (!fs.existsSync(resultPath)) return null;
  const action = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  return { dir, action };
}

function sameRepo(left, right) {
  const normalize = (value) =>
    String(value || "")
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Copy a committed repo run into the served screenshots directory and
 * return the act payload. Used when ingest is offline so the demo replays
 * without cloning.
 */
export function loadCachedRepoRun(repoUrl, { screenshotDir = paths.screenshots } = {}) {
  const root = runsDir();
  if (!repoUrl || !fs.existsSync(root)) return null;
  const match = fs
    .readdirSync(root)
    .map((name) => readRun(path.join(root, name)))
    .find((run) => run && sameRepo(run.action.repo, repoUrl));
  if (!match) return null;

  const stdoutPath = path.join(match.dir, "stdout.txt");
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : match.action.stdout || "";
  const fileName = match.action.screenshot_file || "screenshot.png";
  const srcPng = path.join(match.dir, "screenshot.png");
  let screenshotPath = null;
  if (fs.existsSync(srcPng)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.copyFileSync(srcPng, path.join(screenshotDir, fileName));
    screenshotPath = `/screenshots/${fileName}`;
  }

  return {
    ...match.action,
    status: "cached",
    error: null,
    stdout,
    screenshot_path: screenshotPath,
    repo_url: match.action.repo,
  };
}

export function restoreCachedScreenshots(screenshotDir = paths.screenshots) {
  const root = runsDir();
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const run = readRun(path.join(root, name));
    if (!run) continue;
    const srcPng = path.join(run.dir, "screenshot.png");
    if (!fs.existsSync(srcPng)) continue;
    const fileName = run.action.screenshot_file || "screenshot.png";
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.copyFileSync(srcPng, path.join(screenshotDir, fileName));
  }
}
