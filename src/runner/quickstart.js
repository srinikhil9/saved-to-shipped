const FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;

function extractFences(readme) {
  const blocks = [];
  for (const match of String(readme || '').matchAll(FENCE)) {
    blocks.push({ lang: (match[1] || '').toLowerCase(), code: match[2].replace(/\s+$/, '') });
  }
  return blocks;
}

function scorePython(code) {
  let score = 0;
  if (/print\s*\(/.test(code)) score += 2;
  if (/https?:\/\//.test(code)) score += 3;
  if (/^\s*(import|from)\s+/m.test(code)) score += 1;
  if (/Fetcher\.get|requests\.get|httpx\.|urlopen/.test(code)) score += 2;
  if (/async\s+def|class\s+\w+\(/.test(code)) score -= 2;
  return score;
}

function scoreJavaScript(code) {
  let score = 0;
  if (/console\.log/.test(code)) score += 2;
  if (/https?:\/\//.test(code)) score += 3;
  if (/require\(|import /.test(code)) score += 1;
  return score;
}

function firstRunnableShell(code) {
  const lines = code
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^(pip|pip3|npm|pnpm|yarn|docker|cd|export|sudo|git|scrapling install)\b/.test(line)) continue;
    if (/^(python|python3|node|npm start|npm run)\b/.test(line)) return line;
  }
  return null;
}

/**
 * Pull a README quickstart, preferring a short Python/JS snippet that
 * actually fetches a page. Returns null when the README has nothing runnable.
 */
function extractQuickstart(readme, language) {
  const blocks = extractFences(readme);
  if (language === 'python') {
    const ranked = blocks
      .filter((b) => b.lang === 'python' || b.lang === 'py')
      .map((b) => ({ ...b, score: scorePython(b.code) }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 3) {
      return { kind: 'python', code: ranked[0].code.trim() + '\n', source: 'readme' };
    }
  }
  if (language === 'javascript') {
    const ranked = blocks
      .filter((b) => ['js', 'javascript', 'node', 'ts', 'typescript'].includes(b.lang))
      .map((b) => ({ ...b, score: scoreJavaScript(b.code) }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 3) {
      return { kind: 'javascript', code: ranked[0].code.trim() + '\n', source: 'readme' };
    }
  }
  for (const block of blocks) {
    if (!['bash', 'sh', 'shell', 'console', 'zsh'].includes(block.lang)) continue;
    const command = firstRunnableShell(block.code);
    if (command) return { kind: 'shell', command, source: 'readme' };
  }
  return null;
}

function generatedPythonSmoke() {
  return {
    kind: 'python',
    source: 'generated',
    code: `import re
import urllib.request

url = "https://quotes.toscrape.com/"
with urllib.request.urlopen(url, timeout=30) as response:
    html = response.read().decode("utf-8", "replace")
quotes = re.findall(r'class="text"[^>]*>(.*?)<', html)
print(f"scraped {len(quotes)} quotes from {url}")
for quote in quotes[:5]:
    print("-", quote)
`,
  };
}

function generatedJavaScriptSmoke() {
  return {
    kind: 'javascript',
    source: 'generated',
    code: `const https = require('https');
const url = 'https://quotes.toscrape.com/';
https.get(url, (res) => {
  let html = '';
  res.on('data', (chunk) => { html += chunk; });
  res.on('end', () => {
    const quotes = [...html.matchAll(/class="text"[^>]*>(.*?)</g)].map((m) => m[1]);
    console.log('scraped ' + quotes.length + ' quotes from ' + url);
    for (const quote of quotes.slice(0, 5)) console.log('- ' + quote);
  });
}).on('error', (err) => {
  console.error(err);
  process.exit(1);
});
`,
  };
}

function pythonInstallSpec(optionalDeps, code) {
  const wanted = [];
  if (optionalDeps.includes('fetchers') && /scrapling\.(fetchers|spiders)/.test(code || '')) {
    wanted.push('fetchers');
  }
  return wanted.length ? `.[${wanted.join(',')}]` : '.';
}

/**
 * Pull a few human-readable items out of a scrape's stdout for the card.
 */
function extractSample(stdout) {
  const text = String(stdout || "");
  const curly = [];
  const seen = new Set();
  for (const match of text.matchAll(/“([^”]{8,400})”/g)) {
    const cleaned = match[1].replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    curly.push(cleaned);
  }
  if (curly.length) return curly.slice(0, 8);

  const items = [];
  const push = (value) => {
    const cleaned = value
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < 8 || cleaned.length > 400) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    items.push(cleaned);
  };

  for (const match of text.matchAll(/^\s*-\s+(.+)$/gm)) push(match[1]);
  for (const match of text.matchAll(/"((?:\\.|[^"\\]){8,400})"/g)) push(match[1]);
  for (const match of text.matchAll(/'((?:\\.|[^'\\]){8,400})'/g)) push(match[1]);
  return items.slice(0, 8);
}

export {
  extractQuickstart,
  generatedPythonSmoke,
  generatedJavaScriptSmoke,
  pythonInstallSpec,
  extractSample,
};
