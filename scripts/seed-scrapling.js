import fs from "node:fs";
import path from "node:path";
import { paths } from "../src/paths.js";
import { runRepo } from "../src/runner/runRepo.js";

const repoUrl = "https://github.com/D4Vinci/Scrapling";
const outDir = path.join(paths.fixtures, "repo-runs", "scrapling");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(paths.screenshots, { recursive: true });

console.log(`Recording a real run of ${repoUrl}`);
const result = await runRepo({
  saveId: "scrapling-seed",
  repoUrl,
  screenshotDir: paths.screenshots,
  onLog: (line) => console.log(line),
});

if (result.error) {
  console.error("Seed run failed:", result.error);
  console.error(result.stdout);
  console.error(result.action_result_json?.stderr);
  process.exit(1);
}

const sample = result.action_result_json?.extracted_sample || [];
if (!sample.length) {
  console.error("Seed run produced no extracted sample");
  console.error(result.stdout);
  process.exit(1);
}

const shotName = "scrapling-seed.png";
const shotSrc = path.join(paths.screenshots, path.basename(result.screenshot_path));
fs.copyFileSync(shotSrc, path.join(outDir, "screenshot.png"));
fs.copyFileSync(shotSrc, path.join(paths.screenshots, shotName));

const action = {
  ...result.action_result_json,
  stdout: result.stdout,
  screenshot_file: shotName,
  screenshot_path: `/screenshots/${shotName}`,
};
fs.writeFileSync(path.join(outDir, "stdout.txt"), result.stdout);
fs.writeFileSync(path.join(outDir, "action_result.json"), `${JSON.stringify(action, null, 2)}\n`);
console.log(`Wrote ${outDir} (${sample.length} extracted items)`);
