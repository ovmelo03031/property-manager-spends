import { afterAll as after, beforeAll as before, describe, it } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, MAX_UPLOAD } from "../src/app.ts";
import { openStore, type Store } from "../src/store.ts";

let tmp: string;
let store: Store;
let app: ReturnType<typeof createApp>;
const publicDir = path.resolve(import.meta.dir, "..", "public");

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gastos-test-"));
  store = openStore(tmp);
  app = createApp(store, { publicDir });
});
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("documents", () => {
  it("returns exists:false for a missing document", async () => {
    const r = await app.request("/api/doc?path=gastos/nope");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: "nope", exists: false });
  });

  it("puts, reads, lists, patches with deep merge, and deletes", async () => {
    assert.deepEqual(await (await json("PUT", "/api/doc?path=gastos/a1", { monto: 10, meta: { x: 1, y: 2 }, tags: [1, 2] })).json(), { ok: true });
    await json("PUT", "/api/doc?path=gastos/a0", { monto: 5 });

    const doc = await (await app.request("/api/doc?path=gastos/a1")).json();
    assert.deepEqual(doc, { id: "a1", exists: true, data: { monto: 10, meta: { x: 1, y: 2 }, tags: [1, 2] } });

    const list = await (await app.request("/api/collection?path=gastos")).json();
    assert.deepEqual(list.map((d: { id: string }) => d.id), ["a0", "a1"]);

    await json("PATCH", "/api/doc?path=gastos/a1", { meta: { y: 3 }, tags: [9] });
    const patched = await (await app.request("/api/doc?path=gastos/a1")).json();
    assert.deepEqual(patched.data, { monto: 10, meta: { x: 1, y: 3 }, tags: [9] });

    assert.deepEqual(await (await json("DELETE", "/api/doc?path=gastos/a1")).json(), { ok: true });
    assert.equal((await (await app.request("/api/doc?path=gastos/a1")).json()).exists, false);
  });

  it("rejects invalid paths and bodies", async () => {
    for (const url of ["/api/doc?path=gastos", "/api/doc?path=a/../b", "/api/doc"]) {
      const r = await app.request(url);
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: "ruta inválida" });
    }
    assert.equal((await app.request("/api/collection?path=gastos/x")).status, 400);

    const arr = await json("PUT", "/api/doc?path=gastos/b", [1]);
    assert.equal(arr.status, 400);
    assert.deepEqual(await arr.json(), { error: "datos inválidos" });
  });

  it("PATCH on a missing document returns 400", async () => {
    const r = await json("PATCH", "/api/doc?path=gastos/missing", { a: 1 });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "el documento no existe" });
  });

  it("maps malformed JSON to 500 and oversized JSON to 413", async () => {
    const bad = await app.request("/api/doc?path=gastos/c", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 500);
    assert.deepEqual(await bad.json(), { error: "error interno" });

    const big = await json("PUT", "/api/doc?path=gastos/c", { s: "x".repeat(300 * 1024) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { code: "too_large" });
  });
});

describe("assets", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it("uploads, serves, and deletes a file", async () => {
    const up = await app.request("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-Filename": encodeURIComponent("recibo ñ.png") },
      body: png,
    });
    assert.equal(up.status, 200);
    const meta = await up.json();
    assert.match(meta.id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...meta, id: undefined }, { id: undefined, url: "/_blob/" + meta.id, sizeBytes: png.length, contentType: "image/png" });

    const blob = await app.request(meta.url);
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get("content-type"), "image/png");
    assert.equal(blob.headers.get("content-disposition"), `inline; filename*=UTF-8''${encodeURIComponent("recibo ñ.png")}`);
    assert.equal(blob.headers.get("cache-control"), "private, no-cache");
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
    assert.equal(blob.headers.get("accept-ranges"), "bytes");

    const part = await app.request(meta.url, { headers: { Range: "bytes=1-3" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 1-3/${png.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(1, 4));
    const tail = await app.request(meta.url, { headers: { Range: "bytes=-2" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), png.subarray(-2));
    const out = await app.request(meta.url, { headers: { Range: "bytes=99-" } });
    assert.equal(out.status, 416);
    assert.equal(out.headers.get("content-range"), `bytes */${png.length}`);

    assert.deepEqual(await (await app.request("/api/assets/" + meta.id, { method: "DELETE" })).json(), { deleted: true });
    assert.deepEqual(await (await app.request("/api/assets/" + meta.id, { method: "DELETE" })).json(), { deleted: false });
    assert.equal((await app.request(meta.url)).status, 404);
  });

  it("rejects unsupported types, empty bodies, bad ids, and oversized files", async () => {
    const txt = await app.request("/api/assets", { method: "POST", headers: { "Content-Type": "text/html" }, body: "<p>" });
    assert.equal(txt.status, 415);
    assert.deepEqual(await txt.json(), { code: "unsupported_type" });

    const empty = await app.request("/api/assets", { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array() });
    assert.equal(empty.status, 400);

    assert.equal((await app.request("/api/assets/xyz", { method: "DELETE" })).status, 400);
    assert.equal((await app.request("/_blob/xyz")).status, 404);

    const big = await app.request("/api/assets", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: new Uint8Array(MAX_UPLOAD + 1) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { code: "too_large" });
  });

  it("does not leave a blob behind when X-Filename is malformed", async () => {
    const before = fs.readdirSync(path.join(tmp, "blobs")).length;
    const r = await app.request("/api/assets", { method: "POST", headers: { "Content-Type": "image/png", "X-Filename": "%E0%A4%A" }, body: png });
    assert.equal(r.status, 500);
    assert.equal(fs.readdirSync(path.join(tmp, "blobs")).length, before);
  });
});

describe("static and headers", () => {
  it("serves index.html with nosniff and health check", async () => {
    const r = await app.request("/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>Gastos Gate Towers<\/title>/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "public, max-age=0");
    assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true });
  });

  it("returns 404 for unknown paths", async () => {
    const r = await app.request("/nope");
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  it("streams SSE events on writes", async () => {
    const ctrl = new AbortController();
    const r = await app.request("/api/events", { signal: ctrl.signal });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    assert.equal(decoder.decode((await reader.read()).value), ": ok\n\n");
    await json("PUT", "/api/doc?path=config/apto", { precio: 1 });
    assert.equal(decoder.decode((await reader.read()).value), `data: ${JSON.stringify({ path: "config/apto", collection: "config" })}\n\n`);
    await reader.cancel();
  });
});
