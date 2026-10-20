import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { act } from "../src/act.js";
import { sampleSave } from "../src/act/sample.js";
import { paths } from "../src/paths.js";

const SEEDS = [
  {
    url: "https://x.com/0xCodez/status/2069736449902027136",
    zip: "loop-engineering.zip",
    need: ["SPEC.md", "loop/schedule.mjs", "loop/discover.mjs", "loop/build.mjs", "loop/verify.mjs", "loop/README.md"],
    spec: [/Schedule → Discover → Build → Verify → Repeat/, /Saved to Shipped is this loop/, /assumes the work is broken/],
  },
  {
    url: "https://x.com/cyrilXBT/status/2069651792678510894",
    zip: "second-brain.zip",
    need: ["SPEC.md", "INSTRUCTIONS.md", "sources/README.md", "wiki/index.md", "wiki/product.md", "wiki/founder.md"],
    spec: [/sources\//, /INSTRUCTIONS\.md/, /wiki\//],
  },
];

const force = process.argv.includes("--force");
const failures = [];

for (const seed of SEEDS) {
  const save = await sampleSave(seed.url);
  if (save.kind !== "paper" && save.kind !== "idea") {
    failures.push(`${seed.url} classified as ${save.kind}, expected paper or idea`);
    continue;
  }
  const result = await act(save, { env: {}, force });
  const label = `${save.kind} ${path.basename(path.dirname(result.zipPath))}`;
  console.log(`\n${label}  source=${result.source} cached=${result.cached}`);
  console.log(result.summary);
  console.log(result.zipPath);
  for (const file of result.files) console.log(`  ${file}`);

  if (result.source !== "template") failures.push(`${label}: expected the no-key template path`);
  if (!result.zipUrl.endsWith(`/${seed.zip}`)) failures.push(`${label}: zip url ${result.zipUrl}`);
  for (const file of seed.need) {
    if (!result.files.includes(file)) failures.push(`${label}: missing ${file}`);
  }
  const specPath = path.join(paths.root, result.specPath);
  const spec = fs.readFileSync(specPath, "utf8");
  for (const pattern of seed.spec) {
    if (!pattern.test(spec)) failures.push(`${label}: SPEC.md missing ${pattern}`);
  }
  const zip = new AdmZip(path.join(paths.root, result.zipPath));
  const names = zip.getEntries().map((entry) => entry.entryName);
  for (const file of seed.need) {
    if (!names.includes(file)) failures.push(`${label}: zip missing ${file}`);
  }
}

if (failures.length) {
  console.error("\nact:demo failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nact:demo ok (no API key, template path)");
