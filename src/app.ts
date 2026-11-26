// HTTP API (Hono). The contract is consumed by public/claude-shim.js: keep both in sync.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { serveStatic } from "@hono/bun";
import fs from "node:fs";
import crypto from "node:crypto";
import type { Auth } from "./auth.ts";
import { deepMerge, parsePath, type Store } from "./store.ts";

const COOKIE = "sesion";
/** Reachable without a session: the login page and what it needs, plus the Docker healthcheck. */
const PUBLIC = new Set(["/login.html", "/login.js", "/styles.css", "/icon.svg", "/manifest.webmanifest", "/api/login", "/api/health"]);
// `Secure` only when the app is served over HTTPS (behind Caddy); on plain HTTP the browser would drop the cookie.
const sessionCookieWith = (secure: boolean) => (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

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

/**
 * Parses a single `bytes=` range (`a-b`, `a-`, `-n`). Returns null when there is no usable range
 * (missing, multi-range, or malformed — serve the whole file) and "unsatisfiable" for 416.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Without `auth` every route is open (used by the API tests); the server always passes it. */
export function createApp(store: Store, opts: { publicDir: string; auth?: Auth; secureCookie?: boolean }) {
  const sessionCookie = sessionCookieWith(!!opts.secureCookie);
  const app = new Hono<{ Variables: { sesion?: string } }>();
  const { auth } = opts;

  // ---- live changes (Server-Sent Events) ----
  type Client = { send: (chunk: string) => void; sesion?: string; close: () => void };
  const clients = new Set<Client>();
  const broadcast = (p: string, collection: string) => {
    const msg = `data: ${JSON.stringify({ path: p, collection })}\n\n`;
    for (const cl of clients) cl.send(msg);
  };
  const closeClients = (match: (cl: Client) => boolean) => {
    for (const cl of [...clients]) if (match(cl)) cl.close();
  };

  app.use(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
  });

  // ---- access control: runs before every route and static file ----
  if (auth) {
    app.use(async (c, next) => {
      const method = c.req.method;
      if (method !== "GET" && method !== "HEAD") {
        // Compare hosts, not schemes: behind Caddy the browser is on https:// while this
        // server sees http://. Browsers can't forge Host or X-Forwarded-Host cross-site without a
        // CORS preflight, which this server never grants.
        const origin = c.req.header("origin");
        if (origin) {
          let host: string | undefined;
          try {
            host = new URL(origin).host;
          } catch {}
          const own = [c.req.header("host") ?? new URL(c.req.url).host, c.req.header("x-forwarded-host")];
          if (!host || !own.includes(host)) return c.json({ error: "origen no permitido" }, 403);
        }
      }
      if (PUBLIC.has(c.req.path)) return next();
      const token = getCookie(c, COOKIE);
      const s = auth.session(token);
      if (!s) {
        const p = c.req.path;
        const api = p.startsWith("/api/") || p.startsWith("/_blob/") || (method !== "GET" && method !== "HEAD");
        return api ? c.json({ error: "no autenticado" }, 401) : c.redirect("/login.html", 302);
      }
      c.set("sesion", s.hash);
      await next();
      // Skip when the handler just ended the session (logout), or the old token would come back.
      if (s.refresh && auth.isValid(s.hash)) c.res.headers.append("Set-Cookie", sessionCookie(token!, s.refresh));
    });
  }

  app.onError((err, c) => {
    if (err instanceof PayloadTooLarge) return c.json({ code: "too_large" }, 413);
    console.error(err);
    return c.json({ error: "error interno" }, 500);
  });

  app.get("/api/health", c => c.json({ ok: true }));

  app.get("/api/events", c => {
    const encoder = new TextEncoder();
    const sesion = c.get("sesion");
    let client: Client | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearInterval(ping);
      if (client) clients.delete(client);
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
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        };
        client = { send: write, sesion, close };
        write(": ok\n\n");
        clients.add(client);
        // Each ping also re-checks the session, so expiry or `scripts/auth.ts cerrar-sesiones` ends the stream.
        ping = setInterval(() => (sesion && auth && !auth.isValid(sesion) ? close() : write(": ping\n\n")), 25_000);
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

  // ---- session ----
  if (auth) {
    app.post("/api/login", jsonLimit, async c => {
      const body = await readJson(c);
      const b = isPlainObject(body) ? body : {};
      const r = await auth.login(b.password, b.codigo);
      if (r.kind === "locked") {
        c.header("Retry-After", String(r.retryAfter));
        return c.json({ error: "demasiados intentos" }, 429);
      }
      if (r.kind === "fail") return c.json({ error: "credenciales inválidas" }, 401);
      c.header("Set-Cookie", sessionCookie(r.token, r.maxAge));
      return c.json({ ok: true });
    });

    app.get("/api/sesion", c => c.json({ ok: true }));

    app.post("/api/logout", c => {
      const hash = c.get("sesion")!;
      auth.logout(hash);
      closeClients(cl => cl.sesion === hash);
      c.header("Set-Cookie", sessionCookie("", 0));
      return c.json({ ok: true });
    });

    app.post("/api/logout-all", c => {
      auth.logoutAll();
      closeClients(() => true);
      c.header("Set-Cookie", sessionCookie("", 0));
      return c.json({ ok: true });
    });
  }

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

  app.get("/_blob/:id", async c => {
    const id = c.req.param("id");
    const a = ASSET_ID.test(id) ? store.getAsset(id) : undefined;
    if (!a) return c.body(null, 404);
    const file = Bun.file(store.blobPath(a.id));
    if (!(await file.exists())) return c.body(null, 404);
    const headers = new Headers({
      "Content-Type": a.tipo,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.nombre || a.id)}`,
      // Revalidate every time, so a cached file is never shown without a session. The id never
      // points at other bytes, so the id itself is the ETag.
      "Cache-Control": "private, no-cache",
      ETag: `"${a.id}"`,
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(file.lastModified).toUTCString(),
    });
    if (c.req.header("if-none-match") === `"${a.id}"`) return new Response(null, { status: 304, headers });
    const range = parseRange(c.req.header("range"), file.size);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
    }
    headers.set("Content-Length", String(file.size));
    return new Response(file, { headers });
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
