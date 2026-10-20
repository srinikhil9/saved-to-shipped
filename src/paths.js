import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  root,
  fixtures: path.join(root, "fixtures"),
  profile: path.join(root, "data", "profile.json"),
  relateCache: path.join(root, "data", "relate-cache.json"),
  db: process.env.DB_PATH || path.join(root, "data", "saves.sqlite"),
  screenshots: path.join(root, "data", "screenshots"),
};
