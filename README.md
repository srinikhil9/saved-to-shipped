# Saved to Shipped

Paste a public X post. It shows up in the feed as a card, then gets sorted: repo, paper, idea, tool, event, or other.

This is step 1. Sorting works with no API keys. The act stage (clone a repo, run it, screenshot it) is the next step.

Requires Node.js 22 or newer. `.nvmrc` is `24` (the demo laptop is Node v24.14.0). On that version `better-sqlite3` installs from a prebuilt binary.

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

`npm run seed` loads those three fixtures into `data/saves.sqlite` through the same pipeline. It does not call the network. Pass `--live` to try a live fetch first.

The card is saved as `queued` immediately. For a seed post, the saved copy is sorted right away and a live read updates the card if it comes back. Each outbound request times out after 3 seconds. The page script refreshes cards that are still in progress. Pasting a link that is already saved returns that card.

## Offline

Live fetch tries, in order, with no X API key:

1. `https://api.fxtwitter.com/status/:id` (full note text)
2. `https://cdn.syndication.twimg.com/tweet-result` (public syndication)
3. `https://publish.twitter.com/oembed` (short text)

`t.co` links are followed to their destination. If the post says the link is in a reply, the author's own reply on that post is read too. Scrapling's GitHub repo is in that first reply: https://github.com/D4Vinci/Scrapling

A successful live read is written to `data/live-cache/` and reused when the network is down. The three files in `fixtures/` are the seed copies. `INGEST_OFFLINE=1` skips the network and uses the cache, then those fixtures. Run again keeps the previous card when a refetch fails.

## Sort

With no `XAI_API_KEY`, a regex/heuristic decides the kind: a `github.com/owner/repo` URL is a repo, an arXiv or `.pdf` URL (or an "N-page PDF") is a paper, and so on.

Set `XAI_API_KEY` to sort with Grok instead. The call goes to `https://api.x.ai/v1` and the default model is `grok-4.7`. Set `XAI_MODEL` to use a different Grok model. A failed model call falls back to the heuristic. The key is not passed into the child environment the repo runner will use.

## Data

SQLite table `saves`: url, author, text, created_at, kind, status (`queued`, `sorting`, `acting`, `done`, `failed`), summary, why_you, action_result_json, screenshot_path, error.

`data/profile.json` is Srinikhil's profile for the later "why you" step. `why_you` stays empty for now.

`src/act.js` is the act stage. Step 1 records a skip. The repo runner (temp dir, install, ~90s timeout, screenshot, cached replay) replaces `actOnRepo` next.
