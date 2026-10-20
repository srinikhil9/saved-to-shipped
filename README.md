# Saved to Shipped

Paste a public X post. It shows up in the feed as a card, then gets sorted: repo, paper, idea, tool, event, or other. A repo save is cloned, installed, and run. The detail page replays the last run from cache.

## Run

```bash
npm install
npm test
npm run seed
npm start
```

Open http://localhost:3000 and paste one of the seed posts:

- https://x.com/hasantoxr/status/2025902150296236050 — Scrapling, sorted as **repo**
- https://x.com/0xCodez/status/2069736449902027136 — Loop Engineering, sorted as **paper**
- https://x.com/cyrilXBT/status/2069651792678510894 — Karpathy's second brain, sorted as **idea**

`npm run seed` loads those three fixtures into `data/saves.sqlite` through the same pipeline. It does not call the network. The Scrapling card replays a committed run (`fixtures/repo-runs/scrapling/`: stdout, screenshot, and JSON) so the detail page works offline. Pass `--live` to fetch the post from the network and actually clone and run the repo.

`POST /api/saves/:id/rerun` (or **Run again** on the detail page) sorts the save again. Offline (`INGEST_OFFLINE=1` or `npm run seed`) replays the cache. A normal server run executes the repo.

The card is saved as `queued` immediately. The page updates when ingest and sort finish.

## Offline

Live fetch tries, in order:

1. `https://api.fxtwitter.com/status/:id` (full note text, no API key)
2. `https://cdn.syndication.twimg.com/tweet-result` (public syndication)
3. `https://publish.twitter.com/oembed` (short text)

`t.co` links are followed to their destination. If the post says the link is in a reply, the author's own reply on that post is read too. Scrapling's GitHub repo is in that first reply: https://github.com/D4Vinci/Scrapling

If the live fetch fails, the matching file in `fixtures/` is used. Known fixtures also fill in links the live payload missed. `INGEST_OFFLINE=1` skips the network and uses fixtures only.

## Sort

With no keys, a regex/heuristic decides the kind: a `github.com/owner/repo` URL is a repo, an arXiv or `.pdf` URL (or an "N-page PDF") is a paper, and so on.

Set `LLM_API_KEY` to use an OpenAI-compatible chat endpoint instead. Optional: `LLM_BASE_URL` (default `https://api.openai.com/v1`) and `LLM_MODEL` (default `gpt-4o-mini`). A failed model call falls back to the heuristic.

## Data

SQLite table `saves`: url, author, text, created_at, kind, status (`queued`, `sorting`, `acting`, `done`, `failed`), summary, why_you, action_result_json, screenshot_path, error.

`data/profile.json` is Srinikhil's profile for the later "why you" step. `why_you` stays empty for now.

`src/act.js` runs repos. Paper, idea, tool, and event actions are still stubs.

## Repo runner

For `kind=repo`, `actOnRepo` calls `runRepo({ saveId, repoUrl })` in `src/runner/`. It:

1. Clones the GitHub repo into a fresh temp directory (no Docker).
2. Detects Python or JavaScript and installs into a venv or local `node_modules`. Scrapling's README quickstart imports `scrapling.fetchers`, so the install includes that extra.
3. Runs the README quickstart, or a generated script that scrapes https://quotes.toscrape.com.
4. Kills the process tree if the run exceeds 90 seconds. Clone and install have separate ceilings.
5. Builds a fresh allowlist for every child (`PATH`, `HOME` and `TMPDIR` set to the temp dir, `LANG`, plus pip/npm settings). `spawn` never receives `process.env` or a spread of it. A parent `OPENAI_API_KEY`, `*_KEY`, or `*_TOKEN` is not visible in the child. `test/runner.test.js` dumps the child environment and checks that.
6. Writes a PNG of the terminal output (Chrome via Playwright) under `data/screenshots/` and stores stdout, the screenshot path, and `action_result_json` (repo, language, commands, exit code, duration, timestamp, extracted sample) on the save.

Run one repo from the shell (needs `python3-venv`, network, and Chrome for the screenshot):

```bash
npm run run-repo -- https://github.com/D4Vinci/Scrapling
```

Regenerate the committed Scrapling cache after a real run:

```bash
npm run seed:scrapling
```

The detail page heading **Show last run** renders that cached screenshot and stdout with no further network.
