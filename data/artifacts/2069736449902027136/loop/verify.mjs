import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
fs.mkdirSync(stateDir, { recursive: true });

const draftPath = path.join(stateDir, "draft.json");
const draft = fs.existsSync(draftPath) ? JSON.parse(fs.readFileSync(draftPath, "utf8")) : null;
const checks = [
  { name: "names a product", pass: Boolean(draft && draft.product) },
  { name: "company is YC or a16z", pass: Boolean(draft && (draft.batch === "yc" || draft.batch === "a16z")) },
  { name: "quotes a user post", pass: Boolean(draft && draft.evidence) },
];
const failed = checks.filter((check) => !check.pass).map((check) => check.name);
const verdict = { assumed: "broken", pass: failed.length === 0, checks };
fs.writeFileSync(path.join(stateDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
console.log(verdict.pass ? "verify: pass" : "verify: no — " + failed.join(", "));
