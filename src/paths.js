import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  root,
  fixtures: path.join(root, "fixtures"),
  profile: path.join(root, "data", "profile.json"),
  db: process.env.DB_PATH || path.join(root, "data", "saves.sqlite"),
  screenshots: path.join(root, "data", "screenshots"),
  liveCache: path.join(root, "data", "live-cache"),
  pipCache: path.join(root, "data", "pip-cache"),
  tools: path.join(root, ".tools"),
  artifacts: path.join(root, "data", "artifacts"),
};
