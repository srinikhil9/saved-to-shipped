import path from "node:path";
import { paths } from "../src/paths.js";
import { runRepo } from "../src/runner/runRepo.js";

const repoUrl = process.argv[2] || "https://github.com/D4Vinci/Scrapling";
console.log(`Running ${repoUrl}`);
const result = await runRepo({
  saveId: "cli",
  repoUrl,
  screenshotDir: paths.screenshots,
  onLog: (line) => console.log(line),
});
console.log(
  JSON.stringify(
    {
      error: result.error,
      screenshot_path: result.screenshot_path,
      stdout: result.stdout,
      action_result_json: result.action_result_json,
    },
    null,
    2,
  ),
);
process.exit(result.error ? 1 : 0);
