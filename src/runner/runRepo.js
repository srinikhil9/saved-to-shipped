import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLanguage, readOptionalDeps } from "./detect.js";
import { allowlistedEnv } from "./env.js";
import { runCommand } from "./exec.js";
import {
  extractQuickstart,
  extractSample,
  generatedJavaScriptSmoke,
  generatedPythonSmoke,
  pythonInstallSpec,
} from "./quickstart.js";
import { screenshotRun } from "./screenshot.js";

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
  onLog = () => {},
} = {}) {
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
  const pipCache = path.join(process.cwd(), 'data', 'pip-cache');
  fs.mkdirSync(pipCache, { recursive: true });
  const env = allowlistedEnv({ home, pipCacheDir: pipCache });
  let language = 'unknown';
  let smoke = null;
  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let timedOut = false;
  let runDuration = 0;
  let screenshotPath = null;
  let error = null;

  const record = (result) => {
    commands.push(commandRecord(result));
    onLog(`${result.cmd} → ${result.code} (${result.durationMs}ms)${result.timedOut ? ' timeout' : ''}`);
    return result;
  };

  try {
    const clone = record(
      await runCommand('git', ['clone', '--depth', '1', repo.cloneUrl, repoDir], {
        cwd: home,
        env,
        timeoutMs: CLONE_TIMEOUT_MS,
      }),
    );
    if (clone.code !== 0) {
      error = clone.timedOut ? 'clone timed out' : `clone failed (${clone.code})`;
      stderr = clone.stderr;
    } else {
      language = detectLanguage(repoDir);
      const readmeName = fs.readdirSync(repoDir).find((name) => /^readme(\.|$)/i.test(name));
      const readme = readmeName ? fs.readFileSync(path.join(repoDir, readmeName), 'utf8') : '';
      smoke = extractQuickstart(readme, language);

      if (language === 'python') {
        if (!smoke) smoke = generatedPythonSmoke();
        const py = path.join(repoDir, '.venv', 'bin', 'python');
        const pip = path.join(repoDir, '.venv', 'bin', 'pip');
        const venv = record(
          await runCommand('python3', ['-m', 'venv', path.join(repoDir, '.venv')], {
            cwd: repoDir,
            env,
            timeoutMs: 60_000,
          }),
        );
        if (venv.code !== 0) {
          error = venv.timedOut ? 'venv creation timed out' : `venv creation failed (${venv.code})`;
          stderr = venv.stderr;
        } else {
          const spec = pythonInstallSpec(readOptionalDeps(repoDir), smoke.code || '');
          const hasProject = fs.existsSync(path.join(repoDir, 'pyproject.toml')) || fs.existsSync(path.join(repoDir, 'setup.py'));
          const hasReqs = fs.existsSync(path.join(repoDir, 'requirements.txt'));
          let installArgs = null;
          if (hasProject) installArgs = ['install', spec];
          else if (hasReqs) installArgs = ['install', '-r', 'requirements.txt'];
          if (installArgs) {
            const install = record(
              await runCommand(pip, installArgs, { cwd: repoDir, env, timeoutMs: installTimeoutMs }),
            );
            if (install.code !== 0) {
              error = install.timedOut ? 'install timed out' : `install failed (${install.code})`;
              stderr = install.stderr;
            }
          }
        }

        if (!error) {
          const scriptPath = path.join(repoDir, '_sts_smoke.py');
          if (smoke.kind === 'shell') {
            const run = record(
              await runCommand('bash', ['-c', smoke.command], {
                cwd: repoDir,
                env: allowlistedEnv({
                  home,
                  pathPrefix: path.join(repoDir, '.venv', 'bin'),
                  pipCacheDir: pipCache,
                }),
                timeoutMs,
              }),
            );
            stdout = run.stdout;
            stderr = run.stderr;
            exitCode = run.code;
            timedOut = run.timedOut;
            runDuration = run.durationMs;
          } else {
            fs.writeFileSync(scriptPath, smoke.code);
            const run = record(
              await runCommand(py, ['-u', scriptPath], { cwd: repoDir, env, timeoutMs }),
            );
            stdout = run.stdout;
            stderr = run.stderr;
            exitCode = run.code;
            timedOut = run.timedOut;
            runDuration = run.durationMs;
          }
          if (exitCode !== 0 && !error) {
            error = timedOut ? `run timed out after ${Math.round(timeoutMs / 1000)}s` : `run exited ${exitCode}`;
          }
        }
      } else if (language === 'javascript') {
        if (!smoke) smoke = generatedJavaScriptSmoke();
        const install = record(
          await runCommand('npm', ['install', '--no-audit', '--no-fund'], {
            cwd: repoDir,
            env,
            timeoutMs: installTimeoutMs,
          }),
        );
        if (install.code !== 0) {
          error = install.timedOut ? 'npm install timed out' : `npm install failed (${install.code})`;
          stderr = install.stderr;
        } else if (smoke.kind === 'shell') {
          const run = record(
            await runCommand('bash', ['-c', smoke.command], { cwd: repoDir, env, timeoutMs }),
          );
          stdout = run.stdout;
          stderr = run.stderr;
          exitCode = run.code;
          timedOut = run.timedOut;
          runDuration = run.durationMs;
        } else {
          const scriptPath = path.join(repoDir, '_sts_smoke.js');
          fs.writeFileSync(scriptPath, smoke.code);
          const run = record(await runCommand('node', [scriptPath], { cwd: repoDir, env, timeoutMs }));
          stdout = run.stdout;
          stderr = run.stderr;
          exitCode = run.code;
          timedOut = run.timedOut;
          runDuration = run.durationMs;
        }
        if (!error && exitCode !== 0) {
          error = timedOut ? `run timed out after ${Math.round(timeoutMs / 1000)}s` : `run exited ${exitCode}`;
        }
      } else {
        error = `no Python or JavaScript project detected (language=${language})`;
      }
    }

    const extracted = extractSample(stdout);
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
      stdout,
      stderr: (stderr || '').slice(-8000),
      timed_out: timedOut,
      smoke_source: smoke ? smoke.source : null,
    };

    if (screenshotDir) {
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
            source: smoke ? smoke.source : 'none',
            command: runCommandLabel,
          },
          absolute,
        );
        screenshotPath = `${screenshotPublicPrefix}/${file}`;
      } catch (err) {
        const shotError = `screenshot failed: ${err.message}`;
        error = error ? `${error}; ${shotError}` : shotError;
      }
    }

    action.screenshot_path = screenshotPath;
    return {
      stdout,
      screenshot_path: screenshotPath,
      action_result_json: action,
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

export { runRepo, normalizeRepoUrl, RUN_TIMEOUT_MS };
