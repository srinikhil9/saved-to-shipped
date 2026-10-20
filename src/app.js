import express from "express";
import { createSave, getSave, listSaves, publicSave, updateSave } from "./db.js";
import { renderCards, renderDetail, renderFeed, renderNotFound } from "./html.js";
import { paths } from "./paths.js";
import { loadProfile } from "./profile.js";
import { runPipeline } from "./pipeline.js";
import { parseXStatusUrl } from "./xurl.js";

export function createApp(db, options = {}) {
  loadProfile();
  const pipelineOptions = { env: process.env, ...options };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use("/screenshots", express.static(paths.screenshots));

  app.get("/", (_req, res) => {
    res.type("html").send(renderFeed(listSaves(db)));
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
    const row = createSave(db, parsed.url);
    startPipeline(db, row.id, pipelineOptions);
    if (wantsHtml(req)) return res.redirect(303, "/");
    res.status(201).json(publicSave(row));
  });

  app.get("/api/saves", (_req, res) => {
    res.json(listSaves(db).map(publicSave));
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
    const row = updateSave(db, save.id, {
      status: "queued",
      kind: null,
      summary: null,
      why_you: null,
      error: null,
      action_result_json: null,
      screenshot_path: null,
    });
    startPipeline(db, row.id, pipelineOptions);
    if (wantsHtml(req)) return res.redirect(303, `/saves/${row.id}`);
    res.json(publicSave(row));
  });

  return app;
}

function startPipeline(db, id, options) {
  setImmediate(() => {
    runPipeline(db, id, options).catch((error) => {
      console.error("pipeline failed", error);
    });
  });
}

function loadRow(db, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return getSave(db, Number(id));
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
