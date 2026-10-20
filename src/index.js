import fs from "node:fs";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { paths } from "./paths.js";
import { restoreCachedScreenshots } from "./runner/cache.js";

fs.mkdirSync(paths.screenshots, { recursive: true });
restoreCachedScreenshots();

const db = openDb(process.env.DB_PATH || paths.db);
const app = createApp(db, { offline: process.env.INGEST_OFFLINE === "1" });
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Saved to Shipped is running at http://localhost:${port}`);
});
