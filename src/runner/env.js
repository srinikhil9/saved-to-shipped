import fs from "node:fs";
import path from "node:path";

/**
 * Names that may be passed to a child. Anything else on the parent
 * process, including LLM keys, is dropped. This object is built here
 * and is not a spread of process.env.
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PIP_DISABLE_PIP_VERSION_CHECK",
  "PIP_DEFAULT_TIMEOUT",
  "PIP_CACHE_DIR",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_AUDIT",
  "UV_INSTALL_DIR",
  "UV_UNMANAGED_INSTALL",
  "UV_CACHE_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "UV_NO_MODIFY_PATH",
  "UV_LINK_MODE",
  "INSTALLER_NO_MODIFY_PATH",
];

const ALLOWED = new Set(ENV_ALLOWLIST);

/** *_KEY, *_TOKEN, *_SECRET, and api-key style names. */
export const SECRET_ENV_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)(?:_|$)|api[_-]?key/i;

/**
 * Fresh environment for clone, install, and run.
 * HOME and TMPDIR are the per-run temp directory.
 * PATH is assembled from the venv/npm prefix, the node binary's directory,
 * tool directories named on the parent PATH, and the standard system bins.
 * No other parent variable is copied.
 */
export function allowlistedEnv({ home, pathPrefix, pipCacheDir, npmCacheDir, uv } = {}) {
  if (!home) throw new Error("allowlistedEnv requires a temp HOME");
  const env = {
    PATH: buildPath(pathPrefix),
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: home,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_DEFAULT_TIMEOUT: "60",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
  };
  if (pipCacheDir) env.PIP_CACHE_DIR = String(pipCacheDir);
  if (npmCacheDir) env.NPM_CONFIG_CACHE = String(npmCacheDir);
  if (uv) {
    env.UV_INSTALL_DIR = String(uv.uvBinDir);
    env.UV_UNMANAGED_INSTALL = String(uv.uvBinDir);
    env.UV_CACHE_DIR = String(uv.uvCache);
    env.UV_PYTHON_INSTALL_DIR = String(uv.uvPython);
    env.UV_NO_MODIFY_PATH = "1";
    env.INSTALLER_NO_MODIFY_PATH = "1";
    env.UV_LINK_MODE = "copy";
  }
  return env;
}

/**
 * The object actually handed to spawn. Refuses process.env and any
 * secret-shaped name, then copies only ENV_ALLOWLIST keys.
 */
export function envForSpawn(env) {
  if (!env || env === process.env) {
    throw new Error("refusing to spawn with process.env; build an allowlist with allowlistedEnv()");
  }
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_NAME.test(key)) {
      throw new Error(`refusing to spawn with secret env var ${key}`);
    }
  }
  const child = {};
  for (const key of ENV_ALLOWLIST) {
    if (env[key] != null && env[key] !== "") child[key] = String(env[key]);
  }
  if (!child.PATH || !child.HOME) {
    throw new Error("spawn env is missing PATH or HOME");
  }
  return child;
}

function buildPath(pathPrefix) {
  const dirs = [];
  if (pathPrefix) dirs.push(pathPrefix);
  dirs.push(path.dirname(process.execPath));
  const parentPath = process.env.PATH || "";
  for (const entry of parentPath.split(":")) {
    if (!entry || SECRET_ENV_NAME.test(entry)) continue;
    const hasTool =
      fs.existsSync(path.join(entry, "node")) ||
      fs.existsSync(path.join(entry, "npm")) ||
      fs.existsSync(path.join(entry, "git")) ||
      fs.existsSync(path.join(entry, "python3"));
    if (hasTool) dirs.push(entry);
  }
  dirs.push("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin");
  return [...new Set(dirs)].join(":");
}

export { ALLOWED };
