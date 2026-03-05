import express, { type Express } from "express";
import fs from "fs";
import path from "path";

const distPath = path.resolve(process.cwd(), "dist", "public");

export function serveStaticEarly(app: Express) {
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));
}

export function serveStaticFallback(app: Express) {
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "freshtrade.html"));
  });
}

export function serveStatic(app: Express) {
  serveStaticEarly(app);
  serveStaticFallback(app);
}
