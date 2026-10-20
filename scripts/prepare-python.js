import { preparePythonRuntime } from "../src/runner/python.js";

const result = await preparePythonRuntime();
if (result.skipped) {
  console.log(result.error);
  process.exit(0);
}
if (!result.ok) {
  console.error(result.error || "Could not prepare Python 3.12");
  process.exit(1);
}
console.log(`uv: ${result.uv}`);
console.log(`python: ${result.python} (cached under .tools/)`);
if (result.wheels) console.log("scrapling wheels warmed in the uv cache");
else if (result.warning) console.log(`python is cached; wheel warm skipped: ${result.warning}`);
