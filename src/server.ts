// Gastos Gate Towers — homelab server entrypoint (Hono on Bun + bun:sqlite).
import path from "node:path";
import { createApp } from "./app.ts";
import { ntfyFromEnv, startAvisos } from "./avisos.ts";
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

// Expiry push notifications, only when NTFY_URL and NTFY_TOPIC are set.
const ntfy = ntfyFromEnv();
const stopAvisos = ntfy ? startAvisos(store, ntfy) : () => {};
console.log(ntfy ? `Avisos de vencimiento activos (ntfy: ${ntfy.url}, tema ${ntfy.topic})` : "Avisos de vencimiento desactivados (sin NTFY_URL y NTFY_TOPIC)");

// Close cleanly on `docker stop` so SQLite checkpoints the WAL.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stopAvisos();
    await server.stop(true); // true = also close open SSE connections
    store.close();
    process.exit(0);
  });
}
