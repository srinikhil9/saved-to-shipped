import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectBrowser } from "../src/runner/browser.js";
import { detectLanguage, readOptionalDeps } from "../src/runner/detect.js";
import { allowlistedEnv, envForSpawn, SECRET_ENV_NAME } from "../src/runner/env.js";
import { runCommand } from "../src/runner/exec.js";
import { extractQuickstart, extractSample, pythonInstallSpec } from "../src/runner/quickstart.js";
import { normalizeRepoUrl } from "../src/runner/runRepo.js";
import { renderRunHtml, screenshotRun } from "../src/runner/screenshot.js";

test('child processes do not receive parent secrets', async () => {
  process.env.OPENAI_API_KEY = 'sk-dummy-openai';
  process.env.LLM_API_KEY = 'llm-dummy';
  process.env.GITHUB_TOKEN = 'ghp_should_not_leak';
  process.env.HF_TOKEN = 'hf_dummy';
  process.env.AWS_SECRET_ACCESS_KEY = 'super-secret-value';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-env-'));
  const env = allowlistedEnv({ home, pipCacheDir: path.join(home, 'pip') });
  assert.deepEqual(Object.keys(envForSpawn(env)).sort(), Object.keys(env).sort());
  assert.equal(env.HOME, home);
  assert.equal(env.TMPDIR, home);
  assert.equal(env.LANG, 'C.UTF-8');
  assert.ok(env.PATH);
  for (const key of Object.keys(env)) {
    assert.equal(SECRET_ENV_NAME.test(key), false, key);
  }
  assert.equal(env.OPENAI_API_KEY, undefined);

  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { cwd: home, env, timeoutMs: 5000 },
  );
  assert.equal(result.code, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.LLM_API_KEY, undefined);
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.HF_TOKEN, undefined);
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.HOME, home);
  for (const key of Object.keys(child)) {
    assert.equal(SECRET_ENV_NAME.test(key), false, key);
    assert.doesNotMatch(key, /_KEY$|_TOKEN$/);
  }
  assert.doesNotMatch(result.stdout, /sk-dummy-openai|ghp_should_not_leak|super-secret-value/);

  assert.throws(() => envForSpawn(process.env), /process\.env/);
  assert.throws(() => envForSpawn({ ...process.env, HOME: home, PATH: env.PATH }), /OPENAI_API_KEY/);
  assert.throws(
    () => runCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: home, env: process.env, timeoutMs: 1000 }),
    /process\.env/,
  );
});

test('timeout kills the process group', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-kill-'));
  const result = await runCommand(
    process.execPath,
    ['-e', 'console.log(process.pid); setInterval(() => {}, 1000);'],
    { cwd: home, env: allowlistedEnv({ home }), timeoutMs: 500 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  const pid = Number(String(result.stdout).trim().split('\n')[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0));
});

test('detects python vs javascript and optional extras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lang-'));
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project.optional-dependencies]\nfetchers = [\n "curl_cffi"\n]\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  assert.equal(detectLanguage(dir), 'python');
  assert.deepEqual(readOptionalDeps(dir), ['fetchers']);
  assert.equal(pythonInstallSpec(['fetchers'], 'from scrapling.fetchers import Fetcher\n'), '.[fetchers]');
  assert.equal(pythonInstallSpec(['fetchers'], 'print(1)\n'), '.');

  const js = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-js-'));
  fs.writeFileSync(path.join(js, 'package.json'), '{"name":"demo"}');
  assert.equal(detectLanguage(js), 'javascript');
});

test('readme quickstart prefers the short fetch example', () => {
  const readme = `
\`\`\`python
from scrapling.fetchers import Fetcher

page = Fetcher.get('https://quotes.toscrape.com/')
quotes = page.css('.quote .text::text').getall()
print(quotes)
\`\`\`

\`\`\`python
class QuotesSpider:
    async def parse(self, response):
        print(response)
\`\`\`
`;
  const quick = extractQuickstart(readme, 'python');
  assert.equal(quick.source, 'readme');
  assert.match(quick.code, /Fetcher\.get/);
  assert.doesNotMatch(quick.code, /QuotesSpider/);
});

test('extracts quote strings from python stdout', () => {
  const stdout = `['“The world as we have created it is a process of our thinking.”', "“It is our choices, Harry, that show what we truly are, far more than our abilities.”", "“Imperfection is beauty, madness is genius and it's better to be absolutely ridiculous than absolutely boring.”"]\n`;
  const sample = extractSample(stdout);
  assert.equal(sample.length, 3);
  assert.match(sample[0], /world as we have created/);
  assert.match(sample[2], /it's better to be absolutely ridiculous/);
  assert.ok(sample.every((item) => !item.includes("\\")));
});

test('normalizes github repo urls and rejects others', () => {
  assert.equal(normalizeRepoUrl('https://github.com/D4Vinci/Scrapling').cloneUrl, 'https://github.com/D4Vinci/Scrapling.git');
  assert.equal(normalizeRepoUrl('https://github.com/D4Vinci/Scrapling.git').pageUrl, 'https://github.com/D4Vinci/Scrapling');
  assert.throws(() => normalizeRepoUrl('https://example.com/not/github'));
});

test('screenshot html shows extracted quotes', () => {
  const html = renderRunHtml({
    repo: 'https://github.com/D4Vinci/Scrapling',
    language: 'python',
    exitCode: 0,
    durationMs: 1200,
    stdout: "['“Hello from the scrape.”']",
    extracted: ['Hello from the scrape.'],
    source: 'readme',
    command: '.venv/bin/python -u _sts_smoke.py',
  });
  assert.match(html, /Hello from the scrape/);
  assert.match(html, /Saved to Shipped/);
  assert.doesNotMatch(html, /<script/i);
});

test('screenshot png is a real image', async (t) => {
  let found;
  try {
    found = detectBrowser();
  } catch (error) {
    t.skip(error instanceof Error ? error.message : 'Chrome is not installed');
    return;
  }
  if (!found.executablePath) {
    t.skip('Chrome is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-shot-'));
  const out = path.join(dir, 'run.png');
  await screenshotRun(
    {
      repo: 'https://github.com/D4Vinci/Scrapling',
      language: 'python',
      exitCode: 0,
      durationMs: 1800,
      stdout: "['“The world as we have created it is a process of our thinking.”']",
      extracted: ['The world as we have created it is a process of our thinking.'],
      source: 'readme',
      command: '.venv/bin/python -u _sts_smoke.py',
    },
    out,
  );
  const buf = fs.readFileSync(out);
  assert.ok(buf.length > 1000);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
