import fs from "node:fs";
import { paths } from "./paths.js";

export function loadProfile(profilePath = paths.profile) {
  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
}
