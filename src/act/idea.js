import { dedent, writeStarter } from "./starter.js";

/**
 * Idea action: a one-page SPEC.md plus a starter folder, zipped.
 * Karpathy's second brain gets sources/, wiki/, and INSTRUCTIONS.md.
 * Any other idea gets a one-folder starter with the first experiment.
 */
export async function act(save, options = {}) {
  const plan = isSecondBrain(save) ? brainPlan() : genericPlan();
  return writeStarter(save, options, plan);
}

function isSecondBrain(save) {
  const blob = `${save?.url || ""}\n${save?.text || ""}\n${save?.summary || ""}`;
  return /2069651792678510894/.test(blob) || /second brain/i.test(blob) || /karpathy/i.test(blob);
}

function brainPlan() {
  return {
    type: "starter",
    zipName: "second-brain.zip",
    summary() {
      return "A starter wiki (sources/, wiki/, INSTRUCTIONS.md) for filing YC and a16z products against what users post, plus a one-page spec.";
    },
    spec(save, profile) {
      return dedent(`
        # SPEC: A second brain for niche product recommendations

        ## Context

        ${profile.summary}

        The saved idea, from Andrej Karpathy via this post: stop using the model only to write code. Point it at a folder. Drop in a source. It reads it, links it, and files a wiki that compounds. The post sets up three things: a raw folder, a wiki, and a file that tells the agent how to run. This starter uses those roles as \`sources/\`, \`wiki/\`, and \`INSTRUCTIONS.md\`.

        ## Apply it here

        The startup already runs on text: user posts, founder interviews, launch notes, product pages. A chat forgets which post matched which company. A wiki keeps that link, and the next recommendation starts from pages that already exist.

        - \`sources/\` holds the untouched inputs. A scrape, a transcript, a PDF. The agent does not edit them.
        - \`wiki/\` holds one page per product, founder, niche, and user signal. Pages link to each other.
        - \`INSTRUCTIONS.md\` is what Cursor or Claude Code reads before an ingest. The rules live there, not in the prompt of the day.

        The vault is seeded so it is not empty: \`wiki/index.md\`, a product-page template, a founder-page template, and one example signal filed from \`sources/example-evening-skincare.md\`. The example is a person who wants fewer steps at night, which is the kind of post the scraper should be able to turn into one product from a YC or a16z company.

        ## Done

        - Drop a real source in \`sources/\` and say "ingest this".
        - The agent writes or updates wiki pages, links them from \`wiki/index.md\`, and appends \`wiki/log.md\`.
        - It does not edit the source, and it does not invent a company the source did not name.
        - "Which products fit someone posting about X?" is answered from wiki pages, with the filename cited.

        ## Source

        ${save.url || "saved post"}
      `);
    },
    files() {
      return [
        { path: "INSTRUCTIONS.md", contents: INSTRUCTIONS },
        { path: "sources/README.md", contents: SOURCES_README },
        { path: "sources/example-evening-skincare.md", contents: EXAMPLE_SOURCE },
        { path: "wiki/index.md", contents: WIKI_INDEX },
        { path: "wiki/product.md", contents: PRODUCT_TEMPLATE },
        { path: "wiki/founder.md", contents: FOUNDER_TEMPLATE },
        { path: "wiki/signal-evening-skincare.md", contents: SIGNAL_PAGE },
        { path: "wiki/log.md", contents: LOG },
      ];
    },
  };
}

function genericPlan() {
  return {
    type: "starter",
    zipName: "idea-starter.zip",
    summary(save) {
      const title = save.summary ? clip(save.summary, 140) : "this idea";
      return `A one-page spec for trying ${title} on the scrape → recommend pipeline, plus a starter folder for the first run.`;
    },
    spec(save, profile) {
      const quote = excerpt(save.text, 420);
      return dedent(`
        # SPEC: Try this idea on scrape → recommend

        ## Context

        ${profile.summary}

        ## What was saved

        ${quote || "The post did not include a body."}

        Source: ${save.url || "saved post"}

        ## First experiment

        Pick the smallest piece of the idea that can run on one user's posts and one YC or a16z product. Write the input (the posts, the product) and the output (the recommendation, and why) into \`starter/\`. If the idea needs a second step, that step reads those files. It does not re-read the chat.

        A useful result can fail. If the idea does not change which product gets recommended, record that and stop. Do not widen the experiment to make it look productive.

        ## Done

        - \`starter/README.md\` names the input, the output, and how to tell that it failed.
        - One example is filled in from the saved post, not from a hypothetical user.
        - The next run starts from the files.
      `);
    },
    files(save) {
      return [
        {
          path: "starter/README.md",
          contents: dedent(`
            # Starter

            The spec is \`../SPEC.md\`. Source: ${save.url || "saved post"}.

            1. Copy one real post and one real YC or a16z product into this folder.
            2. Write the recommendation the idea would produce, and the sentence that explains it.
            3. Note what would make this a failure. Keep that note next to the output.
          `),
        },
      ];
    },
  };
}

const INSTRUCTIONS = dedent(`
  # INSTRUCTIONS

  You maintain a wiki for Srinikhil's startup. The startup scrapes users' social media data and recommends niche consumer products from YC and a16z companies.

  Read this file before you ingest anything.

  ## Layout

  - \`sources/\` is raw. Never edit a file there. Never delete one.
  - \`wiki/\` is the living pages. You may create and update files there.
  - \`SPEC.md\` is the product spec for this starter. Do not rewrite it while ingesting.
  - This file is the operator. Do not loosen a rule to finish a single ingest.

  ## When the user says "ingest this"

  The source is the file they named. If they did not name one, use the newest file in \`sources/\` that is not \`README.md\`.

  1. Read the whole source. If you cannot, stop and say which file.
  2. Pull out products, founders, niches, and user signals (a post, a habit, a complaint, a brand they already buy).
  3. Write pages under \`wiki/\`:
     - A product goes to \`wiki/product-<slug>.md\` and follows the fields in \`wiki/product.md\`.
     - A founder goes to \`wiki/founder-<slug>.md\` and follows \`wiki/founder.md\`.
     - A niche or a user signal goes to \`wiki/<slug>.md\`: what it is, why it matters to a recommendation, and which source it came from.
  4. Link with relative markdown links, like \`[Evening skincare](signal-evening-skincare.md)\`. Every new page links to \`index.md\`. A product page links to its founder and its niche when those pages exist.
  5. On each page you touch, add the source filename under Sources.
  6. Update \`wiki/index.md\`: one line per page, under Products, Founders, or Signals.
  7. Append one line to \`wiki/log.md\`: the date, the source filename, and the pages you wrote.
  8. Stop. Do not invent a company the source did not name. If a field is missing, write "unknown".

  ## When the user asks a question

  Answer from \`wiki/\` pages and cite the filename. If the wiki does not have it, say so and name the source that would need ingesting. Do not answer from a source you have not filed.

  ## Page rules

  - One topic per page. The first line is a \`# Title\`.
  - Say how this connects to recommending one niche product from a social post.
  - When you quote a post, use the words from the source.
`);

const SOURCES_README = dedent(`
  # Sources

  Drop articles, transcripts, PDFs, and scrapes here. Leave them untouched.

  \`example-evening-skincare.md\` is a sample user post so the wiki is not empty. For the next real source, put the file in this folder and tell the agent "ingest this". The rules are in \`../INSTRUCTIONS.md\`.
`);

const EXAMPLE_SOURCE = dedent(`
  # Example source

  A user post, saved as a source. This is a sample, not a live scrape.

  "I keep buying the same three serums and still feel like none of them were made for the way I actually get ready at night. I want fewer steps, not another 10-step shelf."

  - Platform: example
  - Niche hint: nighttime skincare, a smaller routine
  - Company named in the post: none
`);

const WIKI_INDEX = dedent(`
  # Index

  Wiki for matching social posts to niche products from YC and a16z companies. How to add a page: \`../INSTRUCTIONS.md\`.

  ## Templates

  - [Product page](product.md)
  - [Founder page](founder.md)

  ## Products

  None filed yet. Ingest a source that names a company before adding one.

  ## Founders

  None filed yet.

  ## Signals

  - [Evening skincare, fewer steps](signal-evening-skincare.md) — example, filed from \`sources/example-evening-skincare.md\`
`);

const PRODUCT_TEMPLATE = dedent(`
  # Product: {name}

  One niche consumer product from a YC or a16z company. Copy this file to \`product-<slug>.md\` when a source names one. Do not fill it from memory.

  - Company:
  - Batch / investor: YC or a16z
  - Niche:
  - URL:

  ## Why a social post would match

  What the user would have said, in their words, before this product is the right recommendation.

  ## Evidence

  Quote the source. If the source has no quote, write "unknown".

  ## Links

  - Founder:
  - Signal:
  - [Index](index.md)

  ## Sources

  -
`);

const FOUNDER_TEMPLATE = dedent(`
  # Founder: {name}

  Copy this file to \`founder-<slug>.md\` when a source names a person. The startup recommends products, not people. This page exists so a product page has one place to point, and so a later interview updates one file.

  - Company:
  - Building, in one sentence:
  - YC / a16z:

  ## Links

  - Product:
  - [Index](index.md)

  ## Sources

  -
`);

const SIGNAL_PAGE = dedent(`
  # Signal: evening skincare, fewer steps

  Someone posting this is tired of a crowded shelf. The recommendation should be one nighttime product from a YC or a16z company, not a routine of ten. No company is named yet, so this page stays a signal.

  ## Evidence

  > I want fewer steps, not another 10-step shelf.

  ## What to recommend toward

  A single-product nighttime ritual. When a source names a company that fits, file it with the product template and link it from here. Until then, do not invent one.

  ## Links

  - [Index](index.md)
  - [Product template](product.md)

  ## Sources

  - \`sources/example-evening-skincare.md\`
`);

const LOG = dedent(`
  # Log

  - example — filed \`sources/example-evening-skincare.md\` → \`wiki/signal-evening-skincare.md\`
`);

function excerpt(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
