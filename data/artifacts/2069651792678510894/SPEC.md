# SPEC: A second brain for niche product recommendations

## Context

Srinikhil is building a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups.

The saved idea, from Andrej Karpathy via this post: stop using the model only to write code. Point it at a folder. Drop in a source. It reads it, links it, and files a wiki that compounds. The post sets up three things: a raw folder, a wiki, and a file that tells the agent how to run. This starter uses those roles as `sources/`, `wiki/`, and `INSTRUCTIONS.md`.

## Apply it here

The startup already runs on text: user posts, founder interviews, launch notes, product pages. A chat forgets which post matched which company. A wiki keeps that link, and the next recommendation starts from pages that already exist.

- `sources/` holds the untouched inputs. A scrape, a transcript, a PDF. The agent does not edit them.
- `wiki/` holds one page per product, founder, niche, and user signal. Pages link to each other.
- `INSTRUCTIONS.md` is what Cursor or Claude Code reads before an ingest. The rules live there, not in the prompt of the day.

The vault is seeded so it is not empty: `wiki/index.md`, a product-page template, a founder-page template, and one example signal filed from `sources/example-evening-skincare.md`. The example is a person who wants fewer steps at night, which is the kind of post the scraper should be able to turn into one product from a YC or a16z company.

## Done

- Drop a real source in `sources/` and say "ingest this".
- The agent writes or updates wiki pages, links them from `wiki/index.md`, and appends `wiki/log.md`.
- It does not edit the source, and it does not invent a company the source did not name.
- "Which products fit someone posting about X?" is answered from wiki pages, with the filename cited.

## Source

https://x.com/cyrilXBT/status/2069651792678510894
