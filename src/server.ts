// Gastos Gate Towers — homelab server entrypoint (Hono on Bun + bun:sqlite).
import path from "node:path";
import { createApp } from "./app.ts";
import { openStore, seed } from "./store.ts";

// Project root: one level above src/.
const ROOT = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const SEED_DIR = path.resolve(process.env.SEED_DIR || path.join(ROOT, "seed"));

const store = openStore(DATA_DIR);
seed(store, SEED_DIR);
const app = createApp(store, { publicDir: path.join(ROOT, "public") });

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  // Bun closes connections idle for 10 s by default; SSE pings every 25 s, so allow more.
  idleTimeout: 60,
});
console.log(`Gastos Gate Towers en http://0.0.0.0:${server.port} (datos en ${DATA_DIR})`);

// Close cleanly on `docker stop` so SQLite checkpoints the WAL.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.stop(true); // true = also close open SSE connections
    store.close();
    process.exit(0);
  });
}
