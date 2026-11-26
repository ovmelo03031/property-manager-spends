# CLAUDE.md

Personal app to track expenses, receipts, and documents for apartment 2810 in The Gate Tower 1 (Al Reem Island, Abu Dhabi). Deployed with Docker on a homelab and accessed over Tailscale, behind a single-user login (password + TOTP).

- **UI copy is Spanish.** Keep every user-facing string (HTML, `app.js`, server error messages) in Spanish. Code comments and docs may be in English.
- **Amounts are AED.**

## Commands

Bun is the runtime, package manager, and test runner. Do not use npm, npx, or Node.

- `bun install` — install dependencies (Bun 1.4.4, see `packageManager`).
- `bun run dev` — `bun --watch src/server.ts` at http://localhost:8080, data in `./data`.
- `bun test` — API tests (`bun:test`).
- `bun run typecheck` — `tsc` over `src/` and `test/` (no emit; Bun runs the `.ts` sources directly, there is no build).
- `bun run start` — run the server without watch.
- `docker compose up -d --build` — production build and start.
- `./scripts/backup.sh [dest]` — consistent backup of `data/` (`VACUUM INTO`) via the running container.

Run `bun run typecheck && bun test` after backend changes. The frontend has no tests: verify UI changes by running the app and exercising the affected tab.

## Architecture

- Backend: TypeScript (strict, ESM, bundler resolution — relative imports use the `.ts` extension) on Hono + `Bun.serve` + `bun:sqlite`.
  - `src/server.ts` — entry point: env config (`PORT`, `DATA_DIR`, `SEED_DIR`), seed, `Bun.serve()` with `idleTimeout: 60` (Bun's 10 s default would drop SSE connections between 25 s pings), graceful shutdown on SIGINT/SIGTERM.
  - `src/app.ts` — `createApp(store, { publicDir })` builds the Hono app; tests call `app.request()` directly, no port needed. Static files use `serveStatic` from `@hono/bun`; blobs are served with `Bun.file` and `parseRange` (single `bytes=` ranges, 206/416).
  - `src/store.ts` — `openStore(dataDir)` (`bun:sqlite` in `strict` mode: named params bind without prefix), `parsePath`, `deepMerge`, `seed`.
  - `src/auth.ts` — `createAuth(store, { now })`: argon2id password (`Bun.password`), RFC 6238 TOTP (`node:crypto`, a step is accepted once), 8 hashed single-use backup codes, sessions (cookie token, DB keeps SHA-256; 30-day sliding, 90-day cap), persisted lockout (after 5 failures, 30 s doubling to 15 min). Login attempts are serialized.
  - Access control: `createApp(store, { publicDir, auth })`. With `auth`, one middleware runs before every route: rejects writes whose `Origin` differs (403 `{error:"origen no permitido"}`), lets through only the `PUBLIC` set in `src/app.ts` (login page files, `/api/login`, `/api/health`), and answers 401 `{error:"no autenticado"}` on `/api/*` and `/_blob/*` or redirects pages to `/login.html`. Without `auth` everything is open: only `test/api.test.ts` does that; `src/server.ts` always passes it. Cookie `sesion`: `HttpOnly; SameSite=Strict`, plus `Secure` when `createApp` gets `secureCookie` (`COOKIE_SECURE=1`, set by compose; unset for plain-HTTP dev).
  - HTTPS: compose runs Caddy (`Caddyfile`, `tls internal`, own root CA in git-ignored `caddy/`) on `BIND_ADDR` ports 8443 (HTTPS) and 8080 (redirect); the app container publishes no port. Host ports must equal Caddy's `http_port`/`https_port`. 80/443 are left to Pi-hole on the host. The Caddy image is pinned by version and digest (7-day rule).
  - `scripts/auth.ts` — `alta` (create or replace the user; ends every session), `desbloquear`, `cerrar-sesiones`. Runs against the live DB: `docker compose exec gastos bun scripts/auth.ts <cmd>`.
  - On macOS, Bun uses the system SQLite, which keeps an empty `gastos.db-wal`/`-shm` after close. That is expected; the data is checkpointed into `gastos.db`.
- The HTTP API is a path-based JSON document store, Firestore style:
  - Paths with an even number of segments are documents (`gastos/abc`, `config/apto`); odd is a collection (`gastos`). Segments match `^[A-Za-z0-9_\-.~:@+]{1,200}$`.
  - `GET /api/collection?path=`, `GET|PUT|PATCH|DELETE /api/doc?path=`. `PATCH` deep-merges and requires the document to exist (arrays are replaced, not merged).
  - `GET /api/events` — Server-Sent Events emitting `{path, collection}` on every document write.
  - `POST /api/assets` (raw binary body, `Content-Type` = file type, `X-Filename` URI-encoded), `DELETE /api/assets/:id`, `GET /_blob/:id`. Only PNG, JPEG, GIF, WebP, and PDF, max 20 MB. Asset IDs are 32 hex chars. Blobs are `Cache-Control: private, no-cache` with `ETag: "<id>"` (304 on match), so the browser cache never shows a file without a session.
  - `POST /api/login` `{password, codigo}` → 200 + cookie, 401 `{error:"credenciales inválidas"}`, 429 `{error:"demasiados intentos"}` + `Retry-After`. `GET /api/sesion` (200/401), `POST /api/logout`, `POST /api/logout-all`. Logout closes that session's SSE streams; each SSE ping also re-checks the session.
  - Seed: if the `docs` table is empty, loads `seed/seed.json` and `seed/blobs/` (format in `seed-example/README.md`).
  - Tables: `docs(path, collection, id, data JSON, updated_at)`, `assets(id, nombre, tipo, bytes, created_at)`, and, for auth, `usuarios` (single row, id 1) and `sesiones`. Auth tables stay outside `docs` so the document API can never read them.
  - Error shapes are part of the contract: `{error}` for document routes, `{code}` (`too_large`, `unsupported_type`, `invalid_request`) for files. Malformed JSON bodies return 500 `{error:"error interno"}`; a non-JSON `Content-Type` on PUT/PATCH is treated as `{}` (behavior kept from the original Express server).
- `public/claude-shim.js` — defines `window.claude.use(name)` exposing `db`, `assets`, `user`, `downloads`. The app started as a claude.ai artifact and uses that API; the shim implements it on top of the server (`onSnapshot` = fetch, then refetch on SSE events). **If you change the server API, update the shim.** `app.js` should only talk to the server through the shim.
- `public/app.js` — all UI logic in plain JS, no build and no framework.
- `public/styles.css` — color tokens on `:root` with dark variants (`prefers-color-scheme` and `[data-theme]`).
- `public/index.html` — static markup for all tabs and the side panels (expense form, document form, viewer).

## Data model

Field names are Spanish and are part of the stored format. Do not rename them without a migration.

- `gastos/<id>`: `concepto, fecha (YYYY-MM-DD), monto (AED), categoria, etapa (compra|remodelacion|recurrente), estado (pagado|pendiente), moneda, montoOrig, proveedor, metodo, notas, comprobantes[{id,nombre,tipo,bytes}], creado, actualizado`.
- `documentos/<id>`: `tipo, nombre, fecha, ref, vence (optional expiry, YYYY-MM-DD), notas, archivos[{id,nombre,tipo,bytes}], creado, actualizado`.
- `avisos/<docId>.<vence>.<stage>`: written by the server (`src/avisos.ts`) after an ntfy expiry notice is accepted, so each stage (30, 7, 0 days) is sent once. Off unless `NTFY_URL` and `NTFY_TOPIC` are set.
- `fotos/<id>` (one photo per document): `etapa (original|reforma), reforma (renovation name, groups photos), ambiente, fecha, nota, archivo{id,nombre,tipo,bytes}, creado, actualizado`. Rooms are in `AMBIENTES` in `app.js`.
- `config/apto`: `precio, loan, area, scRate, share, banco, tasa, plazo, inicio`.
- `config/unidad`: unit sheet (tower, floor, area, parking, seller, agency…).
- Reference tables in `app.js`: categories in `STAGES`, MOU closing costs in `FEES`, recurring costs in `RECS`, document types in `DOC_TYPES`, bills tracked month by month in `BILLS`.
- The Resumen and Recibos tabs store nothing: they are derived from `gastos`, `documentos` and `config/apto`. A bill month is "falta" only for closed months since that bill's first record (`cfg.inicio` for the mortgage); bills with `monthly:false` (service charge) are never flagged.
- Deleting an expense or document deletes its files client-side (best effort); the server does not cascade.

## Dependencies

- Keep dependencies on the latest version that is **at least 7 days old**. `bunfig.toml` sets `[install] minimumReleaseAge = 604800` (seconds), so `bun add` / `bun update` refuse anything newer (`blocked by minimum-release-age`). Do not remove or lower it.
- To update: `bun outdated`, then `bun update` (or `bun update --latest` for majors); Bun picks the newest version outside the window. Run `bun run typecheck && bun test` afterwards.
- Urgent security fix only: bypass once with `bun add <pkg>@<version> --minimum-release-age=0` and say so in the commit message.
- Use `^` ranges in `package.json`; `bun.lock` pins exact versions and Docker installs with `bun install --frozen-lockfile --production`.
- The Bun version itself follows the rule: keep `packageManager` in `package.json` and the Docker image on the same release, at least 7 days old (`gh release list -R oven-sh/bun`).
- The Docker base image is pinned by version and digest (`oven/bun:<version>-slim@sha256:…`), so the 7-day rule applies to it too. To bump it: get the multi-arch digest from Docker Hub (`hub.docker.com/v2/repositories/oven/bun/tags/<tag>` → `digest`) and update the `FROM` line and `packageManager` together.

## Conventions

- No frontend dependencies and no frontend build step. Keep it that way unless truly needed. Only the backend is TypeScript.
- Any change to an API route needs a matching test in `test/api.test.ts` (or `test/auth.test.ts` for login and access control) and, if the contract changes, an update to `public/claude-shim.js`. A new route is protected by default; add it to `PUBLIC` only if it must work before signing in.
- `public/login.js` talks to the server directly (the shim loads only after signing in); everything else in `app.js` goes through the shim, which sends any 401 to `/login.html`.
- Escape all user text with `esc()` before putting it into `innerHTML`.
- Never commit `data/`, `seed/`, or `.env` (personal data). The repository is public, so never put personal data in code, docs, tests, or commits.
- `main` is protected by the `protect-main` ruleset: only the owner (admin bypass) can push or merge. Collaborators work on branches and open PRs.
- `main` can never be deleted: the `main-never-delete` ruleset blocks deletion with no bypass, not even for admins. Do not remove or weaken it.
- Security has two layers: the network (Tailscale + `BIND_ADDR`, which compose now requires) and the login. The login is not permission to expose the app: do not add features that assume public exposure, and do not weaken upload type or size checks, the `Origin` check, the lockout, or the cookie flags.
- No passkeys/WebAuthn for now. HTTPS now comes from Caddy's internal CA, which makes them possible later. Never switch to Tailscale HTTPS or a public CA: they publish machine names in public CT logs.
- Server-side changes to stored data or document paths are breaking for existing `data/gastos.db`; plan a migration.
