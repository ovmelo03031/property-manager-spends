import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daysBetween, messageFor, ntfyFromEnv, pendingAlerts, runAvisos } from "../src/avisos.ts";
import { openStore, parsePath, type Store } from "../src/store.ts";

let tmp: string;
let store: Store;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avisos-test-"));
  store = openStore(tmp);
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const putDoc = (id: string, data: Record<string, unknown>) => store.putDoc(parsePath(`documentos/${id}`, true)!, data);
const cfg = { url: "https://ntfy.example/", topic: "apto" };
type Call = { url: string; init: RequestInit };
const fakeFetch = (status = 200) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status }); }) as unknown as typeof fetch;
  return { f, calls };
};

describe("pendingAlerts", () => {
  it("picks the tightest stage reached and ignores far, missing or invalid dates", () => {
    putDoc("far", { nombre: "Lejos", vence: "2027-03-01" });
    putDoc("d30", { nombre: "Seguro", vence: "2026-12-10" });
    putDoc("d7", { nombre: "Poder", vence: "2026-11-20" });
    putDoc("today", { nombre: "Hoy", vence: "2026-11-17" });
    putDoc("past", { nombre: "Viejo", vence: "2026-11-01" });
    putDoc("none", { nombre: "Sin fecha" });
    putDoc("bad", { nombre: "Malo", vence: "17/11/2026" });
    const got = Object.fromEntries(pendingAlerts(store, "2026-11-17").map(a => [a.docId, a.stage]));
    assert.deepEqual(got, { d30: 30, d7: 7, today: 0, past: 0 });
  });
});

describe("runAvisos", () => {
  it("posts JSON to the ntfy root with topic and token, then does not resend", async () => {
    putDoc("seg", { nombre: "Póliza de seguro", vence: "2026-11-24" });
    const { f, calls } = fakeFetch();
    assert.equal(await runAvisos(store, { ...cfg, token: "tk_x" }, { today: "2026-11-17", fetch: f }), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://ntfy.example/");
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer tk_x");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.topic, "apto");
    assert.equal(body.title, "Vence pronto: Póliza de seguro");
    assert.equal(body.message, "Vence el 24/11/2026 (en 7 días).");
    assert.ok(store.getDoc("avisos/seg.2026-11-24.7"));
    assert.equal(await runAvisos(store, cfg, { today: "2026-11-18", fetch: f }), 0);
    assert.equal(calls.length, 1);
  });

  it("sends again when the stage advances or the date changes", async () => {
    putDoc("seg", { nombre: "Seguro", vence: "2026-12-10" });
    const { f, calls } = fakeFetch();
    await runAvisos(store, cfg, { today: "2026-11-17", fetch: f }); // 30-day stage
    await runAvisos(store, cfg, { today: "2026-12-03", fetch: f }); // 7-day stage
    putDoc("seg", { nombre: "Seguro", vence: "2027-12-10" }); // renewed: nothing due
    await runAvisos(store, cfg, { today: "2026-12-04", fetch: f });
    assert.equal(calls.length, 2);
  });

  it("does not mark an alert as sent when ntfy rejects it or the network fails", async () => {
    putDoc("seg", { nombre: "Seguro", vence: "2026-11-17" });
    const { f } = fakeFetch(500);
    assert.equal(await runAvisos(store, cfg, { today: "2026-11-17", fetch: f }), 0);
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.equal(await runAvisos(store, cfg, { today: "2026-11-17", fetch: boom }), 0);
    assert.equal(pendingAlerts(store, "2026-11-17").length, 1);
  });
});

describe("messages and config", () => {
  it("words today, past and future dates in Spanish", () => {
    const base = { docId: "x", nombre: "Doc", vence: "2026-11-17", key: "k" };
    assert.equal(messageFor({ ...base, daysLeft: 0, stage: 0 }).title, "Vence hoy: Doc");
    assert.equal(messageFor({ ...base, daysLeft: -1, stage: 0 }).message, "Venció el 17/11/2026 (hace 1 día).");
    assert.equal(messageFor({ ...base, daysLeft: 30, stage: 30 }).priority, 3);
    assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  });

  it("is off unless both NTFY_URL and NTFY_TOPIC are set", () => {
    assert.equal(ntfyFromEnv({ NTFY_URL: "https://ntfy.sh" }), null);
    assert.equal(ntfyFromEnv({ NTFY_TOPIC: "t" }), null);
    assert.deepEqual(ntfyFromEnv({ NTFY_URL: "https://ntfy.sh//", NTFY_TOPIC: "t" }), { url: "https://ntfy.sh/", topic: "t", token: undefined, click: undefined });
  });
});
