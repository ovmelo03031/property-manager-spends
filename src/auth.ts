// Single-user login: password (argon2id via Bun.password) + mandatory TOTP (RFC 6238) or a
// single-use backup code. Sessions are random tokens; the database keeps only their SHA-256.
import crypto from "node:crypto";
import type { Store } from "./store.ts";

export const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const STEP_MS = 30_000;
const DAY = 86_400_000;
export const SESSION_IDLE_MS = 30 * DAY;
export const SESSION_MAX_MS = 90 * DAY;
/** Sliding expiry is written at most this often, so reads don't turn into writes. */
const TOUCH_MS = 3_600_000;
const FREE_FAILURES = 5;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;
const BACKUP_CODES = 8;

// ---- TOTP ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key: Uint8Array, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

/** TOTP code for the 30 s step that contains `timeMs`. */
export function totpCode(key: Uint8Array, timeMs: number, digits = 6): string {
  return hotp(key, Math.floor(timeMs / STEP_MS), digits);
}

// ---- helpers ----

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normBackup = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");

function newBackupCode(): string {
  const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

// ---- auth ----

interface UserRow {
  pass_hash: string;
  totp_secret: string;
  totp_ultimo: number;
  respaldo: string;
  fallos: number;
  bloqueado_hasta: number;
}
interface SessionRow {
  token_hash: string;
  creado: number;
  visto: number;
  expira: number;
}

export type LoginResult =
  | { kind: "ok"; token: string; maxAge: number }
  | { kind: "fail" }
  | { kind: "locked"; retryAfter: number };

export interface Session {
  hash: string;
  /** Seconds left, set when the sliding expiry moved and the cookie should be re-sent. */
  refresh?: number;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(store: Store, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const db = store.db;
  const q = {
    user: db.query<UserRow, []>("SELECT * FROM usuarios WHERE id = 1"),
    putUser: db.query<never, [string, string, string, number]>(
      `INSERT INTO usuarios (id, pass_hash, totp_secret, respaldo, creado) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pass_hash = excluded.pass_hash, totp_secret = excluded.totp_secret,
         totp_ultimo = 0, respaldo = excluded.respaldo, fallos = 0, bloqueado_hasta = 0, creado = excluded.creado`,
    ),
    fail: db.query<never, [number, number]>("UPDATE usuarios SET fallos = ?, bloqueado_hasta = ? WHERE id = 1"),
    success: db.query<never, [number, string]>(
      "UPDATE usuarios SET fallos = 0, bloqueado_hasta = 0, totp_ultimo = ?, respaldo = ? WHERE id = 1",
    ),
    unlock: db.query<never, []>("UPDATE usuarios SET fallos = 0, bloqueado_hasta = 0 WHERE id = 1"),
    sesGet: db.query<SessionRow, [string]>("SELECT * FROM sesiones WHERE token_hash = ?"),
    sesIns: db.query<never, [string, number, number, number]>(
      "INSERT INTO sesiones (token_hash, creado, visto, expira) VALUES (?, ?, ?, ?)",
    ),
    sesTouch: db.query<never, [number, number, string]>("UPDATE sesiones SET visto = ?, expira = ? WHERE token_hash = ?"),
    sesDel: db.query<never, [string]>("DELETE FROM sesiones WHERE token_hash = ?"),
    sesDelAll: db.query<never, []>("DELETE FROM sesiones"),
    sesPurge: db.query<never, [number]>("DELETE FROM sesiones WHERE expira <= ?"),
  };

  /** Which TOTP step `code` matches (current ±1), or null. Steps already used are rejected. */
  function totpStep(u: UserRow, code: string, t: number): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const key = base32Decode(u.totp_secret);
    const step = Math.floor(t / STEP_MS);
    for (const s of [step - 1, step, step + 1]) {
      if (s > u.totp_ultimo && safeEqual(hotp(key, s, 6), code)) return s;
    }
    return null;
  }

  async function attempt(password: unknown, codigo: unknown): Promise<LoginResult> {
    const t = now();
    const u = q.user.get();
    if (!u) return { kind: "fail" };
    if (u.bloqueado_hasta > t) return { kind: "locked", retryAfter: Math.ceil((u.bloqueado_hasta - t) / 1000) };

    const pw = typeof password === "string" && password.length <= MAX_PASSWORD ? password : "";
    const code = typeof codigo === "string" ? codigo.trim() : "";
    const passOk = pw !== "" && (await Bun.password.verify(pw, u.pass_hash));

    const step = totpStep(u, code, t);
    const backups = JSON.parse(u.respaldo) as string[];
    const backupHash = step === null && code ? sha256(normBackup(code)) : "";
    const backupIdx = backupHash ? backups.findIndex(h => safeEqual(h, backupHash)) : -1;

    if (passOk && (step !== null || backupIdx >= 0)) {
      if (backupIdx >= 0) backups.splice(backupIdx, 1);
      q.success.run(step ?? u.totp_ultimo, JSON.stringify(backups));
      q.sesPurge.run(t);
      const token = crypto.randomBytes(32).toString("base64url");
      q.sesIns.run(sha256(token), t, t, t + SESSION_IDLE_MS);
      return { kind: "ok", token, maxAge: SESSION_IDLE_MS / 1000 };
    }

    const fallos = u.fallos + 1;
    const wait = fallos >= FREE_FAILURES ? Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (fallos - FREE_FAILURES)) : 0;
    q.fail.run(fallos, wait ? t + wait : 0);
    return { kind: "fail" };
  }

  // Attempts run one at a time, so parallel requests can't slip past the lockout or reuse a code.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    hasUser: () => !!q.user.get(),

    /** Creates or replaces the user. Ends every session. Returns the TOTP secret and backup codes. */
    async setUser(password: string): Promise<{ secret: string; uri: string; codes: string[] }> {
      if (password.length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
      if (password.length > MAX_PASSWORD) throw new Error(`La contraseña no puede superar ${MAX_PASSWORD} caracteres`);
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const secret = base32Encode(crypto.randomBytes(20));
      const codes = Array.from({ length: BACKUP_CODES }, newBackupCode);
      db.transaction(() => {
        q.putUser.run(hash, secret, JSON.stringify(codes.map(c => sha256(normBackup(c)))), now());
        q.sesDelAll.run();
      })();
      const uri = `otpauth://totp/Gastos?secret=${secret}&issuer=Gastos&algorithm=SHA1&digits=6&period=30`;
      return { secret, uri, codes };
    },

    login(password: unknown, codigo: unknown): Promise<LoginResult> {
      const run = queue.then(() => attempt(password, codigo));
      queue = run.catch(() => {});
      return run;
    },

    /** Validates a cookie token and slides its expiry. */
    session(token: string | undefined): Session | null {
      if (!token || token.length > 128) return null;
      const hash = sha256(token);
      const s = q.sesGet.get(hash);
      if (!s) return null;
      const t = now();
      const cap = s.creado + SESSION_MAX_MS;
      if (s.expira <= t || cap <= t) {
        q.sesDel.run(hash);
        return null;
      }
      if (t - s.visto < TOUCH_MS) return { hash };
      const expira = Math.min(t + SESSION_IDLE_MS, cap);
      q.sesTouch.run(t, expira, hash);
      return { hash, refresh: Math.floor((expira - t) / 1000) };
    },

    /** True while the session behind `hash` exists and has not expired. */
    isValid(hash: string): boolean {
      const s = q.sesGet.get(hash);
      const t = now();
      return !!s && s.expira > t && s.creado + SESSION_MAX_MS > t;
    },

    logout: (hash: string) => void q.sesDel.run(hash),
    logoutAll: () => void q.sesDelAll.run(),
    unlock: () => void q.unlock.run(),
  };
}
