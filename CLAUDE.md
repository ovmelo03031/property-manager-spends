# CLAUDE.md

Personal app to track expenses, receipts, and documents for apartment 2810 in The Gate Tower 1 (Al Reem Island, Abu Dhabi). Deployed with Docker on a homelab and accessed over Tailscale, with no login.

- **UI copy is Spanish.** Keep every user-facing string (HTML, `app.js`, server error messages) in Spanish. Code comments and docs may be in English.
- **Amounts are AED.**

## Commands

- `npm install` — install dependencies. Requires Node 22+; the Docker image runs Node 26. `better-sqlite3` 13 bundles prebuilt binaries, so no native toolchain is needed.
- `npm run dev` — backend via `tsx watch src/server.ts` at http://localhost:8080, data in `./data`.
- `npm test` — API tests with `node:test` (`node --import tsx --test test/*.test.ts`).
- `npm run typecheck` — `tsc` over `src/` and `test/` (no emit).
- `npm run build` / `npm start` — compile to `dist/` with `tsconfig.build.json`, then run `dist/server.js`.
- `docker compose up -d --build` — production build and start.
- `./scripts/backup.sh [dest]` — consistent backup of `data/` via the running container.

Run `npm run typecheck && npm test` after backend changes. The frontend has no tests: verify UI changes by running the app and exercising the affected tab.

## Architecture

- Backend: TypeScript (strict, ESM, `NodeNext` — relative imports use the `.js` extension) on Hono + `@hono/node-server` + better-sqlite3.
  - `src/server.ts` — entry point: env config (`PORT`, `DATA_DIR`, `SEED_DIR`), seed, `serve()`, graceful shutdown on SIGINT/SIGTERM.
  - `src/app.ts` — `createApp(store, { publicDir })` builds the Hono app; tests call `app.request()` directly, no port needed.
  - `src/store.ts` — `openStore(dataDir)`, `parsePath`, `deepMerge`, `seed`.
- The HTTP API is a path-based JSON document store, Firestore style:
  - Paths with an even number of segments are documents (`gastos/abc`, `config/apto`); odd is a collection (`gastos`). Segments match `^[A-Za-z0-9_\-.~:@+]{1,200}$`.
  - `GET /api/collection?path=`, `GET|PUT|PATCH|DELETE /api/doc?path=`. `PATCH` deep-merges and requires the document to exist (arrays are replaced, not merged).
  - `GET /api/events` — Server-Sent Events emitting `{path, collection}` on every document write.
  - `POST /api/assets` (raw binary body, `Content-Type` = file type, `X-Filename` URI-encoded), `DELETE /api/assets/:id`, `GET /_blob/:id`. Only PNG, JPEG, GIF, WebP, and PDF, max 20 MB. Asset IDs are 32 hex chars.
  - Seed: if the `docs` table is empty, loads `seed/seed.json` and `seed/blobs/` (format in `seed-example/README.md`).
  - Tables: `docs(path, collection, id, data JSON, updated_at)` and `assets(id, nombre, tipo, bytes, created_at)`.
  - Error shapes are part of the contract: `{error}` for document routes, `{code}` (`too_large`, `unsupported_type`, `invalid_request`) for files. Malformed JSON bodies return 500 `{error:"error interno"}`; a non-JSON `Content-Type` on PUT/PATCH is treated as `{}` (inherited from the original Express `express.json()` behavior).
- `public/claude-shim.js` — defines `window.claude.use(name)` exposing `db`, `assets`, `user`, `downloads`. The app started as a claude.ai artifact and uses that API; the shim implements it on top of the server (`onSnapshot` = fetch, then refetch on SSE events). **If you change the server API, update the shim.** `app.js` should only talk to the server through the shim.
- `public/app.js` — all UI logic in plain JS, no build and no framework.
- `public/styles.css` — color tokens on `:root` with dark variants (`prefers-color-scheme` and `[data-theme]`).
- `public/index.html` — static markup for all tabs and the side panels (expense form, document form, viewer).

## Data model

Field names are Spanish and are part of the stored format. Do not rename them without a migration.

- `gastos/<id>`: `concepto, fecha (YYYY-MM-DD), monto (AED), categoria, etapa (compra|remodelacion|recurrente), estado (pagado|pendiente), moneda, montoOrig, proveedor, metodo, notas, comprobantes[{id,nombre,tipo,bytes}], creado, actualizado`.
- `documentos/<id>`: `tipo, nombre, fecha, ref, notas, archivos[{id,nombre,tipo,bytes}], creado, actualizado`.
- `config/apto`: `precio, loan, area, scRate, share, banco, tasa, plazo, inicio`.
- `config/unidad`: unit sheet (tower, floor, area, parking, seller, agency…).
- Reference tables in `app.js`: categories in `STAGES`, MOU closing costs in `FEES`, recurring costs in `RECS`, document types in `DOC_TYPES`.
- Deleting an expense or document deletes its files client-side (best effort); the server does not cascade.

## Dependencies

- Keep dependencies on the latest version that is **at least 7 days old**. `.npmrc` sets `min-release-age=7`, so `npm install` / `npm update` refuse anything newer (`ETARGET … with a date before …`). Do not remove or lower it.
- To update: `npm outdated`, then `npm update` (or `npm install <pkg>@latest` for majors); npm picks the newest version outside the window. Run `npm run typecheck && npm test` afterwards.
- Urgent security fix only: bypass once with `npm install <pkg>@<version> --min-release-age=0` and say so in the commit message.
- Use `^` ranges in `package.json`; the lockfile pins exact versions and Docker builds with `npm ci`.
- The Docker base image is pinned by version and digest (`node:<version>-trixie-slim@sha256:…`) in both stages, so the 7-day rule applies to it too. To bump it: pick a Node release at least 7 days old, get the multi-arch digest from Docker Hub (`hub.docker.com/v2/repositories/library/node/tags/<tag>` → `digest`), and update both `FROM` lines together.

## Conventions

- No frontend dependencies and no frontend build step. Keep it that way unless truly needed. Only the backend is TypeScript.
- Any change to an API route needs a matching test in `test/api.test.ts` and, if the contract changes, an update to `public/claude-shim.js`.
- Escape all user text with `esc()` before putting it into `innerHTML`.
- Never commit `data/`, `seed/`, or `.env` (personal data). The repository must stay private.
- Security relies on the network (Tailscale + `BIND_ADDR`). Do not add features that assume public exposure, and do not weaken upload type or size checks.
- Server-side changes to stored data or document paths are breaking for existing `data/gastos.db`; plan a migration.
