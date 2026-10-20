import express from "express";
import { mountArtifacts } from "./act/serve.js";
import { buildDigest, parseSince } from "./digest.js";
import { createSave, deleteBotProfile, findSaveByUrl, getSave, listSaves, publicSave, saveBotProfile, updateSave } from "./db.js";
import { llmSettings, sanitizedEnv } from "./env.js";
import { renderCards, renderDetail, renderFeed, renderNotFound } from "./html.js";
import { paths } from "./paths.js";
import { presentProfile, resolveProfile, validateProfile } from "./profile.js";
import { runPipeline } from "./pipeline.js";
import { backfillWhyYou, retargetWhyYou } from "./why.js";
import { parseXStatusUrl } from "./xurl.js";

export function createApp(db, options = {}) {
  const source = options.env ?? process.env;
  const profileOf = () => viewProfile(db, options).profile;
  backfillWhyYou(db, profileOf());
  const pipelineOptions = {
    offline: options.offline === true,
    fetchImpl: options.fetchImpl,
    fixturesDir: options.fixturesDir,
    cacheDir: options.cacheDir,
    awaitLive: options.awaitLive === true,
    awaitWhy: options.awaitWhy === true,
    llm: options.llm ?? llmSettings(source),
    childEnv: options.childEnv ?? sanitizedEnv(source),
    llmFetch: options.llmFetch,
    whyFetch: options.whyFetch,
    whyTimeoutMs: options.whyTimeoutMs,
    awaitSpec: options.awaitSpec === true,
    specTimeoutMs: options.specTimeoutMs,
    runRepo: options.runRepo,
    demoBudgetMs: options.demoBudgetMs,
    screenshotDir: options.screenshotDir,
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use("/screenshots", express.static(paths.screenshots));
  mountArtifacts(app);

  app.get("/", (_req, res) => {
    res.type("html").send(renderFeed(listSaves(db), viewProfile(db, options)));
  });

  app.get("/feed/cards", (_req, res) => {
    res.type("html").send(renderCards(listSaves(db)));
  });

  app.get("/saves/:id", (req, res) => {
    const save = loadRow(db, req.params.id);
    if (!save) return res.status(404).type("html").send(renderNotFound());
    res.type("html").send(renderDetail(save));
  });

  app.post("/api/saves", (req, res) => {
    const parsed = parseXStatusUrl(readUrl(req));
    if (!parsed) {
      return sendError(req, res, 400, "Paste a public X post URL, like https://x.com/user/status/123");
    }
    const existing = findSaveByUrl(db, parsed.url);
    if (existing) {
      if (wantsHtml(req)) return res.redirect(303, `/saves/${existing.id}`);
      return res.status(200).json(publicSave(existing));
    }
    const row = createSave(db, parsed.url);
    startPipeline(db, row.id, pipelineOptions, profileOf);
    if (wantsHtml(req)) return res.redirect(303, "/");
    res.status(201).json(publicSave(row));
  });

  app.get("/api/saves", (_req, res) => {
    res.json(listSaves(db).map(publicSave));
  });

  app.get("/api/digest", (req, res) => {
    const since = parseSince(req.query.since);
    if (!since) return res.status(400).json({ error: "since must be an ISO timestamp" });
    res.json(buildDigest(listSaves(db), profileOf(), { since, baseUrl: publicBase(req, source) }));
  });

  app.get("/api/profile", (_req, res) => {
    res.json(presentProfile(viewProfile(db, options)));
  });

  app.put("/api/profile", (req, res) => {
    if (!isJsonRequest(req)) {
      return res.status(400).json({ error: "Content-Type must be application/json" });
    }
    const parsed = validateProfile(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const syncedAt = new Date().toISOString();
    saveBotProfile(db, parsed.profile, syncedAt);
    const state = resolveProfile(db);
    retargetWhyYou(db, state.profile);
    res.json(presentProfile(state));
  });

  app.delete("/api/profile", (_req, res) => {
    deleteBotProfile(db);
    const state = resolveProfile(db);
    retargetWhyYou(db, state.profile);
    res.json(presentProfile(viewProfile(db, options)));
  });

  app.get("/api/saves/:id", (req, res) => {
    const save = loadRow(db, req.params.id);
    if (!save) return res.status(404).json({ error: "Save not found" });
    res.json(publicSave(save));
  });

  app.post("/api/saves/:id/rerun", (req, res) => {
    const save = loadRow(db, req.params.id);
    if (!save) {
      return wantsHtml(req) ? res.redirect(303, "/") : res.status(404).json({ error: "Save not found" });
    }
    const row = updateSave(db, save.id, { status: "queued", error: null });
    startPipeline(db, row.id, { ...pipelineOptions, force: readForce(req) }, profileOf);
    if (wantsHtml(req)) return res.redirect(303, `/saves/${row.id}`);
    res.json(publicSave(row));
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400)) {
      return res.status(400).json({ error: "Request body must be JSON" });
    }
    return next(err);
  });

  return app;
}

function viewProfile(db, options) {
  if (options.profile) return { profile: options.profile, source: "default", synced_at: null };
  return resolveProfile(db);
}

function startPipeline(db, id, options, profileOf) {
  setImmediate(() => {
    runPipeline(db, id, { ...options, profile: profileOf() }).catch((error) => {
      console.error("pipeline failed", error);
    });
  });
}

function isJsonRequest(req) {
  return (req.get("content-type") || "").includes("application/json");
}

function publicBase(req, source) {
  const configured = typeof source?.BASE_URL === "string" ? source.BASE_URL.trim() : "";
  if (configured) return configured.replace(/\/$/, "");
  const host = req.get("host");
  if (!host) return "";
  const forwarded = req.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : req.protocol || "http";
  return `${proto}://${host}`;
}

function loadRow(db, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return getSave(db, Number(id));
}

function readForce(req) {
  if (req.query?.force === "1") return true;
  const value = req.body?.force;
  return value === true || value === "1" || value === "true";
}

function readUrl(req) {
  if (req.body && typeof req.body.url === "string") return req.body.url;
  return "";
}

function wantsHtml(req) {
  const type = req.get("content-type") || "";
  if (type.includes("application/json")) return false;
  const accept = req.get("accept") || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) return false;
  return type.includes("application/x-www-form-urlencoded") || accept.includes("text/html");
}

function sendError(req, res, status, message) {
  if (wantsHtml(req)) return res.redirect(303, "/");
  return res.status(status).json({ error: message });
}
