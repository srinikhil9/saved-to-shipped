import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowlistedEnv, SECRET_ENV_NAME } from "./env.js";
import { runCommand } from "./exec.js";
import { paths } from "../paths.js";

/** CPython uv will install when the machine has nothing new enough. */
export const PROVISION_PYTHON = "3.12";

/** Official standalone installer. Honors UV_INSTALL_DIR and does not need sudo or Homebrew. */
export const UV_INSTALL_SH = "https://astral.sh/uv/install.sh";

const VERSION_NAMES = ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];

const PLATFORM_DIRS = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin"],
  linux: ["/usr/local/bin"],
};

export function toolDirs(root = paths.root) {
  const base = path.join(root, ".tools");
  return {
    base,
    uvBinDir: path.join(base, "uv"),
    uvCache: path.join(base, "uv-cache"),
    uvPython: path.join(base, "uv-python"),
  };
}

/** Vars the runner sets itself. Never copied from the parent environment. */
export function uvRuntimeEnv(dirs) {
  return {
    UV_INSTALL_DIR: dirs.uvBinDir,
    UV_UNMANAGED_INSTALL: dirs.uvBinDir,
    UV_CACHE_DIR: dirs.uvCache,
    UV_PYTHON_INSTALL_DIR: dirs.uvPython,
    UV_NO_MODIFY_PATH: "1",
    INSTALLER_NO_MODIFY_PATH: "1",
    UV_LINK_MODE: "copy",
  };
}

export function isOffline(env = process.env) {
  return env.INGEST_OFFLINE === "1";
}

export function parseVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : 0];
}

export function formatVersion(parts) {
  if (!parts) return "";
  return parts.join(".");
}

export function compareVersions(a, b) {
  const n = Math.max(a.length, b.length, 3);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function clauseMatches(version, clause) {
  const wild = clause.match(/^(==|!=)\s*(\d+(?:\.\d+)*)\.\*$/);
  if (wild) {
    const prefix = wild[2].split(".").map(Number);
    const same = prefix.every((n, i) => (version[i] || 0) === n);
    return wild[1] === "==" ? same : !same;
  }
  const match = clause.match(/^(>=|<=|==|!=|~=|>|<)\s*(\d+(?:\.\d+)*)$/);
  if (!match) return false;
  const want = parseVersion(match[2]);
  const op = match[1];
  const cmp = compareVersions(version, want);
  if (op === ">=") return cmp >= 0;
  if (op === ">") return cmp > 0;
  if (op === "<=") return cmp <= 0;
  if (op === "<") return cmp < 0;
  if (op === "==") return cmp === 0;
  if (op === "!=") return cmp !== 0;
  if (op === "~=") {
    const segs = match[2].split(".").map(Number);
    if (segs.length < 2) return false;
    const prefix = segs.slice(0, -1);
    const same = prefix.every((n, i) => (version[i] || 0) === n);
    return same && cmp >= 0;
  }
  return false;
}

/** PEP 440-ish check for the specifiers projects put in requires-python. */
export function versionSatisfies(version, specifier) {
  if (!specifier || !String(specifier).trim()) return true;
  const parts = Array.isArray(version) ? version : parseVersion(version);
  if (!parts) return false;
  const clauses = String(specifier)
    .split(",")
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (!clauses.length) return true;
  return clauses.every((clause) => clauseMatches(parts, clause));
}

function tomlTable(text, name) {
  const match = new RegExp(`^\\[${name}\\]\\s*$`, "m").exec(String(text || ""));
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function readRequiresPython(text) {
  const table = tomlTable(text, "project");
  if (!table) return null;
  const match = table.match(/^requires-python\s*=\s*["']([^"']+)["']/m);
  return match ? match[1].trim() : null;
}

export function projectNameFromToml(text) {
  const table = tomlTable(text, "project");
  if (!table) return "";
  const match = table.match(/^name\s*=\s*["']([^"']+)["']/m);
  return match ? match[1] : "";
}

export function readRequiresPythonFile(repoDir) {
  const file = path.join(repoDir, "pyproject.toml");
  if (!fs.existsSync(file)) return null;
  return readRequiresPython(fs.readFileSync(file, "utf8"));
}

export function readProjectName(repoDir) {
  const file = path.join(repoDir, "pyproject.toml");
  if (!fs.existsSync(file)) return "";
  return projectNameFromToml(fs.readFileSync(file, "utf8"));
}

/**
 * Newest versioned names first, then plain python3.
 * macOS also looks in Homebrew and /usr/local before PATH.
 */
export function interpreterCandidates({
  platform = process.platform,
  pathEntries = [],
  exists = fs.existsSync,
} = {}) {
  const dirs = [];
  for (const dir of [...(PLATFORM_DIRS[platform] || []), ...pathEntries, "/usr/local/bin", "/usr/bin"]) {
    if (!dir || SECRET_ENV_NAME.test(dir) || dirs.includes(dir)) continue;
    dirs.push(dir);
  }
  const found = [];
  for (const name of VERSION_NAMES) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (found.includes(full)) continue;
      if (exists(full)) found.push(full);
    }
  }
  return found;
}

export function chooseInterpreter(probes, specifier) {
  const ok = (probes || []).filter((probe) => probe && versionSatisfies(probe.version, specifier));
  ok.sort((a, b) => compareVersions(b.version, a.version));
  return ok[0] || null;
}

export function formatPythonNeed(specifier, found) {
  const spec = specifier && String(specifier).trim() ? String(specifier).trim() : null;
  const versions = [];
  for (const item of found || []) {
    const text = typeof item === "string" ? item : item?.versionText || formatVersion(item?.version);
    if (text && !versions.includes(text)) versions.push(text);
  }
  versions.sort((a, b) => compareVersions(parseVersion(b) || [0], parseVersion(a) || [0]));
  const shown = versions.length ? versions.join(", ") : "none";
  return spec ? `needs Python ${spec}, found ${shown}` : `needs Python, found ${shown}`;
}

export function stderrTail(text, max = 1200) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;
  return raw.slice(-max);
}

export function oneLine(text, max = 500) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(-max);
}

export function venvPaths(repoDir) {
  const dir = path.join(repoDir, ".venv");
  if (process.platform === "win32") {
    return {
      dir,
      python: path.join(dir, "Scripts", "python.exe"),
      pip: path.join(dir, "Scripts", "pip.exe"),
    };
  }
  return {
    dir,
    python: path.join(dir, "bin", "python"),
    pip: path.join(dir, "bin", "pip"),
  };
}

export function uvExecutable(dir, exists = fs.existsSync) {
  const name = process.platform === "win32" ? "uv.exe" : "uv";
  const flat = path.join(dir, name);
  if (exists(flat)) return flat;
  const nested = path.join(dir, "bin", name);
  if (exists(nested)) return nested;
  return null;
}

export function findOnParentPath(name, exists = fs.existsSync) {
  const parent = process.env.PATH || "";
  for (const entry of parent.split(":")) {
    if (!entry || SECRET_ENV_NAME.test(entry)) continue;
    const full = path.join(entry, name);
    if (exists(full)) return full;
  }
  return null;
}

export function uvInstallCommand() {
  return {
    cmd: "sh",
    args: ["-c", `curl -LsSf ${UV_INSTALL_SH} | sh`],
  };
}

/**
 * .[fetchers] then the base project, then PyPI scrapling.
 * The PyPI step is only for a Scrapling-shaped project. requirements.txt
 * projects get that file and nothing else.
 */
export function installSteps({
  optionalDeps = [],
  projectName = "",
  smokeCode = "",
  hasProject = false,
  hasReqs = false,
} = {}) {
  if (!hasProject && hasReqs) {
    return [{ label: "requirements.txt", args: ["install", "-r", "requirements.txt"] }];
  }
  if (!hasProject) return [];
  const scrapling =
    /scrapling/i.test(projectName) ||
    optionalDeps.includes("fetchers") ||
    /scrapling/.test(smokeCode || "");
  const steps = [];
  if (optionalDeps.includes("fetchers")) steps.push({ label: ".[fetchers]", args: ["install", ".[fetchers]"] });
  steps.push({ label: ".", args: ["install", "."] });
  if (scrapling) steps.push({ label: "pypi:scrapling", args: ["install", "scrapling"] });
  return steps;
}

export function pipInvocation(step, { uv, python, pip }) {
  if (uv) {
    return { cmd: uv, args: ["pip", "install", "--python", python, ...step.args.slice(1)] };
  }
  return { cmd: pip, args: step.args };
}

/** Try each install step until one exits 0. Keeps the stderr tail of every failure. */
export async function runInstallChain({ steps, run, uv, python, pip, cwd, env, timeoutForStep }) {
  const attempts = [];
  let installStep = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const timeoutMs = timeoutForStep ? timeoutForStep(i, steps.length) : 60_000;
    const invoked = pipInvocation(step, { uv, python, pip });
    const install = await run(invoked.cmd, invoked.args, { cwd, env, timeoutMs });
    attempts.push({
      step: step.label,
      exit_code: install.code,
      timed_out: Boolean(install.timedOut),
      stderr_tail: stderrTail(install.stderr),
    });
    if (install.code === 0) {
      installStep = step.label;
      break;
    }
  }
  return { installStep, attempts };
}

/** README quickstart that imports the optional fetcher APIs. The smoke uses the base package instead. */
export function smokeNeedsBasePackage(code) {
  return /scrapling\.(fetchers|spiders)/.test(code || "");
}

export function baseSelectorSmoke(url = "https://quotes.toscrape.com/") {
  return {
    kind: "python",
    source: "base-selector",
    code: `import urllib.request
from scrapling import Selector

url = ${JSON.stringify(url)}
with urllib.request.urlopen(url, timeout=30) as response:
    html = response.read()
page = Selector(html)
quotes = page.css(".quote .text::text").getall()
print(f"scraped {len(quotes)} quotes from {url}")
for quote in quotes:
    print("-", quote)
`,
  };
}

async function probePython(bin, { run, env }) {
  const result = await run(
    bin,
    ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
    { cwd: env.HOME, env, timeoutMs: 8_000 },
  );
  if (!result || result.code !== 0) return null;
  const line = String(result.stdout || "").trim().split("\n").pop();
  const version = parseVersion(line);
  if (!version) return null;
  return { bin, version, versionText: formatVersion(version) };
}

function dedupeFound(found) {
  const seen = new Set();
  const out = [];
  for (const probe of found) {
    if (!probe || seen.has(probe.versionText)) continue;
    seen.add(probe.versionText);
    out.push(probe);
  }
  return out;
}

export async function ensureUvBinary({ run, env, dirs, offline = false, exists = fs.existsSync }) {
  fs.mkdirSync(dirs.uvBinDir, { recursive: true });
  fs.mkdirSync(dirs.uvCache, { recursive: true });
  fs.mkdirSync(dirs.uvPython, { recursive: true });
  const cached = uvExecutable(dirs.uvBinDir, exists);
  if (cached) return { uv: cached, source: "cache" };
  const onPath = findOnParentPath("uv", exists);
  if (onPath) return { uv: onPath, source: "path" };
  if (offline || isOffline()) {
    return { uv: null, source: "offline", error: "offline; not installing uv" };
  }
  const command = uvInstallCommand();
  const result = await run(command.cmd, command.args, { cwd: env.HOME, env, timeoutMs: 90_000 });
  const installed = uvExecutable(dirs.uvBinDir, exists);
  if (!result || result.code !== 0 || !installed) {
    const detail =
      result && result.code === 0 && !installed
        ? "uv installer did not produce a binary"
        : stderrTail((result && (result.stderr || result.stdout)) || "uv installer failed");
    return { uv: null, source: "installer", error: detail, result };
  }
  return { uv: installed, source: "installer", result };
}

function withUv(env, dirs) {
  return { ...env, ...uvRuntimeEnv(dirs) };
}

/**
 * Pick an interpreter that satisfies requires-python, creating the venv with it.
 * When none qualify and this is not an offline run, install uv into .tools and
 * `uv python install 3.12` / `uv venv --python 3.12`.
 */
export async function ensurePython({
  repoDir,
  env,
  run,
  offline = isOffline(),
  dirs = toolDirs(),
  exists = fs.existsSync,
  platform = process.platform,
  pathEntries,
} = {}) {
  const spec = readRequiresPythonFile(repoDir);
  const entries = pathEntries || String(env?.PATH || "").split(":").filter(Boolean);
  const candidates = interpreterCandidates({ platform, pathEntries: entries, exists });
  const found = [];
  for (const bin of candidates) {
    const probed = await probePython(bin, { run, env });
    if (probed) found.push(probed);
  }
  const unique = dedupeFound(found);
  const chosen = chooseInterpreter(unique, spec);
  const venv = venvPaths(repoDir);
  const uvEnv = withUv(env, dirs);

  if (chosen) {
    const created = await run(chosen.bin, ["-m", "venv", venv.dir], {
      cwd: repoDir,
      env,
      timeoutMs: 60_000,
    });
    if (created.code === 0) {
      return {
        error: null,
        python: venv.python,
        pip: venv.pip,
        uv: null,
        version: chosen.versionText,
        provisioned: false,
        spec,
        found: unique.map((item) => item.versionText),
      };
    }
    if (!offline) {
      const uv = await ensureUvBinary({ run, env: uvEnv, dirs, offline: false, exists });
      if (uv.uv) {
        const again = await run(uv.uv, ["venv", "--python", chosen.bin, venv.dir], {
          cwd: repoDir,
          env: uvEnv,
          timeoutMs: 60_000,
        });
        if (again.code === 0) {
          return {
            error: null,
            python: venv.python,
            pip: venv.pip,
            uv: uv.uv,
            version: chosen.versionText,
            provisioned: false,
            spec,
            found: unique.map((item) => item.versionText),
          };
        }
      }
    }
    const tail = oneLine(stderrTail(created.stderr));
    return {
      error: `venv creation failed (${created.code})${tail ? `: ${tail}` : ""}`,
      python: null,
      spec,
      found: unique.map((item) => item.versionText),
      provisioned: false,
    };
  }

  const message = formatPythonNeed(spec || ">=3.10", unique);
  if (offline) {
    return {
      error: message,
      python: null,
      spec,
      found: unique.map((item) => item.versionText),
      provisioned: false,
    };
  }

  const uv = await ensureUvBinary({ run, env: uvEnv, dirs, offline: false, exists });
  if (!uv.uv) {
    const why = uv.error ? `; ${oneLine(uv.error)}` : "";
    return { error: `${message}${why}`, python: null, spec, found: unique.map((item) => item.versionText), provisioned: false };
  }
  const installed = await run(uv.uv, ["python", "install", PROVISION_PYTHON], {
    cwd: repoDir,
    env: uvEnv,
    timeoutMs: 180_000,
  });
  if (!installed || installed.code !== 0) {
    const why = oneLine(stderrTail((installed && (installed.stderr || installed.stdout)) || "uv python install failed"));
    return {
      error: `${message}; ${why}`,
      python: null,
      uv: uv.uv,
      spec,
      found: unique.map((item) => item.versionText),
      provisioned: false,
    };
  }
  const created = await run(uv.uv, ["venv", "--python", PROVISION_PYTHON, venv.dir], {
    cwd: repoDir,
    env: uvEnv,
    timeoutMs: 60_000,
  });
  if (!created || created.code !== 0) {
    const why = oneLine(stderrTail((created && created.stderr) || "uv venv failed"));
    return {
      error: `${message}; ${why}`,
      python: null,
      uv: uv.uv,
      spec,
      found: unique.map((item) => item.versionText),
      provisioned: false,
    };
  }
  return {
    error: null,
    python: venv.python,
    pip: venv.pip,
    uv: uv.uv,
    version: PROVISION_PYTHON,
    provisioned: true,
    spec,
    found: unique.map((item) => item.versionText),
  };
}

/**
 * Install uv (if needed) and CPython 3.12 into .tools, then warm the wheel cache
 * with the base scrapling package. No-ops when INGEST_OFFLINE=1.
 */
export async function preparePythonRuntime({
  run = runCommand,
  offline = isOffline(),
  root = paths.root,
  home,
} = {}) {
  if (offline) {
    return { ok: false, skipped: true, error: "INGEST_OFFLINE=1: not downloading or provisioning" };
  }
  const ownHome = !home;
  const work = home || fs.mkdtempSync(path.join(os.tmpdir(), "sts-prepare-"));
  const dirs = toolDirs(root);
  try {
    fs.mkdirSync(dirs.uvBinDir, { recursive: true });
    fs.mkdirSync(dirs.uvCache, { recursive: true });
    fs.mkdirSync(dirs.uvPython, { recursive: true });
    const env = allowlistedEnv({ home: work, uv: dirs, pathPrefix: dirs.uvBinDir });
    const uv = await ensureUvBinary({ run, env, dirs, offline: false });
    if (!uv.uv) return { ok: false, error: uv.error || "uv install failed", skipped: false };
    const py = await run(uv.uv, ["python", "install", PROVISION_PYTHON], {
      cwd: work,
      env,
      timeoutMs: 180_000,
    });
    if (!py || py.code !== 0) {
      return {
        ok: false,
        uv: uv.uv,
        error: stderrTail((py && (py.stderr || py.stdout)) || "uv python install 3.12 failed"),
      };
    }
    const warm = path.join(work, "warm-venv");
    const venv = await run(uv.uv, ["venv", "--python", PROVISION_PYTHON, warm], {
      cwd: work,
      env,
      timeoutMs: 60_000,
    });
    if (!venv || venv.code !== 0) {
      return { ok: true, uv: uv.uv, python: PROVISION_PYTHON, wheels: false, warning: stderrTail(venv && venv.stderr) };
    }
    const pyBin = path.join(warm, "bin", "python");
    const pip = await run(uv.uv, ["pip", "install", "--python", pyBin, "scrapling"], {
      cwd: work,
      env,
      timeoutMs: 180_000,
    });
    const wheels = Boolean(pip && pip.code === 0);
    return {
      ok: true,
      uv: uv.uv,
      python: PROVISION_PYTHON,
      wheels,
      warning: wheels ? null : stderrTail(pip && (pip.stderr || pip.stdout)),
    };
  } finally {
    if (ownHome) fs.rmSync(work, { recursive: true, force: true });
  }
}
