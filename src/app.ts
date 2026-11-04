// HTTP API (Hono). The contract is consumed by public/claude-shim.js: keep both in sync.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import crypto from "node:crypto";
import { deepMerge, parsePath, type Store } from "./store.js";

export const MAX_UPLOAD = 20 * 1024 * 1024;
export const MAX_JSON = 256 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const ASSET_ID = /^[0-9a-f]{32}$/;

class PayloadTooLarge extends Error {}
const tooLarge = () => {
  throw new PayloadTooLarge();
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Mirrors express.json({ strict: true }): non-JSON content types yield {}, an empty body yields {},
 * and anything that is not an object or array (or fails to parse) throws, which maps to 500.
 */
async function readJson(c: Context): Promise<unknown> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return {};
  const text = await c.req.text();
  if (!text.length) return {};
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") throw new SyntaxError("JSON body must be an object or array");
  return JSON.parse(text);
}

export function createApp(store: Store, opts: { publicDir: string }) {
  const app = new Hono();

  // ---- live changes (Server-Sent Events) ----
  const clients = new Set<(chunk: string) => void>();
  const broadcast = (p: string, collection: string) => {
    const msg = `data: ${JSON.stringify({ path: p, collection })}\n\n`;
    for (const send of clients) send(msg);
  };

  app.use(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  app.onError((err, c) => {
    if (err instanceof PayloadTooLarge) return c.json({ code: "too_large" }, 413);
    console.error(err);
    return c.json({ error: "error interno" }, 500);
  });

  app.get("/api/health", c => c.json({ ok: true }));

  app.get("/api/events", c => {
    const encoder = new TextEncoder();
    let send: ((chunk: string) => void) | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearInterval(ping);
      if (send) clients.delete(send);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        send = write;
        write(": ok\n\n");
        clients.add(write);
        ping = setInterval(() => write(": ping\n\n"), 25_000);
        c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel: cleanup,
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

  // ---- documents ----
  app.get("/api/collection", c => {
    const ref = parsePath(c.req.query("path"), false);
    if (!ref) return c.json({ error: "ruta inválida" }, 400);
    return c.json(store.listDocs(ref.path));
  });

  app.get("/api/doc", c => {
    const ref = parsePath(c.req.query("path"), true);
    if (!ref) return c.json({ error: "ruta inválida" }, 400);
    const r = store.getDoc(ref.path);
    return c.json(r ? { id: r.id, exists: true, data: r.data } : { id: ref.id, exists: false });
  });

  const jsonLimit = bodyLimit({ maxSize: MAX_JSON, onError: tooLarge });

  app.put("/api/doc", jsonLimit, async c => {
    const body = await readJson(c);
    const ref = parsePath(c.req.query("path"), true);
    if (!ref || !isPlainObject(body)) return c.json({ error: "datos inválidos" }, 400);
    store.putDoc(ref, body);
    broadcast(ref.path, ref.collection);
    return c.json({ ok: true });
  });

  app.patch("/api/doc", jsonLimit, async c => {
    const body = await readJson(c);
    const ref = parsePath(c.req.query("path"), true);
    if (!ref || !isPlainObject(body)) return c.json({ error: "datos inválidos" }, 400);
    const r = store.getDoc(ref.path);
    if (!r) return c.json({ error: "el documento no existe" }, 400);
    store.putDoc(ref, deepMerge(r.data, body));
    broadcast(ref.path, ref.collection);
    return c.json({ ok: true });
  });

  app.delete("/api/doc", c => {
    const ref = parsePath(c.req.query("path"), true);
    if (!ref) return c.json({ error: "ruta inválida" }, 400);
    store.deleteDoc(ref.path);
    broadcast(ref.path, ref.collection);
    return c.json({ ok: true });
  });

  // ---- files ----
  app.post("/api/assets", bodyLimit({ maxSize: MAX_UPLOAD, onError: tooLarge }), async c => {
    const body = Buffer.from(await c.req.arrayBuffer());
    const tipo = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    if (!ALLOWED.has(tipo)) return c.json({ code: "unsupported_type" }, 415);
    if (!body.length) return c.json({ code: "invalid_request" }, 400);
    const id = crypto.randomBytes(16).toString("hex");
    // Decode before writing so a malformed header cannot leave an orphan blob behind.
    const nombre = decodeURIComponent(c.req.header("x-filename") || id).slice(0, 255);
    fs.writeFileSync(store.blobPath(id), body);
    store.insertAsset(id, nombre, tipo, body.length);
    return c.json({ id, url: "/_blob/" + id, sizeBytes: body.length, contentType: tipo });
  });

  app.delete("/api/assets/:id", c => {
    const id = c.req.param("id");
    if (!ASSET_ID.test(id)) return c.json({ code: "invalid_request" }, 400);
    const had = !!store.getAsset(id);
    store.deleteAsset(id);
    fs.rmSync(store.blobPath(id), { force: true });
    return c.json({ deleted: had });
  });

  app.get("/_blob/:id", async (c, next) => {
    const id = c.req.param("id");
    const a = ASSET_ID.test(id) ? store.getAsset(id) : undefined;
    if (!a) return c.body(null, 404);
    // serveStatic handles streaming, Range requests and Content-Length; we override the metadata headers.
    const res = await serveStatic({ path: store.blobPath(a.id) })(c, next);
    if (!res) return c.body(null, 404);
    res.headers.set("Content-Type", a.tipo);
    res.headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.nombre || a.id)}`);
    res.headers.set("Cache-Control", "private, max-age=31536000, immutable");
    res.headers.set("Accept-Ranges", "bytes");
    return res;
  });

  // max-age=0 makes browsers revalidate app.js/styles.css, so a redeploy is picked up on reload.
  const statics = serveStatic({ root: opts.publicDir });
  app.use("*", async (c, next) => {
    const res = await statics(c, next);
    // On a miss serveStatic falls through to next() and returns whatever it returns, not a Response.
    if (res instanceof Response) {
      res.headers.set("Cache-Control", "public, max-age=0");
      res.headers.set("Accept-Ranges", "bytes");
    }
    return res;
  });

  return app;
}
