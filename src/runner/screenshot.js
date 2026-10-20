import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBrowser } from "./browser.js";
import { allowlistedEnv } from "./env.js";

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function renderRunHtml(run) {
  const quotes = (run.extracted || []).slice(0, 4);
  const quoteHtml = quotes.length
    ? quotes
        .map(
          (quote) => `<article class="quote"><span class="mark">“</span><p>${escapeHtml(quote)}</p></article>`,
        )
        .join('')
    : `<article class="quote empty"><p>No extracted items in stdout.</p></article>`;
  const status = run.timedOut ? 'timed out' : run.exitCode === 0 ? 'passed' : 'failed';
  const statusClass = run.exitCode === 0 && !run.timedOut ? 'ok' : 'bad';
  const seconds = (Number(run.durationMs || 0) / 1000).toFixed(1);
  const stdout = String(run.stdout || '').slice(0, 4000);
  const repoName = run.repo ? run.repo.replace(/\/$/, '').split('/').slice(-2).join('/') : 'repo';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(repoName)} run</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background:
      radial-gradient(1200px 500px at 10% -10%, rgba(56, 189, 248, 0.16), transparent 50%),
      radial-gradient(900px 400px at 100% 0%, rgba(249, 115, 22, 0.14), transparent 45%),
      #0c1017;
    color: #e8eef7;
    font-family: Inter, "Noto Sans", ui-sans-serif, system-ui, sans-serif;
    padding: 28px 32px 24px;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .brand { letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; color: #93a4bd; }
  h1 { margin: 6px 0 0; font-size: 32px; letter-spacing: -0.03em; }
  h1 span { color: #8b9cb3; font-weight: 500; }
  .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .pill {
    border: 1px solid #2a3548;
    background: #141b27;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 13px;
    color: #c5d2e4;
  }
  .pill.ok { color: #86efac; border-color: #14532d; background: #052e16; }
  .pill.bad { color: #fda4af; border-color: #7f1d1d; background: #3f0a12; }
  .quotes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 18px 0 16px; }
  .quote {
    background: linear-gradient(180deg, #161d2b, #121826);
    border: 1px solid #263246;
    border-radius: 14px;
    padding: 14px 16px 12px;
    min-height: 92px;
  }
  .quote p { margin: 0; font-size: 15px; line-height: 1.4; color: #f8fafc; }
  .mark { display: block; color: #fb923c; font-size: 28px; line-height: 1; margin-bottom: 4px; }
  .term {
    background: #070b11;
    border: 1px solid #243044;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
  }
  .bar {
    display: flex; align-items: center; gap: 8px;
    background: #121926;
    padding: 10px 14px;
    color: #8ea0b8;
    font-family: "Noto Sans Mono", ui-monospace, monospace;
    font-size: 12px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.r { background: #f87171; } .dot.y { background: #fbbf24; } .dot.g { background: #4ade80; }
  .bar .title { margin-left: 8px; }
  pre {
    margin: 0;
    padding: 14px 16px 18px;
    max-height: 280px;
    overflow: hidden;
    font-family: "Noto Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #86efac;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
</head>
<body>
  <header>
    <div>
      <div class="brand">Saved to Shipped · last run</div>
      <h1>${escapeHtml(repoName.split('/')[1] || repoName)} <span>${escapeHtml(run.language || '')}</span></h1>
    </div>
    <div class="meta">
      <span class="pill ${statusClass}">${escapeHtml(status)} · exit ${escapeHtml(run.exitCode)}</span>
      <span class="pill">${escapeHtml(seconds)}s</span>
      <span class="pill">${escapeHtml(run.source || 'quickstart')}</span>
    </div>
  </header>
  <section class="quotes">${quoteHtml}</section>
  <section class="term">
    <div class="bar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">${escapeHtml(run.command || 'smoke')}</span>
    </div>
    <pre>${escapeHtml(stdout || '(no output)')}</pre>
  </section>
</body>
</html>`;
}

async function screenshotRun(run, outPath) {
  const { chromium } = await import("playwright-core");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const found = detectBrowser();
  const browser = await chromium.launch({
    ...(found.executablePath ? { executablePath: found.executablePath } : { channel: found.channel || "chrome" }),
    env: allowlistedEnv({ home: os.tmpdir() }),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.setContent(renderRunHtml(run), { waitUntil: 'load' });
    await page.screenshot({ path: outPath, type: 'png' });
  } finally {
    await browser.close();
  }
  return outPath;
}

export { renderRunHtml, screenshotRun, escapeHtml };
