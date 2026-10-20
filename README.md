# Saved to Shipped

Paste a public X post. It shows up in the feed as a card, gets sorted (repo, paper, idea, tool, event, or other), and gets a line on why it matters to you.

Sorting and the why-you line work with no API keys. The act stage (clone a repo, run it, screenshot it) is a later step.

## Run

```bash
npm install
npm test
npm run relate:demo
npm run seed
npm start
```

Open http://localhost:3000 and paste one of the seed posts:

- https://x.com/hasantoxr/status/2025902150296236050 — Scrapling, sorted as **repo**
- https://x.com/0xCodez/status/2069736449902027136 — Loop Engineering, sorted as **paper**
- https://x.com/cyrilXBT/status/2069651792678510894 — Karpathy's second brain, sorted as **idea**

`npm run seed` loads those three fixtures into `data/saves.sqlite` through the same pipeline. It does not call the network. Pass `--live` to try a live fetch first.

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

## Why you

After sort, and before act, `runPipeline` in `src/pipeline.js` calls `relate(save, profile)` and stores the sentence on `saves.why_you`. The detail page already prints that column when it is set. This step does not change the card or detail markup.

```js
import { loadProfile } from "./src/profile.js";
import { relate, relateAndStore } from "./src/relate.js";

const profile = loadProfile(); // data/profile.json
const whyYou = await relate(save, profile);
await relateAndStore(db, save, profile);
```

`relate(save, profile)` returns one or two sentences. `relateAndStore` writes `saves.why_you`. `save` needs `id`, `url`, `text`, `kind`, and optionally `summary`.

`data/profile.json` is Srinikhil's profile. `summary` and `building` are enough on their own. `interests` and `keywords` are optional overlap hints. The reader also accepts a plain string, a nested `profile` object, or comma-separated lists, so a different profile file from step 1 still loads.

With no `XAI_API_KEY`, a keyword fallback maps overlaps between the save and the profile into a sentence for that kind (`repo`, `tool`, `paper`, `idea`, `event`, `other`). For the three seeds that is:

- Scrapling (repo): a drop-in for the scraping pipeline
- Loop Engineering (paper): how this startup runs its agent and scrape loops, and that Saved to Shipped is itself one of those loops
- Karpathy's second brain (idea): a knowledge base of products, founders, and user signals

Set `XAI_API_KEY` to ask Grok instead. The call is `POST https://api.x.ai/v1/chat/completions` (xAI's OpenAI-compatible endpoint), model `grok-4.7`, 8 second timeout, `reasoning_effort: "low"`. Optional overrides: `XAI_MODEL` and `XAI_BASE_URL` (default `https://api.x.ai/v1`). `LLM_API_KEY` is not read. Any error, timeout, or empty body falls back to the keyword line with no log.

Results are cached in `data/relate-cache.json`, keyed by save id, URL, and a hash of the profile. A cached Grok line replays with no network, including when the key is still set and the machine is offline.

```bash
npm run relate:demo
```

That prints the three fallback lines. It passes an empty env, so a key in the shell does not change the output.

## Data

SQLite table `saves`: url, author, text, created_at, kind, status (`queued`, `sorting`, `acting`, `done`, `failed`), summary, why_you, action_result_json, screenshot_path, error.

`data/profile.json` is the profile the why-you step reads. `npm run relate:demo` prints the three lines without a key.

`src/act.js` is the act stage. Step 1 records a skip. The repo runner (temp dir, install, ~90s timeout, screenshot, cached replay) replaces `actOnRepo` next.
