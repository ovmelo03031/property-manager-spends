import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { base32Decode, createAuth, totpCode } from "../src/auth.ts";
import { openStore, type Store } from "../src/store.ts";

const publicDir = path.resolve(import.meta.dir, "..", "public");
const PASSWORD = "clave-de-prueba-larga";
const T0 = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(appOpts: { secureCookie?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gastos-auth-"));
  const store: Store = openStore(tmp);
  cleanups.push(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const clock = { now: T0 };
  const auth = createAuth(store, { now: () => clock.now });
  const { secret, codes } = await auth.setUser(PASSWORD);
  const app = createApp(store, { publicDir, auth, ...appOpts });
  const key = base32Decode(secret);
  const code = () => totpCode(key, clock.now);
  const login = (password: string, codigo: string, headers: Record<string, string> = {}) =>
    app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ password, codigo }),
    });
  const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const signIn = async () => {
    const r = await login(PASSWORD, code());
    expect(r.status).toBe(200);
    clock.now += 30_000; // next TOTP step, so the next sign-in is not a replay
    return cookieOf(r);
  };
  const get = (url: string, cookie?: string) => app.request(url, { headers: cookie ? { cookie } : {} });
  return { store, auth, app, clock, codes, code, login, cookieOf, signIn, get };
}

describe("totp", () => {
  // RFC 6238 appendix B, SHA-1, 8 digits.
  const key = Buffer.from("12345678901234567890");
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, want] of vectors) {
    it(`matches the RFC 6238 vector at T=${t}`, () => {
      expect(totpCode(key, t * 1000, 8)).toBe(want);
    });
  }
});

describe("without a session", () => {
  const protectedApi: [string, string][] = [
    ["GET", "/api/collection?path=gastos"],
    ["GET", "/api/doc?path=gastos/a"],
    ["PUT", "/api/doc?path=gastos/a"],
    ["PATCH", "/api/doc?path=gastos/a"],
    ["DELETE", "/api/doc?path=gastos/a"],
    ["GET", "/api/events"],
    ["POST", "/api/assets"],
    ["DELETE", "/api/assets/0123456789abcdef0123456789abcdef"],
    ["GET", "/_blob/0123456789abcdef0123456789abcdef"],
    ["GET", "/api/sesion"],
    ["POST", "/api/logout"],
    ["POST", "/api/logout-all"],
  ];
  for (const [method, url] of protectedApi) {
    it(`${method} ${url} returns 401`, async () => {
      const { app } = await setup();
      const r = await app.request(url, { method });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "no autenticado" });
    });
  }

  for (const url of ["/", "/index.html", "/app.js", "/claude-shim.js"]) {
    it(`GET ${url} redirects to the login page`, async () => {
      const { get } = await setup();
      const r = await get(url);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/login.html");
    });
  }

  for (const url of ["/api/health", "/login.html", "/login.js", "/styles.css", "/icon.svg", "/manifest.webmanifest"]) {
    it(`GET ${url} stays public`, async () => {
      const { get } = await setup();
      expect((await get(url)).status).toBe(200);
    });
  }

  it("does not expose auth tables through the document API", async () => {
    const { signIn, get } = await setup();
    const cookie = await signIn();
    for (const p of ["usuarios", "sesiones"]) {
      expect(await (await get(`/api/collection?path=${p}`, cookie)).json()).toEqual([]);
    }
  });
});

describe("login", () => {
  it("sets an HttpOnly SameSite=Strict cookie that opens the API", async () => {
    const { login, code, cookieOf, get } = await setup();
    const r = await login(PASSWORD, code());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^sesion=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    const cookie = cookieOf(r);
    expect((await get("/api/sesion", cookie)).status).toBe(200);
    expect((await get("/api/collection?path=gastos", cookie)).status).toBe(200);
    expect((await get("/", cookie)).status).toBe(200);
  });

  it("adds Secure to every session cookie when secureCookie is on (served over HTTPS)", async () => {
    const { login, code, cookieOf, clock, app } = await setup({ secureCookie: true });
    const r = await login(PASSWORD, code());
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/; HttpOnly; SameSite=Strict; Secure$/);
    const cookie = cookieOf(r);
    clock.now += 2 * 3600_000; // past the hourly refresh threshold
    const refreshed = await app.request("/api/sesion", { headers: { cookie } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("set-cookie")).toMatch(/; Secure$/);
    const out = await app.request("/api/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^sesion=;.*Max-Age=0.*; Secure$/);
  });

  it("stores only a hash of the session token", async () => {
    const { store, signIn } = await setup();
    const token = (await signIn()).split("=")[1]!;
    const rows = store.db.query<{ token_hash: string }, []>("SELECT token_hash FROM sesiones").all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a wrong password", async () => {
    const { login, code } = await setup();
    const r = await login("otra-clave-cualquiera", code());
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "credenciales inválidas" });
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a wrong code", async () => {
    const { login, code } = await setup();
    const bad = String((Number(code()) + 1) % 1_000_000).padStart(6, "0");
    const r = await login(PASSWORD, bad);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "credenciales inválidas" });
  });

  it("accepts the previous step and rejects older ones", async () => {
    const { login, code, clock } = await setup();
    const c = code();
    clock.now += 30_000;
    expect((await login(PASSWORD, c)).status).toBe(200);
    const old = code();
    clock.now += 90_000;
    expect((await login(PASSWORD, old)).status).toBe(401);
  });

  it("rejects a code that was already used", async () => {
    const { login, code } = await setup();
    const c = code();
    expect((await login(PASSWORD, c)).status).toBe(200);
    expect((await login(PASSWORD, c)).status).toBe(401);
  });

  it("accepts each backup code once", async () => {
    const { login, codes } = await setup();
    expect(codes.length).toBe(8);
    expect((await login(PASSWORD, codes[0]!.toLowerCase())).status).toBe(200);
    expect((await login(PASSWORD, codes[0]!)).status).toBe(401);
    expect((await login(PASSWORD, codes[1]!)).status).toBe(200);
  });

  it("does not spend a backup code on a wrong password", async () => {
    const { login, codes } = await setup();
    expect((await login("otra-clave-cualquiera", codes[0]!)).status).toBe(401);
    expect((await login(PASSWORD, codes[0]!)).status).toBe(200);
  });

  it("rejects a login from a foreign origin", async () => {
    const { login, code } = await setup();
    const r = await login(PASSWORD, code(), { Origin: "http://evil.test" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "origen no permitido" });
  });
});

describe("lockout", () => {
  it("locks after 5 failures, persists, and unlocks after the wait", async () => {
    const { login, code, clock, store } = await setup();
    for (let i = 0; i < 5; i++) expect((await login("mala-clave-numero-x", code())).status).toBe(401);
    const locked = await login(PASSWORD, code());
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "demasiados intentos" });
    expect(Number(locked.headers.get("retry-after"))).toBe(30);

    // A new auth over the same database (a restart) is still locked.
    const again = createApp(store, { publicDir, auth: createAuth(store, { now: () => clock.now }) });
    const r = await again.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, codigo: code() }),
    });
    expect(r.status).toBe(429);

    clock.now += 31_000;
    expect((await login(PASSWORD, code())).status).toBe(200);
  });

  it("doubles the wait on each further failure, up to 15 minutes", async () => {
    const { login, code, clock } = await setup();
    const waits: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await login("mala-clave-numero-x", code());
      if (i >= 4) {
        const probe = await login("mala-clave-numero-x", code());
        waits.push(Number(probe.headers.get("retry-after")));
        clock.now += waits[waits.length - 1]! * 1000 + 1000;
      } else {
        expect(r.status).toBe(401);
      }
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
  });

  it("unlock clears the lockout", async () => {
    const { login, code, auth } = await setup();
    for (let i = 0; i < 5; i++) await login("mala-clave-numero-x", code());
    auth.unlock();
    expect((await login(PASSWORD, code())).status).toBe(200);
  });
});

describe("sessions", () => {
  it("logout ends only the current session and clears the cookie", async () => {
    const { app, signIn, get } = await setup();
    const a = await signIn();
    const b = await signIn();
    const r = await app.request("/api/logout", { method: "POST", headers: { cookie: a } });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^sesion=;.*Max-Age=0/);
    expect((await get("/api/sesion", a)).status).toBe(401);
    expect((await get("/api/sesion", b)).status).toBe(200);
  });

  it("logout-all ends every session", async () => {
    const { app, signIn, get } = await setup();
    const a = await signIn();
    const b = await signIn();
    expect((await app.request("/api/logout-all", { method: "POST", headers: { cookie: a } })).status).toBe(200);
    expect((await get("/api/sesion", a)).status).toBe(401);
    expect((await get("/api/sesion", b)).status).toBe(401);
  });

  it("expires after 30 idle days", async () => {
    const { signIn, get, clock } = await setup();
    const c = await signIn();
    clock.now += 31 * DAY;
    expect((await get("/api/sesion", c)).status).toBe(401);
  });

  it("slides while used, up to an absolute 90 days", async () => {
    const { signIn, get, clock } = await setup();
    const c = await signIn();
    for (let i = 0; i < 4; i++) {
      clock.now += 20 * DAY;
      const r = await get("/api/sesion", c); // day 20, 40, 60, 80
      expect(r.status).toBe(200);
      // The cookie is re-sent with the new remaining lifetime: 30 days, capped at 90 days after login
      // (signIn moved the clock 30 s past the login).
      const sinceLogin = (i + 1) * 20 * DAY + 30_000;
      const left = Math.min(30 * DAY, 90 * DAY - sinceLogin) / 1000;
      expect(r.headers.get("set-cookie")).toBe(`${c}; Max-Age=${left}; Path=/; HttpOnly; SameSite=Strict`);
    }
    clock.now += 11 * DAY; // day 91
    expect((await get("/api/sesion", c)).status).toBe(401);
  });

  it("rejects a write from a foreign origin even with a session", async () => {
    const { app, signIn } = await setup();
    const cookie = await signIn();
    const r = await app.request("/api/doc?path=gastos/a", {
      method: "PUT",
      headers: { cookie, Origin: "http://evil.test", "Content-Type": "application/json" },
      body: JSON.stringify({ monto: 1 }),
    });
    expect(r.status).toBe(403);
    const ok = await app.request("http://localhost/api/doc?path=gastos/a", {
      method: "PUT",
      headers: { cookie, Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ monto: 1 }),
    });
    expect(ok.status).toBe(200);
  });

  it("compares Origin with Host, so an HTTPS proxy in front (tailscale serve) still works", async () => {
    const { app, signIn } = await setup();
    const cookie = await signIn();
    const put = (origin: string, extra: Record<string, string> = {}) =>
      app.request("http://127.0.0.1:8080/api/doc?path=gastos/a", {
        method: "PUT",
        headers: { cookie, Origin: origin, "Content-Type": "application/json", ...extra },
        body: JSON.stringify({ monto: 1 }),
      });
    expect((await put("https://app.ts.net", { Host: "app.ts.net" })).status).toBe(200);
    expect((await put("https://app.ts.net", { Host: "127.0.0.1:8080", "X-Forwarded-Host": "app.ts.net" })).status).toBe(200);
    expect((await put("http://evil.test", { Host: "app.ts.net" })).status).toBe(403);
    expect((await put("null", { Host: "app.ts.net" })).status).toBe(403);
    expect((await put("not a url", { Host: "app.ts.net" })).status).toBe(403);
  });

  it("does not hand the old token back on logout when a refresh was due", async () => {
    const { app, signIn, clock } = await setup();
    for (const route of ["/api/logout", "/api/logout-all"]) {
      const cookie = await signIn();
      clock.now += 2 * 3_600_000; // past the refresh interval
      const r = await app.request(route, { method: "POST", headers: { cookie } });
      expect(r.status).toBe(200);
      expect(r.headers.getSetCookie()).toEqual(["sesion=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"]);
    }
  });

  it("closes the event stream on logout", async () => {
    const { app, signIn } = await setup();
    const cookie = await signIn();
    const r = await app.request("/api/events", { headers: { cookie } });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await reader.read(); // ": ok"
    await app.request("/api/logout", { method: "POST", headers: { cookie } });
    expect((await reader.read()).done).toBe(true);
  });
});

describe("hardening", () => {
  it("serves blobs with no-cache and answers 304 to a matching ETag", async () => {
    const { app, signIn } = await setup();
    const cookie = await signIn();
    const up = await app.request("/api/assets", {
      method: "POST",
      headers: { cookie, "Content-Type": "image/png", "X-Filename": "a.png" },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    const { id } = (await up.json()) as { id: string };
    const r = await app.request(`/_blob/${id}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
    const etag = r.headers.get("etag")!;
    expect(etag).toBe(`"${id}"`);
    const again = await app.request(`/_blob/${id}`, { headers: { cookie, "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("sends referrer and framing headers", async () => {
    const { get } = await setup();
    const r = await get("/api/health");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("refuses passwords shorter than 12 characters", async () => {
    const { auth } = await setup();
    await expect(auth.setUser("corta")).rejects.toThrow("al menos 12 caracteres");
  });
});
