import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

/**
 * Serve starter zips. A rebuilt copy in data/artifacts-runtime/ wins.
 * The committed seed copies in data/artifacts/ are only a fallback.
 */
export function mountArtifacts(app, options = {}) {
  const committed = options.committed || paths.artifacts;
  const runtime = options.runtime || paths.artifactsRuntime;
  fs.mkdirSync(committed, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  app.use("/artifacts", (req, res, next) => {
    const file = resolveArtifact(runtime, req.path) || resolveArtifact(committed, req.path);
    if (!file) return next();
    if (file.endsWith(".zip")) {
      const filename = path.basename(file).replace(/[^A-Za-z0-9._-]/g, "") || "starter.zip";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }
    res.sendFile(file, (error) => {
      if (error && !res.headersSent) next();
    });
  });
  app.use("/artifacts", (_req, res) => {
    res.status(404).type("text").send("Not found");
  });
}

function resolveArtifact(root, requestPath) {
  let rel = "";
  try {
    rel = decodeURIComponent(String(requestPath || "")).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!rel || rel.split("/").includes("..")) return null;
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}
