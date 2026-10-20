# Saved to Shipped

Paste a public X post. It shows up in the feed as a card, then gets sorted: repo, paper, idea, tool, event, or other. A repo save is cloned, installed, and run. The detail page replays the last run from cache.

Requires Node.js 22 or newer. `.nvmrc` is `24` (the demo laptop is Node v24.14.0). On that version `better-sqlite3` installs from a prebuilt binary.

## Run

```bash
npm install
npm test
npm run prepare-python
npm run act:demo
npm run seed
npm start
```

`npm run prepare-python` is optional on a machine that already has Python 3.10 or newer. On the demo Mac, whose only interpreter is `/usr/bin/python3` (3.9.6), run it once before a live demo. It installs [uv](https://docs.astral.sh/uv/) into `.tools/` with the official standalone installer (no sudo, no Homebrew) and caches CPython 3.12 plus the Scrapling wheels. Later live runs reuse that cache. `INGEST_OFFLINE=1` makes this command a no-op: it does not download or provision.

Open http://localhost:3000 and paste one of the seed posts:

- https://x.com/hasantoxr/status/2025902150296236050 — Scrapling, sorted as **repo**
- https://x.com/0xCodez/status/2069736449902027136 — Loop Engineering, sorted as **paper**
- https://x.com/cyrilXBT/status/2069651792678510894 — Karpathy's second brain, sorted as **idea**

`npm run seed` loads those three fixtures into `data/saves.sqlite` through the same pipeline. It does not call the network. The Scrapling card replays a committed run (`fixtures/repo-runs/scrapling/`: stdout, screenshot, and JSON) so the detail page works offline. Pass `--live` to fetch the post from the network and actually clone and run the repo.

`POST /api/saves/:id/rerun` (or **Run again** on the detail page) sorts the save again. It does not clear the previous result first. Offline (`INGEST_OFFLINE=1` or `npm run seed`) replays the cache. A normal server run tries the repo, with a demo budget of 45 seconds (`DEMO_RUN_BUDGET_MS`). If that attempt fails or runs over the budget, the card stays on the last good run and says `showing last good run from <time>`. The failed attempt is kept on the act payload as `attempt_error` and does not replace stdout or the screenshot.

The card is saved as `queued` immediately. For a seed post, the saved copy is sorted right away and a live read updates the card if it comes back. Each outbound request times out after 3 seconds. The page script refreshes cards that are still in progress. Pasting a link that is already saved returns that card.

## Offline

Live fetch tries, in order, with no X API key:

1. `https://api.fxtwitter.com/status/:id` (full note text)
2. `https://cdn.syndication.twimg.com/tweet-result` (public syndication)
3. `https://publish.twitter.com/oembed` (short text)

`t.co` links are followed to their destination. If the post says the link is in a reply, the author's own reply on that post is read too. Scrapling's GitHub repo is in that first reply: https://github.com/D4Vinci/Scrapling

A successful live read is written to `data/live-cache/` and reused when the network is down. The three files in `fixtures/` are the seed copies. `INGEST_OFFLINE=1` skips the network and uses the cache, then those fixtures. It does not clone, pip-install, or provision Python. Run again keeps the previous card when a refetch fails.

## Sort

With no `XAI_API_KEY`, a regex/heuristic decides the kind: a `github.com/owner/repo` URL is a repo, an arXiv or `.pdf` URL (or an "N-page PDF") is a paper, and so on.

Set `XAI_API_KEY` to sort with Grok. The call goes to `https://api.x.ai/v1` and the default model is `grok-4.7` (`XAI_MODEL` overrides it). grok-4.7 accepts `reasoning_effort` (`low`, `medium`, `high`, `xhigh`; the default is `high`), `temperature` (0–2), and `response_format` `json_object`. This app sends `reasoning_effort: "low"`, `temperature: 0`, and `response_format: { "type": "json_object" }`, and gives the call 8 seconds. If the API rejects `reasoning_effort`, that field is dropped and the call is retried once.

The regex result is saved on the card first. Grok replaces that result in place when it answers. A live refresh of the same save does not call Grok again. A failed or timed-out call leaves the regex result. The key is not passed into the child environment the repo runner will use. Paper and idea specs use that same client; see below.

The detail page reloads on its own while a save is still running or a Grok upgrade is in flight. If the server stops during Run again, a card that already has a finished result comes back as that result. A first run that never finished is marked failed.

## Data

SQLite table `saves`: url, author, text, created_at, kind, status (`queued`, `sorting`, `acting`, `done`, `failed`), summary, why_you, action_result_json, screenshot_path, error.

`data/profile.json` is Srinikhil's profile. After a save is sorted, on either the Grok sort path or the no-key path, the pipeline writes a one-line `why_you` immediately: a short template per kind (`your social-data recommender`) plus keyword hits that cover the likely kinds for each seed (a scraping repo or tool, Loop Engineering as a paper or idea, the second brain as an idea, paper, or other). When `XAI_API_KEY` is set, Grok (`https://api.x.ai/v1`, `grok-4.7`, `reasoning_effort: low`, about 8 seconds) rewrites that line in the background from the profile and the post summary. The Grok line is stored on the row (`why_you_source` + profile hash) and reused offline, so a replay does not call again. No key, a timeout, or an error leaves the template. Empty rows that already have a kind are filled on startup, on seed, or on rerun. The line shows on the feed card and the detail page.

`src/act.js` runs repos, and writes a spec plus a starter zip for papers and ideas. Tool and event actions are still stubs.

## Repo runner

For `kind=repo`, `actOnRepo` calls `runRepo({ saveId, repoUrl })` in `src/runner/`. It:

1. Clones the GitHub repo into a fresh temp directory (no Docker).
2. Detects Python or JavaScript. Before creating a venv it reads `requires-python` and probes `python3.13` down through `python3` (including `/opt/homebrew/bin` and `/usr/local/bin` on macOS). Scrapling asks for `>=3.10`. Python 3.9 cannot install it (`cssselect>=1.5.0` has no 3.9 build), so a too-old interpreter is not used for pip.
3. If nothing on the machine satisfies that specifier, the runner installs uv into `.tools/uv` (or reuses `uv` already on `PATH`) and runs `uv python install 3.12`, then `uv venv --python 3.12`. The interpreter and wheel cache stay in `.tools/` so a warm run fits the demo budget. uv is spawned with the same scrubbed environment as git and pip, plus `UV_CACHE_DIR` / `UV_PYTHON_INSTALL_DIR` pointing at that cache. No secrets are copied in.
4. Once a new enough interpreter exists, install tries `.[fetchers]`, then the base project (`.`), then `pip install scrapling` from PyPI. The step that succeeded is stored as `install_step`. Failed stderr tails are stored as `install_stderr` and shown on the card. Other repos whose README imports `scrapling.fetchers` fall back to a base-package quotes smoke. Scrapling itself always runs the consumer-product scrape: `Fetcher.get` when that extra installed, otherwise `urllib` against https://yc-oss.github.io/api/tags/consumer.json. The YC directory page is a client-rendered shell, so the JSON endpoint is what the scrape reads.
5. If uv still cannot provide 3.12, the card records `needs Python >=3.10, found 3.9.6` and replays the cached run.
6. Kills the process tree if the run exceeds 90 seconds. Clone and install have separate ceilings, and each install step leaves time for the next one inside the demo budget.
7. Builds a fresh allowlist for every child (`PATH`, `HOME` and `TMPDIR` set to the temp dir, `LANG`, plus pip/npm/uv settings). `spawn` never receives `process.env` or a spread of it. A parent `OPENAI_API_KEY`, `*_KEY`, or `*_TOKEN` is not visible in the child. `test/runner.test.js` dumps the child environment and checks that.
8. Writes a PNG of the terminal output under `data/screenshots/`. The browser is `CHROME_PATH` if set, otherwise Chrome, Chromium, or Edge for the current OS (macOS looks in `/Applications/Google Chrome.app`), otherwise Playwright's Chrome channel. A screenshot failure is a warning: the card stays `done` and still stores stdout and `action_result_json`.

The runner builds that child environment itself. It does not use `sanitizedEnv()` from `src/env.js`. That helper is what the app passes as `childEnv` for other steps; the repo processes never see it.

Run one repo from the shell (network, and Chrome for the screenshot). `npm run prepare-python` first if the machine has no Python 3.10+:

```bash
npm run run-repo -- https://github.com/D4Vinci/Scrapling
```

Regenerate the committed Scrapling cache after a real run:

```bash
npm run seed:scrapling
```

The detail page heading **Show last run** renders that cached screenshot and stdout with no further network. The Scrapling detail page leads with a verdict (how long the cached run took, the why-you line, the snippet, and a next step) and a table of those products. The post, the sorted-by note, and raw stdout sit in a collapsed Details section. Offline replay still uses the committed cache.

## Paper and idea

For those two kinds the act stage writes a one-page `SPEC.md` aimed at the startup in `data/profile.json`, plus a starter folder, and zips them. The feed card and the save page link the zip (`/artifacts/<status id>/<name>.zip`) and `SPEC.md`.

- Loop Engineering (paper) → `loop/` with `schedule.mjs`, `discover.mjs`, `build.mjs`, and `verify.mjs`. The spec applies Schedule → Discover → Build → Verify → Repeat to the scrape → recommend pipeline, and notes that Saved to Shipped is the same loop.
- Karpathy's second brain (idea) → `sources/`, `wiki/`, and `INSTRUCTIONS.md` (how an agent ingests a source into linked wiki pages). The wiki is seeded with an index, a product template, a founder template, and one example signal.
- Any other paper or idea gets the same spec-plus-zip shape with a smaller `starter/` checklist.

Committed seed zips live in `data/artifacts/<status id>/` and are only read. A rerun reuses them. `POST /api/saves/:id/rerun` with `{"force": true}` writes a fresh copy under `data/artifacts-runtime/` (gitignored) and the server prefers that copy. `npm run act:demo` runs both seeds with no API key. It drops any `data/artifacts-runtime/` copy of those seeds first, then reads the committed files, so an earlier Grok spec cannot change the result. The committed files stay untouched.

The card is marked done from the template zip. When `XAI_API_KEY` is set, Grok then replaces `SPEC.md` in the background using `llmSettings` from `src/env.js` (`https://api.x.ai/v1`, `grok-4.7`, `XAI_MODEL` to override): `reasoning_effort: "low"`, an 8 second timeout, and one retry without that field if the API returns 400. No key, or any error, leaves the template. The repo runner still receives only the sanitized child environment, not the key.
