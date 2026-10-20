import { spawn } from "node:child_process";
import { envForSpawn } from "./env.js";

const HEAD_CAP = 120_000;
const TAIL_CAP = 40_000;

function capHead(text) {
  if (text.length <= HEAD_CAP) return text;
  return text.slice(0, HEAD_CAP) + '\n…[truncated]';
}

function capTail(text) {
  if (text.length <= TAIL_CAP) return text;
  return '…[truncated]\n' + text.slice(-TAIL_CAP);
}

function killTree(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command. `env` must be an allowlist from allowlistedEnv(); spawn
 * never receives process.env. On timeout, SIGKILL the process group.
 */
function runCommand(cmd, args, { cwd, env, timeoutMs }) {
  const childEnv = envForSpawn(env);
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backup);
      resolve({
        cmd: [cmd, ...args].join(' '),
        code: code ?? 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    try {
      child = spawn(cmd, args, {
        cwd,
        env: childEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      stderr = String(err && err.message ? err.message : err);
      finish(127);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = capHead(stdout + chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = capTail(stderr + chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stderr = capTail(stderr + `\n[killed] exceeded ${timeoutMs}ms timeout\n`);
      killTree(child.pid);
    }, timeoutMs);

    const backup = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        killTree(child.pid);
        finish(124);
      }
    }, timeoutMs + 3000);

    child.on('error', (err) => {
      stderr = capTail(stderr + String(err && err.message ? err.message : err));
      killTree(child.pid);
      finish(127);
    });

    child.on('close', (code) => {
      finish(timedOut ? 124 : code ?? 1);
    });
  });
}

export { runCommand, killTree };
