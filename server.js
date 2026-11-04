// Gastos Gate Towers — servidor para homelab (Express + SQLite).
// Guarda documentos JSON por ruta ("gastos/<id>", "config/apto"...) y archivos (comprobantes, PDFs).
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const SEED_DIR = path.resolve(process.env.SEED_DIR || path.join(__dirname, "seed"));
const BLOB_DIR = path.join(DATA_DIR, "blobs");
const MAX_UPLOAD = 20 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

fs.mkdirSync(BLOB_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "gastos.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY, collection TEXT NOT NULL, id TEXT NOT NULL,
    data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection);
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, nombre TEXT, tipo TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
`);

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function parsePath(p, wantDoc) {
  if (typeof p !== "string") return null;
  const segs = p.split("/");
  if (!segs.length || segs.some(s => !SEG.test(s) || s === "." || s === "..")) return null;
  if (wantDoc !== (segs.length % 2 === 0)) return null;
  return { path: p, collection: wantDoc ? segs.slice(0, -1).join("/") : p, id: segs[segs.length - 1] };
}

const q = {
  get: db.prepare("SELECT id, data FROM docs WHERE path = ?"),
  list: db.prepare("SELECT id, data FROM docs WHERE collection = ? ORDER BY id"),
  upsert: db.prepare(`INSERT INTO docs (path, collection, id, data, updated_at) VALUES (@path, @collection, @id, @data, @t)
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  del: db.prepare("DELETE FROM docs WHERE path = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM docs"),
  assetGet: db.prepare("SELECT * FROM assets WHERE id = ?"),
  assetIns: db.prepare("INSERT OR REPLACE INTO assets (id, nombre, tipo, bytes, created_at) VALUES (?, ?, ?, ?, ?)"),
  assetDel: db.prepare("DELETE FROM assets WHERE id = ?"),
};

// ---- seed (solo la primera vez, con la base vacía) ----
function seed() {
  const file = path.join(SEED_DIR, "seed.json");
  if (q.count.get().n > 0 || !fs.existsSync(file)) return;
  const { docs = {}, assets = {} } = JSON.parse(fs.readFileSync(file, "utf8"));
  const t = Date.now();
  db.transaction(() => {
    for (const [p, data] of Object.entries(docs)) {
      const ref = parsePath(p, true); if (ref) q.upsert.run({ ...ref, data: JSON.stringify(data), t });
    }
    for (const [id, meta] of Object.entries(assets)) {
      const src = path.join(SEED_DIR, "blobs", id);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(BLOB_DIR, id));
      q.assetIns.run(id, meta.nombre || id, meta.tipo, fs.statSync(src).size, t);
    }
  })();
  console.log(`Seed cargado: ${Object.keys(docs).length} documentos, ${Object.keys(assets).length} archivos`);
}
seed();

// ---- cambios en vivo (Server-Sent Events) ----
const clients = new Set();
function broadcast(p, collection) {
  const msg = `data: ${JSON.stringify({ path: p, collection })}\n\n`;
  for (const res of clients) res.write(msg);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders(); res.write(": ok\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.get("/api/collection", (req, res) => {
  const ref = parsePath(req.query.path, false); if (!ref) return res.status(400).json({ error: "ruta inválida" });
  res.json(q.list.all(ref.path).map(r => ({ id: r.id, data: JSON.parse(r.data) })));
});

app.get("/api/doc", (req, res) => {
  const ref = parsePath(req.query.path, true); if (!ref) return res.status(400).json({ error: "ruta inválida" });
  const r = q.get.get(ref.path);
  res.json(r ? { id: r.id, exists: true, data: JSON.parse(r.data) } : { id: ref.id, exists: false });
});

const json = express.json({ limit: "256kb" });
app.put("/api/doc", json, (req, res) => {
  const ref = parsePath(req.query.path, true);
  if (!ref || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "datos inválidos" });
  q.upsert.run({ ...ref, data: JSON.stringify(req.body), t: Date.now() });
  broadcast(ref.path, ref.collection); res.json({ ok: true });
});
app.patch("/api/doc", json, (req, res) => {
  const ref = parsePath(req.query.path, true);
  if (!ref || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "datos inválidos" });
  const r = q.get.get(ref.path); if (!r) return res.status(400).json({ error: "el documento no existe" });
  q.upsert.run({ ...ref, data: JSON.stringify(deepMerge(JSON.parse(r.data), req.body)), t: Date.now() });
  broadcast(ref.path, ref.collection); res.json({ ok: true });
});
app.delete("/api/doc", (req, res) => {
  const ref = parsePath(req.query.path, true); if (!ref) return res.status(400).json({ error: "ruta inválida" });
  q.del.run(ref.path); broadcast(ref.path, ref.collection); res.json({ ok: true });
});

// ---- archivos ----
app.post("/api/assets", express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
  const tipo = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (!ALLOWED.has(tipo)) return res.status(415).json({ code: "unsupported_type" });
  if (!req.body?.length) return res.status(400).json({ code: "invalid_request" });
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(BLOB_DIR, id), req.body);
  const nombre = decodeURIComponent(String(req.headers["x-filename"] || id)).slice(0, 255);
  q.assetIns.run(id, nombre, tipo, req.body.length, Date.now());
  res.json({ id, url: "/_blob/" + id, sizeBytes: req.body.length, contentType: tipo });
});
app.delete("/api/assets/:id", (req, res) => {
  const id = req.params.id; if (!/^[0-9a-f]{32}$/.test(id)) return res.status(400).json({ code: "invalid_request" });
  const had = !!q.assetGet.get(id); q.assetDel.run(id);
  fs.rmSync(path.join(BLOB_DIR, id), { force: true });
  res.json({ deleted: had });
});
app.get("/_blob/:id", (req, res) => {
  const a = /^[0-9a-f]{32}$/.test(req.params.id) && q.assetGet.get(req.params.id);
  if (!a) return res.status(404).end();
  res.set({ "Content-Type": a.tipo, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.nombre || a.id)}`, "Cache-Control": "private, max-age=31536000, immutable" });
  res.sendFile(path.join(BLOB_DIR, a.id));
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ code: "too_large" });
  console.error(err); res.status(500).json({ error: "error interno" });
});

app.listen(PORT, () => console.log(`Gastos Gate Towers en http://0.0.0.0:${PORT} (datos en ${DATA_DIR})`));
