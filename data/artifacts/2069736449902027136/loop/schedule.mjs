import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
fs.mkdirSync(stateDir, { recursive: true });

const tick = {
  woke_at: new Date().toISOString(),
  every: "6h",
  next: "discover",
  note: "A timer wakes the loop. This script is that wake.",
};
fs.writeFileSync(path.join(stateDir, "tick.json"), JSON.stringify(tick, null, 2) + "\n");
console.log("schedule: woke → discover (then build, verify, repeat)");
