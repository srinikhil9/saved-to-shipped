import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { getSave, updateSave } from "../db.js";
import { llmSettings } from "../env.js";
import { draftSpec } from "./llm.js";
import { paths } from "../paths.js";
import { loadProfile } from "../profile.js";
import { parseXStatusUrl } from "../xurl.js";

const GENERATOR = "step4-v1";
const ZIP_EPOCH = new Date(Date.UTC(2026, 0, 1));

const DEFAULT_PROFILE = {
  name: "Srinikhil",
  summary:
    "Srinikhil is building a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups.",
  building: "a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups",
};

/**
 * Write SPEC.md plus a starter tree, zip it, and reuse the directory on the next call.
 * The directory name is the X status id (or a url hash) so a committed cache replays
 * for whatever sqlite row id the save gets later.
 */
export async function writeStarter(save, options, plan) {
  const profile = options.profile || loadProfileSafe();
  const key = artifactKey(save);
  const stamp = profileStamp(profile);
  const { read, write } = cacheDirs(key, options);

  if (!options.force) {
    for (const dir of read) {
      const cached = readCache(dir, stamp);
      if (cached) return toResult(dir, key, cached, true);
    }
  }

  const templateSpec = ensureTrailingNewline(plan.spec(save, profile));
  const templateSummary = clipSummary(plan.summary(save, profile));
  const files = [{ path: "SPEC.md", contents: templateSpec }, ...plan.files(save, profile).map(normalizeFile)];
  assertFiles(files);
  const generation = crypto.randomBytes(8).toString("hex");
  const manifest = writeTree(write, {
    generator: GENERATOR,
    profileHash: stamp,
    generation,
    type: plan.type,
    status: "done",
    source: "template",
    summary: templateSummary,
    zipName: plan.zipName,
    files: files.map((file) => file.path),
  }, files);
  const result = toResult(write, key, manifest, false);

  const settings = options.llm || llmSettings(options.env);
  if (!settings.apiKey) return result;

  let pending = null;
  const upgrade = () => {
    if (!pending) {
      pending = refineSpec({
        save,
        options,
        plan,
        profile,
        settings,
        files,
        dir: write,
        key,
        stamp,
        generation,
        templateSummary,
      }).catch(() => null);
    }
    return pending;
  };

  if (options.awaitSpec) {
    const upgraded = await upgrade();
    return upgraded || result;
  }
  // The template row is already on disk. Start Grok now and let the pipeline
  // store the template before this promise resolves.
  result.upgrade = upgrade;
  upgrade();
  return result;
}

async function refineSpec({ save, options, plan, profile, settings, files, dir, key, stamp, generation, templateSummary }) {
  const drafted = await draftSpec({
    llm: settings,
    fetchImpl: options.fetchImpl || options.llmFetch || globalThis.fetch,
    profileName: profile.name,
    save,
    fallbackSummary: templateSummary,
    timeoutMs: options.specTimeoutMs,
  });
  const current = readCache(dir, stamp);
  if (!current || current.generation !== generation) return null;
  const spec = ensureTrailingNewline(drafted.spec);
  const nextFiles = files.map((file) => (file.path === "SPEC.md" ? { path: "SPEC.md", contents: spec } : file));
  const manifest = writeTree(dir, {
    ...current,
    source: "grok",
    summary: drafted.summary || templateSummary,
  }, nextFiles);
  const upgraded = toResult(dir, key, manifest, false);
  await publishUpgrade(options.db, save.id, generation, upgraded);
  return upgraded;
}

async function publishUpgrade(db, id, generation, upgraded) {
  if (!db || id == null) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = getSave(db, id);
    if (!row?.action_result_json) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(row.action_result_json);
    } catch {
      return;
    }
    if (parsed?.act?.generation !== generation) return;
    parsed.act = upgraded;
    updateSave(db, id, { action_result_json: JSON.stringify(parsed), status: "done" });
    return;
  }
}

function cacheDirs(key, options) {
  if (options.outDir) {
    const dir = path.resolve(options.outDir);
    return { read: [dir], write: dir };
  }
  const runtime = path.join(paths.artifactsRuntime, key);
  const committed = path.join(paths.artifacts, key);
  return { read: [runtime, committed], write: runtime };
}

function writeTree(dir, manifest, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const dest = safeJoin(dir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.contents);
  }
  writeZip(path.join(dir, manifest.zipName), files);
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function artifactKey(save) {
  const parsed = parseXStatusUrl(save?.url || "");
  if (parsed) return parsed.id;
  const basis = save?.url || String(save?.id || "save");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function readCache(dir, stamp) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (cached.generator !== GENERATOR || cached.profileHash !== stamp || !cached.zipName) return null;
    const zipPath = path.join(dir, cached.zipName);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 64) return null;
    if (!fs.existsSync(path.join(dir, "SPEC.md"))) return null;
    return cached;
  } catch {
    return null;
  }
}

function toResult(dir, key, manifest, cached) {
  return {
    status: "done",
    type: manifest.type,
    source: manifest.source,
    cached,
    generation: manifest.generation,
    summary: manifest.summary,
    specPath: displayPath(path.join(dir, "SPEC.md")),
    zipPath: displayPath(path.join(dir, manifest.zipName)),
    zipUrl: `/artifacts/${key}/${manifest.zipName}`,
    files: manifest.files,
  };
}

function writeZip(zipPath, files) {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.path, Buffer.from(file.contents, "utf8"));
    const entry = zip.getEntry(file.path);
    if (entry) entry.header.time = ZIP_EPOCH;
  }
  zip.writeZip(zipPath);
}

function normalizeFile(file) {
  return { path: file.path, contents: ensureTrailingNewline(file.contents) };
}

function assertFiles(files) {
  const seen = new Set();
  for (const file of files) {
    if (!file.path || file.path.includes("\\") || file.path.split("/").includes("..")) {
      throw new Error(`Refusing starter path ${file.path}`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate starter path ${file.path}`);
    seen.add(file.path);
  }
}

function safeJoin(dir, relPath) {
  const dest = path.resolve(dir, relPath);
  const relative = path.relative(dir, dest);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write ${relPath}`);
  }
  return dest;
}

function loadProfileSafe() {
  try {
    const profile = loadProfile();
    if (profile && typeof profile.summary === "string" && profile.summary.trim()) {
      return {
        name: profile.name || DEFAULT_PROFILE.name,
        summary: profile.summary.trim(),
        building: profile.building || DEFAULT_PROFILE.building,
      };
    }
  } catch {
    // data/profile.json is optional for a standalone act() call.
  }
  return DEFAULT_PROFILE;
}

function profileStamp(profile) {
  return crypto.createHash("sha256").update(`${profile.name}\n${profile.summary}`).digest("hex").slice(0, 12);
}

function displayPath(filePath) {
  const relative = path.relative(paths.root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return relative.split(path.sep).join("/");
}

function ensureTrailingNewline(value) {
  const text = String(value ?? "").replace(/\s+$/, "");
  return `${text}\n`;
}

function clipSummary(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 280) return clean;
  return `${clean.slice(0, 277).trimEnd()}…`;
}

export function dedent(value) {
  const text = String(value).replace(/^\n/, "").replace(/\n[ \t]*$/, "");
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim());
  const pad = first ? first.match(/^[ \t]*/)[0].length : 0;
  const prefix = " ".repeat(pad);
  return `${lines
    .map((line) => (line.startsWith(prefix) ? line.slice(pad) : line))
    .join("\n")
    .replace(/\s+$/, "")}\n`;
}
