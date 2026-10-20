import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
fs.mkdirSync(stateDir, { recursive: true });

const workPath = path.join(stateDir, "work.json");
const work = fs.existsSync(workPath) ? JSON.parse(fs.readFileSync(workPath, "utf8")).work || [] : [];
const task = work[0] || { id: "unscheduled", title: "No discovered work. Run discover.mjs first.", lane: "recommend" };

const draft = {
  task_id: task.id,
  product: "a single nighttime product, not a ten-step shelf",
  company: null,
  batch: "yc",
  evidence: null,
  note: "evidence stays empty on purpose so verify.mjs can say no.",
};
fs.writeFileSync(path.join(stateDir, "draft.json"), JSON.stringify(draft, null, 2) + "\n");
console.log("build: wrote state/draft.json for " + task.id);
