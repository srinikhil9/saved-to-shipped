import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLanguage, readOptionalDeps } from "./detect.js";
import { allowlistedEnv } from "./env.js";
import { runCommand } from "./exec.js";
import {
  baseSelectorSmoke,
  ensurePython,
  installSteps,
  isOffline,
  oneLine,
  readProjectName,
  runInstallChain,
  smokeNeedsBasePackage,
  toolDirs,
} from "./python.js";
import {
  consumerProductSmoke,
  extractProducts,
  extractQuickstart,
  extractSample,
  generatedJavaScriptSmoke,
  generatedPythonSmoke,
} from "./quickstart.js";
import { screenshotRun } from "./screenshot.js";
import { paths } from "../paths.js";

const RUN_TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 600_000;
const CLONE_TIMEOUT_MS = 60_000;

function normalizeRepoUrl(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[?#].*)?$/i);
  if (!match) {
    throw new Error(`Only https://github.com/owner/repo URLs can be run (got ${raw || 'empty'})`);
  }
  const owner = match[1];
  const repo = match[2];
  return {
    pageUrl: `https://github.com/${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    name: repo,
  };
}

function commandRecord(result) {
  return {
    cmd: result.cmd,
    exit_code: result.code,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
  };
}

function failure(partial, error) {
  return {
    stdout: partial.stdout || '',
    screenshot_path: partial.screenshot_path || null,
    action_result_json: partial.action_result_json || null,
    warning: partial.warning || null,
    error,
  };
}

/**
 * Clone a GitHub repo into a fresh temp dir, install it, and run the README
 * quickstart (or a generated scrape). The child environment is scrubbed.
 *
 * @returns {Promise<{stdout: string, screenshot_path: string|null, action_result_json: object, error: string|null}>}
 */
async function runRepo({
  saveId,
  repoUrl,
  screenshotDir,
  screenshotPublicPrefix = '/screenshots',
  timeoutMs = RUN_TIMEOUT_MS,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  deadlineMs = null,
  onLog = () => {},
} = {}) {
  if (isOffline()) {
    return failure({}, "offline; refusing to clone, install, or provision");
  }

  const started = Date.now();
  const timestamp = new Date().toISOString();
  let repo;
  try {
    repo = normalizeRepoUrl(repoUrl);
  } catch (err) {
    return failure({}, err.message);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-run-'));
  const repoDir = path.join(home, 'repo');
  const commands = [];
  const pipCache = paths.pipCache;
  const tools = toolDirs();
  fs.mkdirSync(pipCache, { recursive: true });
  const env = allowlistedEnv({ home, pipCacheDir: pipCache, uv: tools, pathPrefix: tools.uvBinDir });
  let overBudget = false;
  let warning = null;

  async function limited(cmd, args, opts) {
    const budgetNote = `exceeded demo time budget of ${deadlineMs}ms`;
    if (deadlineMs && Date.now() - started >= deadlineMs) {
      overBudget = true;
      return {
        cmd: [cmd, ...args].join(' '),
        code: 124,
        stdout: '',
        stderr: budgetNote,
        timedOut: true,
        durationMs: 0,
      };
    }
    const cap = opts.timeoutMs;
    const left = deadlineMs ? Math.max(1, deadlineMs - (Date.now() - started)) : cap;
    const result = await runCommand(cmd, args, { ...opts, timeoutMs: Math.min(cap, left) });
    if (deadlineMs && result.timedOut && Date.now() - started >= deadlineMs - 25) overBudget = true;
    return result;
  }

  function failReason(kind, result) {
    if (overBudget) return `exceeded demo time budget of ${deadlineMs}ms`;
    if (result.timedOut) return `${kind} timed out`;
    return `${kind} failed (${result.code})`;
  }
  let language = 'unknown';
  let smoke = null;
  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let timedOut = false;
  let runDuration = 0;
  let screenshotPath = null;
  let error = null;
  let installAttempts = [];
  let installStep = null;
  let pythonVersion = null;
  let pythonProvisioned = false;

  const record = (result) => {
    commands.push(commandRecord(result));
    onLog(`${result.cmd} → ${result.code} (${result.durationMs}ms)${result.timedOut ? ' timeout' : ''}`);
    return result;
  };

  try {
    const clone = record(
      await limited('git', ['clone', '--depth', '1', repo.cloneUrl, repoDir], {
        cwd: home,
        env,
        timeoutMs: CLONE_TIMEOUT_MS,
      }),
    );
    if (clone.code !== 0) {
      error = failReason('clone', clone);
      stderr = clone.stderr;
    } else {
      language = detectLanguage(repoDir);
      const readmeName = fs.readdirSync(repoDir).find((name) => /^readme(\.|$)/i.test(name));
      const readme = readmeName ? fs.readFileSync(path.join(repoDir, readmeName), 'utf8') : '';
      smoke = chooseSmoke({ repoUrl: repo.pageUrl, readme, language });

      if (language === 'python') {
        const prepared = await ensurePython({
          repoDir,
          env,
          offline: false,
          dirs: tools,
          run: (cmd, args, opts) => limited(cmd, args, opts).then((result) => record(result)),
        });
        pythonVersion = prepared.version || null;
        pythonProvisioned = prepared.provisioned === true;
        if (prepared.error) {
          error = prepared.error;
          stderr = prepared.error;
        } else {
          const hasProject = fs.existsSync(path.join(repoDir, 'pyproject.toml')) || fs.existsSync(path.join(repoDir, 'setup.py'));
          const hasReqs = fs.existsSync(path.join(repoDir, 'requirements.txt'));
          const steps = installSteps({
            optionalDeps: readOptionalDeps(repoDir),
            projectName: readProjectName(repoDir),
            smokeCode: smoke.code || '',
            hasProject,
            hasReqs,
          });
          const chain = await runInstallChain({
            steps,
            uv: prepared.uv,
            python: prepared.python,
            pip: prepared.pip,
            cwd: repoDir,
            env,
            timeoutForStep: (index, count) => {
              const remain = deadlineMs ? deadlineMs - (Date.now() - started) : installTimeoutMs;
              const reserve = index < count - 1 ? 15_000 : 8_000;
              return Math.min(installTimeoutMs, Math.max(5_000, remain - reserve));
            },
            run: async (cmd, args, opts) => {
              if (overBudget) {
                return { code: 124, stdout: '', stderr: `exceeded demo time budget of ${deadlineMs}ms`, timedOut: true };
              }
              return record(await limited(cmd, args, opts));
            },
          });
          installAttempts = chain.attempts;
          installStep = chain.installStep;
          if (steps.length && !installStep) {
            const last = installAttempts.at(-1);
            const tail = last?.stderr_tail ? `: ${oneLine(last.stderr_tail, 700)}` : '';
            error = overBudget
              ? `exceeded demo time budget of ${deadlineMs}ms${tail}`
              : `install failed (${last?.exit_code ?? 1})${tail}`;
            stderr = installAttempts.map((attempt) => attempt.stderr_tail).filter(Boolean).join('\n');
          }
        }
        const py = prepared.python;

        if (!error) {
          const scriptPath = path.join(repoDir, '_sts_smoke.py');
          if (smoke.kind === 'shell') {
            const run = record(
              await limited('bash', ['-c', smoke.command], {
                cwd: repoDir,
                env: allowlistedEnv({
                  home,
                  pathPrefix: path.join(repoDir, '.venv', 'bin'),
                  pipCacheDir: pipCache,
                  uv: tools,
                }),
                timeoutMs,
              }),
            );
            stdout = run.stdout;
            stderr = run.stderr;
            exitCode = run.code;
            timedOut = run.timedOut;
            runDuration = run.durationMs;
          } else if (!py) {
            error = error || 'python venv is missing';
          } else {
            fs.writeFileSync(scriptPath, smoke.code);
            const run = record(
              await limited(py, ['-u', scriptPath], { cwd: repoDir, env, timeoutMs }),
            );
            stdout = run.stdout;
            stderr = run.stderr;
            exitCode = run.code;
            timedOut = run.timedOut;
            runDuration = run.durationMs;
          }
          if (exitCode !== 0 && !error) {
            error = overBudget ? `exceeded demo time budget of ${deadlineMs}ms` : timedOut ? `run timed out after ${Math.round(timeoutMs / 1000)}s` : `run exited ${exitCode}`;
          }
        }
      } else if (language === 'javascript') {
        if (!smoke) smoke = generatedJavaScriptSmoke();
        const install = record(
          await limited('npm', ['install', '--no-audit', '--no-fund'], {
            cwd: repoDir,
            env,
            timeoutMs: installTimeoutMs,
          }),
        );
        if (install.code !== 0) {
          error = failReason('npm install', install);
          stderr = install.stderr;
        } else if (smoke.kind === 'shell') {
          const run = record(
            await limited('bash', ['-c', smoke.command], { cwd: repoDir, env, timeoutMs }),
          );
          stdout = run.stdout;
          stderr = run.stderr;
          exitCode = run.code;
          timedOut = run.timedOut;
          runDuration = run.durationMs;
        } else {
          const scriptPath = path.join(repoDir, '_sts_smoke.js');
          fs.writeFileSync(scriptPath, smoke.code);
          const run = record(await limited('node', [scriptPath], { cwd: repoDir, env, timeoutMs }));
          stdout = run.stdout;
          stderr = run.stderr;
          exitCode = run.code;
          timedOut = run.timedOut;
          runDuration = run.durationMs;
        }
        if (!error && exitCode !== 0) {
          error = overBudget ? `exceeded demo time budget of ${deadlineMs}ms` : timedOut ? `run timed out after ${Math.round(timeoutMs / 1000)}s` : `run exited ${exitCode}`;
        }
      } else {
        error = `no Python or JavaScript project detected (language=${language})`;
      }
    }

    const extracted = extractSample(stdout);
    const products = extractProducts(stdout);
    const runCommandLabel =
      commands.length > 0 ? commands[commands.length - 1].cmd : `${language} smoke`;
    const action = {
      repo: repo.pageUrl,
      language,
      commands,
      exit_code: error && !stdout ? commands.at(-1)?.exit_code ?? 1 : exitCode,
      duration_ms: Date.now() - started,
      run_duration_ms: runDuration,
      timestamp,
      extracted_sample: extracted,
      products,
      snippet: smoke?.code || null,
      stdout,
      stderr: (stderr || '').slice(-8000),
      timed_out: timedOut,
      over_budget: overBudget,
      smoke_source: smoke ? smoke.source : null,
      python: pythonVersion,
      python_provisioned: pythonProvisioned,
      install_step: installStep,
      install_attempts: installAttempts,
      install_stderr: installAttempts
        .filter((attempt) => attempt.exit_code !== 0 && attempt.stderr_tail)
        .map((attempt) => `${attempt.step}\n${attempt.stderr_tail}`)
        .join('\n')
        .slice(-4000) || null,
    };

    if (screenshotDir && !error) {
      const file = `${saveId || 'run'}-${Date.now()}.png`;
      const absolute = path.join(screenshotDir, file);
      try {
        await screenshotRun(
          {
            repo: repo.pageUrl,
            language,
            exitCode: action.exit_code,
            durationMs: runDuration || action.duration_ms,
            timedOut,
            stdout: stdout || stderr,
            extracted,
            products,
            source: smoke ? smoke.source : 'none',
            command: runCommandLabel,
          },
          absolute,
        );
        screenshotPath = `${screenshotPublicPrefix}/${file}`;
      } catch (err) {
        warning = `screenshot failed: ${err.message}`;
      }
    }

    action.screenshot_path = screenshotPath;
    action.warning = warning;
    return {
      stdout,
      screenshot_path: screenshotPath,
      action_result_json: action,
      warning,
      error,
    };
  } catch (err) {
    return failure(
      { stdout, screenshot_path: screenshotPath },
      err && err.message ? err.message : String(err),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function chooseSmoke({ repoUrl, readme, language }) {
  let smoke = extractQuickstart(readme, language);
  if (language === "python") {
    if (!smoke) smoke = generatedPythonSmoke();
    else if (smokeNeedsBasePackage(smoke.code)) smoke = baseSelectorSmoke();
  } else if (language === "javascript" && !smoke) {
    smoke = generatedJavaScriptSmoke();
  }
  if (/\/D4Vinci\/Scrapling$/i.test(repoUrl || "")) smoke = consumerProductSmoke();
  return smoke;
}

export { runRepo, normalizeRepoUrl, chooseSmoke, RUN_TIMEOUT_MS };
