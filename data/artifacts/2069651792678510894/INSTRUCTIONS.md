# INSTRUCTIONS

You maintain a wiki for Srinikhil's startup. The startup scrapes users' social media data and recommends niche consumer products from YC and a16z companies.

Read this file before you ingest anything.

## Layout

- `sources/` is raw. Never edit a file there. Never delete one.
- `wiki/` is the living pages. You may create and update files there.
- `SPEC.md` is the product spec for this starter. Do not rewrite it while ingesting.
- This file is the operator. Do not loosen a rule to finish a single ingest.

## When the user says "ingest this"

The source is the file they named. If they did not name one, use the newest file in `sources/` that is not `README.md`.

1. Read the whole source. If you cannot, stop and say which file.
2. Pull out products, founders, niches, and user signals (a post, a habit, a complaint, a brand they already buy).
3. Write pages under `wiki/`:
   - A product goes to `wiki/product-<slug>.md` and follows the fields in `wiki/product.md`.
   - A founder goes to `wiki/founder-<slug>.md` and follows `wiki/founder.md`.
   - A niche or a user signal goes to `wiki/<slug>.md`: what it is, why it matters to a recommendation, and which source it came from.
4. Link with relative markdown links, like `[Evening skincare](signal-evening-skincare.md)`. Every new page links to `index.md`. A product page links to its founder and its niche when those pages exist.
5. On each page you touch, add the source filename under Sources.
6. Update `wiki/index.md`: one line per page, under Products, Founders, or Signals.
7. Append one line to `wiki/log.md`: the date, the source filename, and the pages you wrote.
8. Stop. Do not invent a company the source did not name. If a field is missing, write "unknown".

## When the user asks a question

Answer from `wiki/` pages and cite the filename. If the wiki does not have it, say so and name the source that would need ingesting. Do not answer from a source you have not filed.

## Page rules

- One topic per page. The first line is a `# Title`.
- Say how this connects to recommending one niche product from a social post.
- When you quote a post, use the words from the source.
