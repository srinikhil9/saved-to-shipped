# Bot API

A bot can save posts, read the feed, pull a digest, and push its memory of the user. No browser and no API key. `INGEST_OFFLINE=1` still skips the network.

Base URL in the examples is `http://localhost:3000`. Send `accept: application/json` and `content-type: application/json` on writes.

## Save a post

```bash
curl -s -X POST http://localhost:3000/api/saves \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"url":"https://x.com/hasantoxr/status/2025902150296236050"}'
```

`201` for a new save, `200` if that URL is already saved, `400` if the URL is not a public X status.

```json
{
  "id": 1,
  "url": "https://x.com/hasantoxr/status/2025902150296236050",
  "author": null,
  "text": null,
  "created_at": "2026-10-20T02:40:00.000Z",
  "kind": null,
  "status": "queued",
  "summary": null,
  "why_you": null,
  "why_you_source": null,
  "why_you_profile_hash": null,
  "action_result_json": null,
  "screenshot_path": null,
  "error": null
}
```

The row is `queued` immediately. Poll `GET /api/saves/:id` until `status` is `done` or `failed`.

## List saves

```bash
curl -s http://localhost:3000/api/saves
```

Returns a JSON array of the same save objects, newest first.

## Digest

```bash
curl -s 'http://localhost:3000/api/digest'
curl -s 'http://localhost:3000/api/digest?since=2026-10-13T00:00:00.000Z'
```

`since` is optional and defaults to the last 7 days. It must be an ISO timestamp (`400` otherwise). Counts and the top list only include saves created at or after `since`.

`tried` counts saves whose act stage really ran: a repo run, a spec, or a starter. Tool and event results, a README-only repo cache, skipped kinds, and saves with no act payload are not counted. Ranking is deterministic keyword overlap with the active profile. It does not call a model.

```json
{
  "saved": 3,
  "tried": 3,
  "since": "2026-10-13T02:40:00.000Z",
  "top": [
    {
      "id": 1,
      "url": "https://x.com/hasantoxr/status/2025902150296236050",
      "title": "Hasan Toor (@hasantoxr)",
      "kind": "repo",
      "why_you": "Drop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.",
      "action": "repo run ok in 8.9s",
      "score": 12
    }
  ],
  "markdown": "You saved 3, I tried 3, here are the 2 worth your time\n\nHasan Toor (@hasantoxr) · repo\nDrop-in for your social-data scraping pipeline: use it to pull user posts at scale for product recommendations.\nrepo run ok in 8.9s\n"
}
```

`top` has at most two items. Each markdown block is the title, kind, `why_you`, and one action line (`repo run ok in Ns`, `repo run failed`, `spec zip https://host/artifacts/...`, `try-it steps`, `.ics added`, or `README cached`). Zip links are absolute. Set `BASE_URL` (for example `https://demo.example`) to choose the origin; otherwise the link uses the request host.

## Read the profile

```bash
curl -s http://localhost:3000/api/profile
```

Before anything is pushed, this is `data/profile.json` plus `source: "default"` and `synced_at: null`.

```json
{
  "source": "default",
  "synced_at": null,
  "name": "Srinikhil",
  "summary": "Srinikhil is building a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups.",
  "building": "a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups",
  "why": {
    "focus": "your social-data recommender",
    "pipeline": "social-data scraping pipeline"
  }
}
```

## Push memory

```bash
curl -s -X PUT http://localhost:3000/api/profile \
  -H 'content-type: application/json' \
  -d '{"startup":"desk tools","stack":"browser-extension pipeline","projects":["DeskKit"],"interests":["local-first notes"]}'
```

The body is a JSON object. Useful fields:

| Field | Shape |
| --- | --- |
| `name`, `summary`, `building`, `startup` | string |
| `stack`, `projects`, `interests` | string or list of strings |
| `why` | object of strings (`focus`, `pipeline`, `use`, `agents`, `product`, `memory`, `wiki`, `reader`) |

Unknown string fields are kept. Non-JSON, a non-object body, and wrong types are `400` with `{ "error": "..." }`.

The profile is stored in SQLite. Digest ranking uses the pushed fields. `why_you` keeps the short phrases in `data/profile.json`. `startup`, `stack`, `projects`, and `interests` are not copied into those phrases, so a list or a long sentence cannot rewrite the seed lines. Send `why` only when a value is already a short phrase (48 characters or fewer, not a sentence, and not a three-item list). Anything longer is ignored and the file phrase stays. The three seed lines (Scrapling, Loop Engineering, the second brain) always use the file phrases, even when `why` is sent. A line Grok already wrote is left alone.

```json
{
  "source": "bot",
  "synced_at": "2026-10-20T02:41:00.000Z",
  "startup": "the social-data recommender",
  "stack": ["Node", "Express", "SQLite"],
  "interests": ["consumer products", "AI agents"],
  "why": {
    "pipeline": "social-data scraping pipeline",
    "use": "pull user posts at scale for product recommendations"
  }
}
```

The feed badge reads `Profile from Grok Bot memory, synced <local time>` after a push, and `Default profile` otherwise. The page formats `synced_at` in the viewer's local timezone. The JSON value stays an ISO timestamp.

## Reset the profile

```bash
curl -s -X DELETE http://localhost:3000/api/profile
```

Deletes the pushed row and returns the static profile with `source: "default"` and `synced_at: null`. The feed badge goes back to `Default profile`. Grok-written `why_you` lines are not changed.
