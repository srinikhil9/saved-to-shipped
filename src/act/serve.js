import fs from "node:fs";
import path from "node:path";
import express from "express";
import { paths } from "../paths.js";

/**
 * Mount the cached starter zips. Step 1 calls this from createApp.
 * Files live in data/artifacts/<status id>/ and are served at /artifacts/<status id>/<name>.zip.
 */
export function mountArtifacts(app, dir = paths.artifacts) {
  fs.mkdirSync(dir, { recursive: true });
  app.use(
    "/artifacts",
    express.static(dir, {
      index: false,
      fallthrough: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (!filePath.endsWith(".zip")) return;
        const filename = path.basename(filePath).replace(/[^A-Za-z0-9._-]/g, "") || "starter.zip";
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      },
    }),
  );
  app.use("/artifacts", (_req, res) => {
    res.status(404).type("text").send("Not found");
  });
}
