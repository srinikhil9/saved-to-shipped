import { classify } from "../src/classify.js";
import { combinedText, ingest } from "../src/ingest.js";
import { loadProfile } from "../src/profile.js";
import { relate } from "../src/relate.js";

const SEEDS = [
  "https://x.com/hasantoxr/status/2025902150296236050",
  "https://x.com/0xCodez/status/2069736449902027136",
  "https://x.com/cyrilXBT/status/2069651792678510894",
];

const REQUIRED = [
  /drop-in for the scraping pipeline/i,
  /agent and scrape loops/i,
  /knowledge base of products, founders, and user signals/i,
];

const profile = loadProfile();
let failed = false;

for (let index = 0; index < SEEDS.length; index += 1) {
  const url = SEEDS[index];
  const post = await ingest(url, {
    offline: true,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const sorted = await classify({ text: combinedText(post), links: post.links || [] }, { env: {} });
  // env is empty on purpose: a shell XAI_API_KEY must not change this demo.
  const whyYou = await relate(
    {
      id: post.id,
      url: post.url,
      author: post.author,
      text: combinedText(post),
      kind: sorted.kind,
      summary: sorted.summary,
    },
    profile,
    { env: {} },
  );
  console.log(`${sorted.kind}\t${post.url}`);
  console.log(whyYou);
  console.log("");
  if (!REQUIRED[index].test(whyYou)) {
    console.error(`missing expected phrase for ${url}`);
    failed = true;
  }
}

if (failed) process.exit(1);
