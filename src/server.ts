// Gastos Gate Towers — homelab server entrypoint (Hono on Node + SQLite).
import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openStore, seed } from "./store.js";

// Project root: one level above src/ (dev, via tsx) or dist/ (production build).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const SEED_DIR = path.resolve(process.env.SEED_DIR || path.join(ROOT, "seed"));

const store = openStore(DATA_DIR);
seed(store, SEED_DIR);
const app = createApp(store, { publicDir: path.join(ROOT, "public") });

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Gastos Gate Towers en http://0.0.0.0:${PORT} (datos en ${DATA_DIR})`);
});

// Close cleanly on `docker stop` so SQLite checkpoints the WAL.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Open SSE connections would keep the server alive; drop them, with a hard timeout as backstop.
    if ("closeAllConnections" in server) server.closeAllConnections();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 3_000).unref();
  });
}
