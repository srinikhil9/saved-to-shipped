import { dedent, writeStarter } from "./starter.js";

/**
 * Paper action: a one-page SPEC.md plus a starter folder, zipped.
 * Loop Engineering gets a loop/ skeleton. Any other paper gets a short starter/ checklist.
 */
export async function act(save, options = {}) {
  const plan = isLoop(save) ? loopPlan() : genericPlan();
  return writeStarter(save, options, plan);
}

function isLoop(save) {
  const blob = `${save?.url || ""}\n${save?.text || ""}\n${save?.summary || ""}`;
  return /2069736449902027136/.test(blob) || /loop engineering/i.test(blob);
}

function loopPlan() {
  return {
    type: "spec",
    zipName: "loop-engineering.zip",
    summary() {
      return "A one-page spec for running scrape → recommend as Schedule, Discover, Build, Verify, plus a loop/ skeleton that writes each step to disk.";
    },
    spec(save, profile) {
      const paper = save.details?.paper_url ? `Paper: ${save.details.paper_url}` : "";
      return dedent(`
        # SPEC: Loop Engineering for the scrape → recommend pipeline

        ## Context

        ${profile.summary}

        The saved post is Loop Engineering: stop prompting the agent, and build the system that prompts it. One turn is five moves. Schedule → Discover → Build → Verify → Repeat. An agent grading its own work always praises it, so the verifier is a second pass that assumes the work is broken.

        ## Apply it here

        Posts come in and product recommendations go out. That is already a loop. It should run without someone pasting the next task into a chat.

        - **Discover.** The loop finds its own work: failed scrapes, users with new posts, and YC / a16z companies added since the last tick. It is not handed a list.
        - **Handoff.** Each task gets an isolated worktree (its own job directory) so a scrape for one user cannot collide with a catalog write for another company.
        - **Build.** One task only. Draft the recommendation, then stop. The draft is a file, not a paragraph left in the context window.
        - **Verify.** A second agent is told the draft is broken. The product has to still exist, the company has to be a real YC or a16z company, and the niche has to be backed by a quote from the user's posts. If any check fails, the verdict is no.
        - **Schedule.** A timer wakes the next turn. That wake is what makes it a loop. Persistence is the same rule as the handoff: results go to disk (\`loop/state/\`, and the product database), never only into a window that will be flushed.

        ## Saved to Shipped is this loop

        Saved to Shipped is the same five moves, one level up. A pasted post is discovered work. Sort and act are the build. The reviewer that assumes the change is wrong is the verifier. \`data/artifacts/\` is the persistence. The next paste, or a rerun, is the schedule. Shipping the scrape pipeline means pointing that loop at users and startups instead of at bookmarks.

        ## Done

        - \`loop/schedule.mjs\` writes a tick and names the next move.
        - \`loop/discover.mjs\` writes \`loop/state/work.json\` with scrape, catalog, and recommendation tasks.
        - \`loop/build.mjs\` writes one draft to \`loop/state/draft.json\`.
        - \`loop/verify.mjs\` assumes that draft is broken and writes \`loop/state/verdict.json\`.
        - A recommendation the loop stands behind can be rebuilt from those files alone.

        ## Source

        ${save.url || "saved post"}
        ${paper}
      `);
    },
    files() {
      return [
        { path: "loop/README.md", contents: LOOP_README },
        { path: "loop/schedule.mjs", contents: SCHEDULE },
        { path: "loop/discover.mjs", contents: DISCOVER },
        { path: "loop/build.mjs", contents: BUILD },
        { path: "loop/verify.mjs", contents: VERIFY },
        { path: "loop/state/.gitkeep", contents: "" },
      ];
    },
  };
}

function genericPlan() {
  return {
    type: "spec",
    zipName: "paper-starter.zip",
    summary(save) {
      const title = save.summary ? clip(save.summary, 140) : "this paper";
      return `A one-page spec for applying ${title} to the scrape → recommend pipeline, plus a starter checklist.`;
    },
    spec(save, profile) {
      const paper = save.details?.paper_url ? `Paper: ${save.details.paper_url}` : "";
      const quote = excerpt(save.text, 420);
      return dedent(`
        # SPEC: Apply this paper to scrape → recommend

        ## Context

        ${profile.summary}

        ## What was saved

        ${quote || "The post did not include a body. Use the paper URL below."}

        ${paper}
        Source: ${save.url || "saved post"}

        ## Apply it here

        Read the paper for claims that change what the product is willing to trust. Map each claim onto one of three jobs:

        1. **Collect.** How a user's posts are scraped and stored, and what is thrown away.
        2. **Match.** How a niche consumer product from a YC or a16z company gets tied to those posts.
        3. **Explain.** The sentence the user sees, which has to point at a real post and a real company.

        The first experiment is the claim that can fail in one run. Write the input, the check, and the result to disk. An agent that grades its own summary of a paper will praise it. The check has to be able to say no.

        ## Done

        - \`starter/README.md\` lists the claims and the first check.
        - The check reads files, not the chat where the paper was summarized.
        - A failed check is a result. Record it and run the next one.
      `);
    },
    files(save) {
      return [
        {
          path: "starter/README.md",
          contents: dedent(`
            # Starter

            The spec is \`../SPEC.md\`. Source: ${save.url || "saved post"}.

            1. List the claims that would change how a scrape is trusted.
            2. Map each claim onto collect, match, or explain.
            3. Write the smallest check that can fail. Save its input and output next to this file.
            4. Re-run from those files. Do not re-run from the chat.
          `),
        },
      ];
    },
  };
}

const LOOP_README = dedent(`
  # Loop

  Stubs for Schedule → Discover → Build → Verify on the scrape → recommend pipeline. The spec is \`../SPEC.md\`.

  From this folder:

      node schedule.mjs
      node discover.mjs
      node build.mjs
      node verify.mjs

  \`verify.mjs\` assumes the draft is broken. The draft from \`build.mjs\` names a product and a batch, and it leaves the user's post empty, so the verdict is no. That no is the point of the second agent.

  Each script writes \`state/\`. Those files are the memory.
`);

const SCHEDULE = dedent(`
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
  fs.writeFileSync(path.join(stateDir, "tick.json"), JSON.stringify(tick, null, 2) + "\\n");
  console.log("schedule: woke → discover (then build, verify, repeat)");
`);

const DISCOVER = dedent(`
  import fs from "node:fs";
  import path from "node:path";
  import { fileURLToPath } from "node:url";

  const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
  fs.mkdirSync(stateDir, { recursive: true });

  const work = [
    { id: "scrape-failed", title: "Retry social scrapes that failed on the last tick", lane: "collect" },
    { id: "new-companies", title: "Read YC and a16z consumer companies added since the last tick", lane: "catalog" },
    { id: "stale-recs", title: "Users with new posts and a recommendation that was not rebuilt", lane: "recommend" },
  ];
  const payload = { discovered_at: new Date().toISOString(), work };
  fs.writeFileSync(path.join(stateDir, "work.json"), JSON.stringify(payload, null, 2) + "\\n");
  console.log("discover: " + work.length + " items → state/work.json");
`);

const BUILD = dedent(`
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
  fs.writeFileSync(path.join(stateDir, "draft.json"), JSON.stringify(draft, null, 2) + "\\n");
  console.log("build: wrote state/draft.json for " + task.id);
`);

const VERIFY = dedent(`
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
  fs.writeFileSync(path.join(stateDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\\n");
  console.log(verdict.pass ? "verify: pass" : "verify: no — " + failed.join(", "));
`);

function excerpt(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
