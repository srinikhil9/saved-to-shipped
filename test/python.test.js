import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { renderCards } from "../src/html.js";
import { allowlistedEnv, envForSpawn } from "../src/runner/env.js";
import { runCommand } from "../src/runner/exec.js";
import {
  baseSelectorSmoke,
  chooseInterpreter,
  ensurePython,
  formatPythonNeed,
  installSteps,
  interpreterCandidates,
  preparePythonRuntime,
  readRequiresPython,
  runInstallChain,
  smokeNeedsBasePackage,
  toolDirs,
  versionSatisfies,
} from "../src/runner/python.js";

const SCRAPLING_TOML = `[project]
name = "scrapling"
requires-python = ">=3.10"
dependencies = ["cssselect>=1.5.0"]

[project.optional-dependencies]
fetchers = ["curl_cffi"]
`;

function ok(stdout = "", extra = {}) {
  return { code: 0, stdout, stderr: "", timedOut: false, durationMs: 1, ...extra };
}

function isVersionProbe(args) {
  return args[0] === "-c" && String(args[1] || "").includes("version_info");
}

test("requires-python rejects 3.9.6 and accepts 3.12", () => {
  assert.equal(readRequiresPython(SCRAPLING_TOML), ">=3.10");
  assert.equal(versionSatisfies("3.9.6", ">=3.10"), false);
  assert.equal(versionSatisfies("3.10.0", ">=3.10"), true);
  assert.equal(versionSatisfies("3.12.1", ">=3.10"), true);
  assert.equal(versionSatisfies("3.13.0", ">=3.10,<3.13"), false);
  assert.equal(versionSatisfies("3.12.0", ">=3.10,<3.13"), true);
  assert.equal(formatPythonNeed(">=3.10", [{ versionText: "3.9.6" }]), "needs Python >=3.10, found 3.9.6");
  assert.equal(formatPythonNeed(">=3.10", []), "needs Python >=3.10, found none");
});

test("candidate interpreters prefer a newer match on macOS and Linux", () => {
  const darwin = interpreterCandidates({
    platform: "darwin",
    pathEntries: ["/usr/bin"],
    exists: (bin) => bin === "/opt/homebrew/bin/python3.12" || bin === "/usr/local/bin/python3.11" || bin === "/usr/bin/python3",
  });
  assert.deepEqual(darwin, ["/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.11", "/usr/bin/python3"]);

  const linux = interpreterCandidates({
    platform: "linux",
    pathEntries: ["/usr/bin"],
    exists: (bin) => bin === "/usr/bin/python3.12" || bin === "/usr/bin/python3",
  });
  assert.deepEqual(linux, ["/usr/bin/python3.12", "/usr/bin/python3"]);

  const chosen = chooseInterpreter(
    [
      { bin: "/usr/bin/python3", version: [3, 9, 6], versionText: "3.9.6" },
      { bin: "/usr/bin/python3.11", version: [3, 11, 9], versionText: "3.11.9" },
      { bin: "/opt/homebrew/bin/python3.12", version: [3, 12, 3], versionText: "3.12.3" },
    ],
    ">=3.10",
  );
  assert.equal(chosen.versionText, "3.12.3");
  const capped = chooseInterpreter(
    [
      { bin: "/usr/bin/python3.11", version: [3, 11, 9], versionText: "3.11.9" },
      { bin: "/opt/homebrew/bin/python3.12", version: [3, 12, 3], versionText: "3.12.3" },
    ],
    ">=3.10,<3.12",
  );
  assert.equal(capped.versionText, "3.11.9");
});

test("install chain records the step that succeeded and keeps the cssselect tail", async () => {
  const steps = installSteps({
    optionalDeps: ["fetchers"],
    projectName: "scrapling",
    smokeCode: "from scrapling.fetchers import Fetcher\n",
    hasProject: true,
  });
  assert.deepEqual(steps.map((step) => step.label), [".[fetchers]", ".", "pypi:scrapling"]);

  const calls = [];
  const chain = await runInstallChain({
    steps,
    uv: "/tools/uv",
    python: "/repo/.venv/bin/python",
    pip: "/repo/.venv/bin/pip",
    cwd: "/repo",
    env: {},
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args.includes(".[fetchers]")) {
        return { code: 1, stdout: "", stderr: "ERROR: No matching distribution found for cssselect>=1.5.0\n", timedOut: false };
      }
      if (args.includes(".")) return ok("installed base");
      return { code: 1, stdout: "", stderr: "should not reach pypi", timedOut: false };
    },
  });
  assert.equal(chain.installStep, ".");
  assert.equal(chain.attempts.length, 2);
  assert.match(chain.attempts[0].stderr_tail, /cssselect>=1\.5\.0/);
  assert.match(calls[0], /uv pip install --python \/repo\/\.venv\/bin\/python \.\[fetchers\]/);
  assert.match(calls[1], /uv pip install --python \/repo\/\.venv\/bin\/python \./);
  assert.equal(calls.some((line) => line.includes("pypi") || line.endsWith(" scrapling")), false);

  const smoke = baseSelectorSmoke();
  assert.equal(smokeNeedsBasePackage("from scrapling.fetchers import Fetcher\n"), true);
  assert.equal(smokeNeedsBasePackage(smoke.code), false);
  assert.match(smoke.code, /from scrapling import Selector/);
  assert.doesNotMatch(smoke.code, /fetchers/);
});

test("a 3.9-only machine provisions Python 3.12 with uv, and offline does not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sts-py-"));
  const repoDir = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repoDir);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repoDir, "pyproject.toml"), SCRAPLING_TOML);
  const dirs = toolDirs(root);
  const env = allowlistedEnv({ home, uv: dirs });
  const state = { uv: false };

  const exists = (bin) => {
    if (bin === "/usr/bin/python3") return true;
    if (state.uv && bin === path.join(dirs.uvBinDir, "uv")) return true;
    return false;
  };

  async function run(cmd, args) {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (isVersionProbe(args)) return ok("3.9.6\n");
    if (cmd === "sh") {
      state.uv = true;
      return ok("");
    }
    if (args[0] === "python" && args[1] === "install") return ok("installed 3.12");
    if (args[0] === "venv") return ok("");
    return { code: 1, stdout: "", stderr: `unexpected ${line}`, timedOut: false };
  }

  const calls = [];
  const live = await ensurePython({
    repoDir,
    env,
    run,
    offline: false,
    dirs,
    exists,
    platform: "darwin",
    pathEntries: ["/usr/bin"],
  });
  assert.equal(live.error, null);
  assert.equal(live.provisioned, true);
  assert.equal(live.version, "3.12");
  assert.equal(live.python, path.join(repoDir, ".venv", "bin", "python"));
  assert.ok(calls.some((line) => line.includes("https://astral.sh/uv/install.sh")));
  assert.ok(calls.some((line) => /python install 3\.12$/.test(line)));
  assert.ok(calls.some((line) => /venv --python 3\.12 /.test(line)));
  assert.equal(calls.some((line) => line.includes("python3 -m venv")), false);
  for (const key of Object.keys(env)) {
    assert.equal(envForSpawn(env)[key], env[key]);
    assert.doesNotMatch(key, /KEY|TOKEN|SECRET/);
  }
  assert.equal(env.UV_CACHE_DIR, dirs.uvCache);
  assert.equal(env.UV_PYTHON_INSTALL_DIR, dirs.uvPython);

  const offlineCalls = [];
  const offline = await ensurePython({
    repoDir,
    env,
    offline: true,
    dirs,
    exists: (bin) => bin === "/usr/bin/python3",
    platform: "linux",
    pathEntries: ["/usr/bin"],
    run: async (cmd, args) => {
      offlineCalls.push([cmd, ...args].join(" "));
      if (isVersionProbe(args)) return ok("3.9.6\n");
      return { code: 1, stdout: "", stderr: "should not install", timedOut: false };
    },
  });
  assert.equal(offline.error, "needs Python >=3.10, found 3.9.6");
  assert.equal(offlineCalls.some((line) => /curl|uv|install\.sh/.test(line)), false);
});

test("INGEST_OFFLINE=1 does not clone or provision", async () => {
  const prepared = await preparePythonRuntime({
    offline: true,
    run: async () => {
      throw new Error("should not download");
    },
  });
  assert.equal(prepared.skipped, true);

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      process.env.INGEST_OFFLINE = "1";
      const { runRepo } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/runner/runRepo.js")).href)});
      const { actOnRepo } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/act.js")).href)});
      let ran = false;
      const action = await actOnRepo(
        { id: 1, details: { repo_url: "https://github.com/D4Vinci/Scrapling" } },
        { repoMode: "live", runRepo: async () => { ran = true; return { error: "should not run" }; } },
      );
      if (ran) throw new Error("live runner was called");
      if (action.status !== "cached") throw new Error("expected cached, got " + action.status);
      const repo = await runRepo({ repoUrl: "https://github.com/D4Vinci/Scrapling", timeoutMs: 1000 });
      if (!String(repo.error).includes("offline; refusing to clone, install, or provision")) {
        throw new Error("unexpected runRepo error: " + repo.error);
      }
      if (repo.action_result_json) throw new Error("offline runRepo built a result");
      `,
    ],
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("uv install failure still reports the interpreter that was found", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sts-py-fail-"));
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(repoDir, "pyproject.toml"), SCRAPLING_TOML);
  const result = await ensurePython({
    repoDir,
    env: allowlistedEnv({ home: root, uv: toolDirs(root) }),
    offline: false,
    dirs: toolDirs(root),
    platform: "linux",
    pathEntries: ["/usr/bin"],
    exists: (bin) => bin === "/usr/bin/python3",
    run: async (cmd, args) => {
      if (isVersionProbe(args)) return ok("3.9.6\n");
      return { code: 1, stdout: "", stderr: "curl: (6) Could not resolve host", timedOut: false };
    },
  });
  assert.match(result.error, /^needs Python >=3\.10, found 3\.9\.6/);
  assert.match(result.error, /Could not resolve host/);
});

test("the card shows the python requirement when the live run falls back", () => {
  const html = renderCards([
    {
      id: 4,
      url: "https://x.com/hasantoxr/status/1",
      status: "done",
      kind: "repo",
      author: "Hasan",
      summary: "Scrapling",
      screenshot_path: "/screenshots/scrapling-seed.png",
      action_result_json: JSON.stringify({
        act: {
          status: "cached",
          fallback_note: "showing last good run from 2026-10-20T01:44:40.000Z",
          attempt_error: "needs Python >=3.10, found 3.9.6",
          stdout: "scraped 10 quotes",
        },
      }),
    },
  ]);
  assert.match(html, /needs Python &gt;=3\.10, found 3\.9\.6/);
  assert.match(html, /showing last good run from 2026-10-20T01:44:40.000Z/);
  assert.match(html, /cached/);
});

test("uv child env is scrubbed", async () => {
  process.env.OPENAI_API_KEY = "sk-dummy-openai";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sts-uv-env-"));
  const dirs = toolDirs(home);
  const env = allowlistedEnv({ home, uv: dirs });
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    { cwd: home, env, timeoutMs: 5000 },
  );
  assert.equal(result.code, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.UV_CACHE_DIR, dirs.uvCache);
  assert.equal(child.UV_PYTHON_INSTALL_DIR, dirs.uvPython);
  assert.equal(child.UV_NO_MODIFY_PATH, "1");
  assert.equal(child.HOME, home);
});
