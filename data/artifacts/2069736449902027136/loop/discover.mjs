import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
fs.mkdirSync(stateDir, { recursive: true });

const work = [
  { id: "scrape-failed", title: "Retry social scrapes that failed on the last tick", lane: "collect" },
  { id: "new-companies", title: "Read YC and a16z consumer companies added since the last tick", lane: "catalog" },
  { id: "stale-recs", title: "Users with new posts and a recommendation that was not rebuilt", lane: "recommend" },
];
const payload = { discovered_at: new Date().toISOString(), work };
fs.writeFileSync(path.join(stateDir, "work.json"), JSON.stringify(payload, null, 2) + "\n");
console.log("discover: " + work.length + " items → state/work.json");
