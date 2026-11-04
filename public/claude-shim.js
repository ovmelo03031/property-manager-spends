// Reemplaza el runtime de artifacts de claude.ai con el servidor local.
// Expone window.claude.use("db" | "assets" | "user" | "downloads") con la misma forma
// que usaba la página, para que app.js no cambie.
(() => {
  const listeners = new Set(); // {key, refetch}
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw { code: r.status === 400 ? "invalid_argument" : "unavailable", message: e.error || r.statusText }; }
    return r.json();
  };
  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (id, exists, data) => { const d = exists ? Object.freeze(data) : undefined; return { id, exists, data: () => d, metadata: meta }; };
  const enc = encodeURIComponent;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);

  function notify(path, collection) {
    for (const l of listeners) if (l.key === path || l.key === collection) l.refetch();
  }
  let es;
  function connect() {
    es = new EventSource("/api/events");
    es.onmessage = e => { try { const m = JSON.parse(e.data); notify(m.path, m.collection); } catch {} };
    es.onerror = () => { es.close(); setTimeout(() => { connect(); for (const l of listeners) l.refetch(); }, 3000); };
  }
  connect();

  function subscribe(key, fetcher, next, error) {
    let alive = true, busy = false, again = false;
    const refetch = async () => {
      if (!alive) return; if (busy) { again = true; return; }
      busy = true;
      try { const s = await fetcher(); if (alive) next(s); }
      catch (e) { if (alive && error && e?.code === "invalid_argument") { alive = false; error(e); } }
      busy = false; if (again) { again = false; refetch(); }
    };
    const l = { key, refetch }; listeners.add(l); refetch();
    return () => { alive = false; listeners.delete(l); };
  }

  function docRef(path) {
    const segs = path.split("/");
    if (segs.length % 2) throw new TypeError("La ruta de un documento necesita un número par de segmentos: " + path);
    const id = segs[segs.length - 1], col = segs.slice(0, -1).join("/");
    const get = async () => { const r = await api("GET", "/api/doc?path=" + enc(path)); return snapDoc(r.id, r.exists, r.data); };
    return {
      id, path,
      get,
      set: async data => { await api("PUT", "/api/doc?path=" + enc(path), data); notify(path, col); },
      update: async data => { await api("PATCH", "/api/doc?path=" + enc(path), data); notify(path, col); },
      delete: async () => { await api("DELETE", "/api/doc?path=" + enc(path)); notify(path, col); },
      onSnapshot: (next, error) => subscribe(path, get, next, error),
      collection: sub => colRef(path + "/" + sub),
    };
  }
  function colRef(path) {
    if (!(path.split("/").length % 2)) throw new TypeError("La ruta de una colección necesita un número impar de segmentos: " + path);
    const get = async () => {
      const rows = await api("GET", "/api/collection?path=" + enc(path));
      const docs = rows.map(r => snapDoc(r.id, true, r.data));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: meta };
    };
    return {
      path,
      doc: id => docRef(path + "/" + (id || newId())),
      add: async data => { const r = docRef(path + "/" + newId()); await r.set(data); return r; },
      get,
      onSnapshot: (next, error) => subscribe(path, get, next, error),
    };
  }
  const dbNs = Object.freeze({ doc: docRef, collection: colRef });

  const assetsNs = Object.freeze({
    async upload(blob, opts = {}) {
      const r = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": opts.type || blob.type, "X-Filename": encodeURIComponent(blob.name || "archivo") }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw { code: j.code || (r.status === 413 ? "too_large" : "upstream_error"), message: r.statusText };
      return j;
    },
    async delete(ref) { const id = String(ref).replace(/^.*\//, ""); return api("DELETE", "/api/assets/" + enc(id)); },
    async list() { return { assets: [], usage: {} }; },
  });

  const userNs = Object.freeze({
    isOwner: () => true, canEdit: () => true, can: () => true,
    id: async () => "local", me: async () => ({ id: "local", name: "" }), profiles: async () => ({}),
  });

  const downloadsNs = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return { status: "saved" };
    },
  });

  const NS = { db: dbNs, assets: assetsNs, user: userNs, downloads: downloadsNs };
  window.claude = Object.freeze({ use: async name => NS[name] ?? null });
})();
