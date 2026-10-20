import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { act } from "../src/act.js";
import { XAI_CHAT_COMPLETIONS } from "../src/act/llm.js";
import { sampleSave } from "../src/act/sample.js";
import { renderFileList, renderZipLink } from "../src/act/snippet.js";

const execFileAsync = promisify(execFile);
const LOOP = "https://x.com/0xCodez/status/2069736449902027136";
const BRAIN = "https://x.com/cyrilXBT/status/2069651792678510894";

test("template specs for both seeds zip the starter and replay from cache", async () => {
  const loop = await act(await sampleSave(LOOP), { env: {} });
  const brain = await act(await sampleSave(BRAIN), { env: {} });

  assert.equal(loop.cached, true);
  assert.equal(loop.source, "template");
  assert.equal(loop.type, "spec");
  assert.equal(loop.zipUrl, "/artifacts/2069736449902027136/loop-engineering.zip");
  assert.equal(brain.cached, true);
  assert.equal(brain.type, "starter");
  assert.equal(brain.zipUrl, "/artifacts/2069651792678510894/second-brain.zip");

  const loopSpec = fs.readFileSync(loop.specPath, "utf8");
  assert.match(loopSpec, /Schedule → Discover → Build → Verify → Repeat/);
  assert.match(loopSpec, /isolated worktree/);
  assert.match(loopSpec, /assumes the work is broken/);
  assert.match(loopSpec, /Saved to Shipped is this loop/);
  assert.match(loopSpec, /drive\.google\.com/);
  assert.match(loopSpec, /Srinikhil is building a startup/);

  const brainSpec = fs.readFileSync(brain.specPath, "utf8");
  assert.match(brainSpec, /sources\//);
  assert.match(brainSpec, /wiki\//);
  assert.match(brainSpec, /INSTRUCTIONS\.md/);
  const instructions = fs.readFileSync(path.join(path.dirname(brain.specPath), "INSTRUCTIONS.md"), "utf8");
  assert.match(instructions, /ingest this/);
  assert.match(instructions, /Never edit a file there/);
  assert.match(fs.readFileSync(path.join(path.dirname(brain.specPath), "wiki/index.md"), "utf8"), /Product page/);
  assert.match(fs.readFileSync(path.join(path.dirname(brain.specPath), "wiki/product.md"), "utf8"), /YC or a16z/);
  assert.match(fs.readFileSync(path.join(path.dirname(brain.specPath), "wiki/founder.md"), "utf8"), /Founder/);

  for (const file of ["loop/schedule.mjs", "loop/discover.mjs", "loop/build.mjs", "loop/verify.mjs"]) {
    assert.equal(loop.files.includes(file), true, file);
    assert.equal(new AdmZip(loop.zipPath).getEntry(file) != null, true, file);
  }
});

test("the loop starter runs and the verifier says no", async () => {
  const result = await act(await sampleSave(LOOP), { env: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-starter-"));
  new AdmZip(result.zipPath).extractAllTo(dir, true);
  const loopDir = path.join(dir, "loop");
  for (const script of ["schedule.mjs", "discover.mjs", "build.mjs", "verify.mjs"]) {
    await execFileAsync(process.execPath, [script], { cwd: loopDir });
  }
  const verdict = JSON.parse(fs.readFileSync(path.join(loopDir, "state/verdict.json"), "utf8"));
  assert.equal(verdict.assumed, "broken");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.some((check) => check.name === "quotes a user post" && check.pass === false), true);
});

test("a rerun reuses the directory unless forced, and a profile change rebuilds", async () => {
  const save = await sampleSave(BRAIN);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-cache-"));
  const first = await act(save, { env: {}, outDir: dir });
  assert.equal(first.cached, false);
  const stamp = fs.statSync(path.join(dir, "second-brain.zip")).mtimeMs;
  const second = await act(save, { env: {}, outDir: dir });
  assert.equal(second.cached, true);
  assert.equal(fs.statSync(path.join(dir, "second-brain.zip")).mtimeMs, stamp);

  const forced = await act(save, { env: {}, outDir: dir, force: true });
  assert.equal(forced.cached, false);

  const other = await act(save, {
    env: {},
    outDir: dir,
    profile: { name: "Srinikhil", summary: "Srinikhil is building a completely different catalog of desk tools." },
  });
  assert.equal(other.cached, false);
  assert.match(fs.readFileSync(path.join(dir, "SPEC.md"), "utf8"), /desk tools/);
});

test("other papers and ideas still get a spec and a starter", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-generic-"));
  const paper = await act(
    {
      url: "https://x.com/someone/status/999",
      kind: "paper",
      text: "A 12-page PDF on evaluation harnesses for ranking.",
      summary: "Evaluation harnesses for ranking.",
      details: { paper_url: "https://arxiv.org/pdf/2607.00038" },
    },
    { env: {}, outDir: path.join(dir, "paper") },
  );
  assert.equal(paper.type, "spec");
  assert.equal(paper.files.includes("starter/README.md"), true);
  assert.match(fs.readFileSync(path.join(dir, "paper/SPEC.md"), "utf8"), /arxiv\.org/);

  const idea = await act(
    {
      url: "https://example.com/notes",
      kind: "idea",
      text: "A workflow for keeping a folder of notes and rereading them.",
      summary: "Keep a folder of notes.",
      details: {},
    },
    { env: {}, outDir: path.join(dir, "idea") },
  );
  assert.equal(idea.type, "starter");
  assert.match(idea.zipUrl, /^\/artifacts\/[a-f0-9]{16}\/idea-starter\.zip$/);
  assert.equal(idea.files.includes("starter/README.md"), true);
});

test("XAI_API_KEY calls Grok and any failure keeps the template", async () => {
  const save = await sampleSave(LOOP);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-grok-"));
  let calls = 0;
  const grokSpec = `# SPEC from Grok\n\nSrinikhil runs Schedule, Discover, Build, Verify on every scrape.\n\n${"Apply the loop to one failed scrape and write the verdict to disk. ".repeat(8)}`;
  const drafted = await act(save, {
    env: { XAI_API_KEY: "test-key" },
    outDir: path.join(dir, "ok"),
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, XAI_CHAT_COMPLETIONS);
      assert.equal(init.headers.authorization, "Bearer test-key");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "grok-4.7");
      assert.equal(init.signal instanceof AbortSignal, true);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ spec: grokSpec, summary: "Grok drafted the loop spec for Srinikhil." }) } }],
        }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(drafted.source, "grok");
  assert.match(fs.readFileSync(path.join(dir, "ok/SPEC.md"), "utf8"), /SPEC from Grok/);
  assert.equal(drafted.files.includes("loop/verify.mjs"), true);

  const ignored = await act(save, {
    env: { LLM_API_KEY: "not-this-key" },
    outDir: path.join(dir, "ignored"),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not be called");
    },
  });
  assert.equal(ignored.source, "template");
  assert.match(fs.readFileSync(path.join(dir, "ignored/SPEC.md"), "utf8"), /Saved to Shipped is this loop/);

  const fallback = await act(save, {
    env: { XAI_API_KEY: "test-key", XAI_BASE_URL: "https://api.x.ai/v1/", XAI_MODEL: "grok-test" },
    outDir: path.join(dir, "fallback"),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.x.ai/v1/chat/completions");
      assert.equal(JSON.parse(init.body).model, "grok-test");
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  assert.equal(fallback.source, "template");
  assert.match(fs.readFileSync(path.join(dir, "fallback/SPEC.md"), "utf8"), /Schedule → Discover → Build → Verify → Repeat/);
});

test("offline repo replays its cache and the zip link only accepts artifact paths", async () => {
  const replay = await act(
    {
      kind: "repo",
      url: "https://x.com/hasantoxr/status/2025902150296236050",
      details: { repo_url: "https://github.com/D4Vinci/Scrapling" },
    },
    { env: {}, offline: true },
  );
  assert.equal(replay.status, "cached");
  const skipped = await act({ kind: "tool", url: "https://example.com", details: {} }, { env: {} });
  assert.equal(skipped.status, "skipped");
  assert.equal(renderZipLink({ zipUrl: "javascript:alert(1)" }), "");
  assert.equal(renderZipLink({ zipUrl: "https://evil.example/loop.zip" }), "");
  const link = renderZipLink({ zipUrl: "/artifacts/2069736449902027136/loop-engineering.zip", type: "spec" });
  assert.match(link, /href="\/artifacts\/2069736449902027136\/loop-engineering\.zip"/);
  assert.match(link, /href="\/artifacts\/2069736449902027136\/SPEC\.md"/);
  assert.equal(renderFileList(["../secret", "loop/verify.mjs"]), `<ul class="files"><li><code>loop/verify.mjs</code></li></ul>`);
});
