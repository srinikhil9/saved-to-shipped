import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
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
  const dir = options.outDir ? path.resolve(options.outDir) : path.join(paths.artifacts, key);
  const stamp = profileStamp(profile);
  const manifestPath = path.join(dir, "manifest.json");

  if (!options.force) {
    const cached = readCache(dir, manifestPath, stamp);
    if (cached) return toResult(dir, key, cached, true);
  }

  const templateSpec = ensureTrailingNewline(plan.spec(save, profile));
  const templateSummary = clipSummary(plan.summary(save, profile));
  let specMarkdown = templateSpec;
  let summary = templateSummary;
  let source = "template";

  const settings = options.llm || llmSettings(options.env);
  if (settings.apiKey) {
    try {
      const drafted = await draftSpec({
        llm: settings,
        fetchImpl: options.fetchImpl || options.llmFetch || globalThis.fetch,
        profileName: profile.name,
        save,
        fallbackSummary: templateSummary,
      });
      specMarkdown = ensureTrailingNewline(drafted.spec);
      summary = drafted.summary || templateSummary;
      source = "grok";
    } catch {
      specMarkdown = templateSpec;
      summary = templateSummary;
      source = "template";
    }
  }

  const files = [{ path: "SPEC.md", contents: specMarkdown }, ...plan.files(save, profile).map(normalizeFile)];
  assertFiles(files);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const dest = safeJoin(dir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.contents);
  }

  writeZip(path.join(dir, plan.zipName), files);
  const manifest = {
    generator: GENERATOR,
    profileHash: stamp,
    type: plan.type,
    status: "done",
    source,
    summary,
    zipName: plan.zipName,
    files: files.map((file) => file.path),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return toResult(dir, key, manifest, false);
}

export function artifactKey(save) {
  const parsed = parseXStatusUrl(save?.url || "");
  if (parsed) return parsed.id;
  const basis = save?.url || String(save?.id || "save");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function readCache(dir, manifestPath, stamp) {
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
