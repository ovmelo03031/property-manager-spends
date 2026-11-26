// SQLite-backed document store keyed by path ("gastos/<id>", "config/apto"…) plus file metadata.
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface PathRef {
  path: string;
  collection: string;
  id: string;
}

export interface AssetRow {
  id: string;
  nombre: string | null;
  tipo: string;
  bytes: number;
  created_at: number;
}

type Json = Record<string, unknown>;

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

/** Even segment count = document, odd = collection. Returns null for invalid paths. */
export function parsePath(p: unknown, wantDoc: boolean): PathRef | null {
  if (typeof p !== "string") return null;
  const segs = p.split("/");
  if (!segs.length || segs.some(s => !SEG.test(s) || s === "." || s === "..")) return null;
  if (wantDoc !== (segs.length % 2 === 0)) return null;
  return { path: p, collection: wantDoc ? segs.slice(0, -1).join("/") : p, id: segs[segs.length - 1]! };
}

const isPlainObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Recursively merges plain objects; arrays and primitives in `b` replace those in `a`. */
export function deepMerge(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(dataDir: string) {
  const blobDir = path.join(dataDir, "blobs");
  fs.mkdirSync(blobDir, { recursive: true });
  // strict: named parameters bind without a prefix and missing ones throw instead of binding NULL.
  const db = new Database(path.join(dataDir, "gastos.db"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY, collection TEXT NOT NULL, id TEXT NOT NULL,
      data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, nombre TEXT, tipo TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
    -- Auth lives outside docs so the document API can never read it. Single user (id = 1).
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY CHECK (id = 1), pass_hash TEXT NOT NULL, totp_secret TEXT NOT NULL,
      totp_ultimo INTEGER NOT NULL DEFAULT 0, respaldo TEXT NOT NULL DEFAULT '[]',
      fallos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta INTEGER NOT NULL DEFAULT 0, creado INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sesiones (
      token_hash TEXT PRIMARY KEY, creado INTEGER NOT NULL, visto INTEGER NOT NULL, expira INTEGER NOT NULL);
  `);

  type Row = { id: string; data: string };
  const q = {
    get: db.query<Row, [string]>("SELECT id, data FROM docs WHERE path = ?"),
    list: db.query<Row, [string]>("SELECT id, data FROM docs WHERE collection = ? ORDER BY id"),
    upsert: db.query<never, [{ path: string; collection: string; id: string; data: string; t: number }]>(
      `INSERT INTO docs (path, collection, id, data, updated_at) VALUES ($path, $collection, $id, $data, $t)
       ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ),
    del: db.query<never, [string]>("DELETE FROM docs WHERE path = ?"),
    count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM docs"),
    assetGet: db.query<AssetRow, [string]>("SELECT * FROM assets WHERE id = ?"),
    assetIns: db.query<never, [string, string, string, number, number]>(
      "INSERT OR REPLACE INTO assets (id, nombre, tipo, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
    ),
    assetDel: db.query<never, [string]>("DELETE FROM assets WHERE id = ?"),
  };

  const putDoc = (ref: PathRef, data: unknown) =>
    q.upsert.run({ path: ref.path, collection: ref.collection, id: ref.id, data: JSON.stringify(data), t: Date.now() });

  return {
    db,
    blobPath: (id: string) => path.join(blobDir, id),
    getDoc: (p: string): { id: string; data: Json } | undefined => {
      const r = q.get.get(p);
      return r ? { id: r.id, data: JSON.parse(r.data) as Json } : undefined;
    },
    listDocs: (collection: string) => q.list.all(collection).map(r => ({ id: r.id, data: JSON.parse(r.data) as Json })),
    putDoc,
    deleteDoc: (p: string) => q.del.run(p),
    countDocs: () => q.count.get()!.n,
    getAsset: (id: string) => q.assetGet.get(id) ?? undefined,
    insertAsset: (id: string, nombre: string, tipo: string, bytes: number) => q.assetIns.run(id, nombre, tipo, bytes, Date.now()),
    deleteAsset: (id: string) => q.assetDel.run(id),
    close: () => db.close(),
  };
}

/** Loads seed/seed.json and seed/blobs/ only when the database is empty. */
export function seed(store: Store, seedDir: string): void {
  const file = path.join(seedDir, "seed.json");
  if (store.countDocs() > 0 || !fs.existsSync(file)) return;
  const { docs = {}, assets = {} } = JSON.parse(fs.readFileSync(file, "utf8")) as {
    docs?: Record<string, unknown>;
    assets?: Record<string, { nombre?: string; tipo: string }>;
  };
  store.db.transaction(() => {
    for (const [p, data] of Object.entries(docs)) {
      const ref = parsePath(p, true);
      if (ref) store.putDoc(ref, data);
    }
    for (const [id, meta] of Object.entries(assets)) {
      const src = path.join(seedDir, "blobs", id);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, store.blobPath(id));
      store.insertAsset(id, meta.nombre || id, meta.tipo, fs.statSync(src).size);
    }
  })();
  console.log(`Seed cargado: ${Object.keys(docs).length} documentos, ${Object.keys(assets).length} archivos`);
}
