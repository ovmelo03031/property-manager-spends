// Expiry notifications: documents with a `vence` date trigger an ntfy push 30 and 7 days before,
// on the day, and once after they expire. Each (document, date, stage) is sent once; the record
// lives in the `avisos` collection so restarts don't resend.
import { parsePath, type Store } from "./store.ts";

/** Days before expiry that start a stage. Stage 0 covers the day itself and anything past it. */
export const STAGES = [30, 7, 0] as const;
const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Due {
  docId: string;
  nombre: string;
  vence: string;
  daysLeft: number;
  stage: number;
  key: string; // id in the `avisos` collection
}

/** Local calendar date (honors TZ) as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days from `today` to `vence`, both YYYY-MM-DD (negative once expired). */
export function daysBetween(today: string, vence: string): number {
  return Math.round((Date.parse(vence + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY);
}

/** Documents whose current stage has not been notified yet. */
export function pendingAlerts(store: Store, today: string): Due[] {
  const out: Due[] = [];
  for (const { id, data } of store.listDocs("documentos")) {
    const vence = typeof data.vence === "string" ? data.vence : "";
    if (!ISO_DATE.test(vence) || Number.isNaN(Date.parse(vence))) continue;
    const daysLeft = daysBetween(today, vence);
    // Tightest stage reached: 0 (today or expired), 7, or 30. Beyond 30 days: nothing yet.
    const stage = [...STAGES].reverse().find(s => daysLeft <= s);
    if (stage === undefined) continue;
    const key = `${id}.${vence}.${stage}`;
    if (store.getDoc(`avisos/${key}`)) continue;
    const nombre = typeof data.nombre === "string" && data.nombre.trim() ? data.nombre.trim() : "Documento";
    out.push({ docId: id, nombre, vence, daysLeft, stage, key });
  }
  return out;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function messageFor(a: Due): { title: string; message: string; priority: number; tags: string[] } {
  if (a.daysLeft < 0) {
    const n = -a.daysLeft;
    return { title: `Vencido: ${a.nombre}`, message: `Venció el ${fmtDate(a.vence)} (hace ${n} día${n === 1 ? "" : "s"}).`, priority: 5, tags: ["rotating_light"] };
  }
  if (a.daysLeft === 0) return { title: `Vence hoy: ${a.nombre}`, message: `Vence hoy, ${fmtDate(a.vence)}.`, priority: 5, tags: ["warning"] };
  return {
    title: `Vence pronto: ${a.nombre}`,
    message: `Vence el ${fmtDate(a.vence)} (en ${a.daysLeft} día${a.daysLeft === 1 ? "" : "s"}).`,
    priority: a.stage <= 7 ? 4 : 3,
    tags: ["calendar"],
  };
}

export interface NtfyConfig {
  url: string; // server root, e.g. https://ntfy.sh
  topic: string;
  token?: string;
  click?: string; // opened when the notification is tapped
}

/** Reads NTFY_URL / NTFY_TOPIC / NTFY_TOKEN / NTFY_CLICK. Returns null (notifications off) without URL and topic. */
export function ntfyFromEnv(env: Record<string, string | undefined> = process.env): NtfyConfig | null {
  const url = env.NTFY_URL?.trim(), topic = env.NTFY_TOPIC?.trim();
  if (!url || !topic) return null;
  return { url: url.replace(/\/+$/, "") + "/", topic, token: env.NTFY_TOKEN?.trim() || undefined, click: env.NTFY_CLICK?.trim() || undefined };
}

/** Sends every pending alert; marks one as sent only after ntfy accepts it. Returns how many were sent. */
export async function runAvisos(store: Store, cfg: NtfyConfig, opts: { today?: string; fetch?: typeof fetch } = {}): Promise<number> {
  const send = opts.fetch ?? fetch;
  let sent = 0;
  for (const a of pendingAlerts(store, opts.today ?? localDate())) {
    const body = { topic: cfg.topic, ...messageFor(a), ...(cfg.click ? { click: cfg.click } : {}) };
    try {
      const r = await send(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!r.ok) { console.warn(`Aviso no enviado (${r.status}) para documentos/${a.docId}`); continue; }
      store.putDoc(parsePath(`avisos/${a.key}`, true)!, { documento: a.docId, vence: a.vence, etapa: a.stage, enviado: Date.now() });
      sent++;
    } catch (e) {
      console.warn(`Aviso no enviado para documentos/${a.docId}: ${(e as Error).message}`);
    }
  }
  return sent;
}

/** Runs now and then every `everyMs`. Returns a stop function. */
export function startAvisos(store: Store, cfg: NtfyConfig, everyMs = 6 * 3_600_000): () => void {
  const tick = () => runAvisos(store, cfg).then(n => { if (n) console.log(`Avisos enviados: ${n}`); }, () => {});
  tick();
  const t = setInterval(tick, everyMs);
  return () => clearInterval(t);
}
