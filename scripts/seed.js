import { createSave, findSaveByUrl, getSave, openDb } from "../src/db.js";
import { listFixturePosts } from "../src/ingest.js";
import { paths } from "../src/paths.js";
import { loadProfile } from "../src/profile.js";
import { runPipeline } from "../src/pipeline.js";
import { backfillWhyYou } from "../src/why.js";

const offline = !process.argv.includes("--live");
const db = openDb(process.env.DB_PATH || paths.db);
const profile = loadProfile();
const posts = listFixturePosts();

if (!posts.length) {
  console.error("No fixtures found in fixtures/");
  process.exit(1);
}

for (const post of posts) {
  const existing = findSaveByUrl(db, post.url);
  if (existing) {
    console.log(`already saved #${existing.id} ${existing.kind || existing.status} ${post.url}`);
    continue;
  }
  const row = createSave(db, post.url);
  await runPipeline(db, row.id, { offline, profile });
  const done = getSave(db, row.id);
  console.log(`#${done.id} ${done.status} ${done.kind || "-"} ${done.author || ""} ${post.url}`);
  if (done.error) console.log(`  error: ${done.error}`);
}

const filled = backfillWhyYou(db, profile);
if (filled) console.log(`filled why_you on ${filled} existing save${filled === 1 ? "" : "s"}`);

db.close();
