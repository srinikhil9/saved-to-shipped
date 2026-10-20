import fs from "node:fs";
import { createApp } from "./app.js";
import { failStuckSaves, openDb } from "./db.js";
import { paths } from "./paths.js";
import { restoreCachedScreenshots } from "./runner/cache.js";

fs.mkdirSync(paths.screenshots, { recursive: true });
restoreCachedScreenshots();

const db = openDb(process.env.DB_PATH || paths.db);
const settled = failStuckSaves(db);
if (settled.failed) {
  console.log(`Marked ${settled.failed} interrupted save${settled.failed === 1 ? "" : "s"} as failed.`);
}
if (settled.restored) {
  console.log(
    `Restored ${settled.restored} interrupted save${settled.restored === 1 ? "" : "s"} to the last finished result.`,
  );
}
const app = createApp(db, { offline: process.env.INGEST_OFFLINE === "1" });
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Saved to Shipped is running at http://localhost:${port}`);
});
