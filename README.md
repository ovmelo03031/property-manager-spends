# Property Manager Spends

Personal expense, receipt, and document tracker for **apartment 2810 · The Gate Tower 1 · Al Reem Island, Abu Dhabi**.
It runs in Docker on a homelab server and is used from a phone or laptop over Tailscale. On top of the tailnet, every device signs in with a password and a TOTP code.

The user interface is in **Spanish** and all amounts are in **AED**.

## Features

- **Resumen (summary):** key figures, a to-do list (missing bills and receipts, pending expenses, missing key documents), upcoming payments, spend by stage, and the latest expenses.
- **Movimientos (transactions):** purchase, renovation, and recurring expenses grouped by month, each with photo or PDF receipts.
- **Recibos (bills):** utility, cooling, internet, service charge, and mortgage bills month by month, showing which months are missing or lack a receipt.
- **Vivienda y crédito (property and mortgage):** purchase price, amount paid to the seller, mortgage installment, principal, interest, estimated balance, and total cost of ownership.
- **Costos de compra (closing costs):** closing costs from the MOU (ADGM transfer fee, agency commission, Aldar NOC…) and recurring references (service charge, Tasleem cooling).
- **Documentos (documents):** title deed, floor plan, MOU, NOC, POA, and other unit paperwork.
- **Fotos (photos):** the apartment as received and each renovation, by room.
- **CSV export** (opens in Excel) from the header button, or from "Más" on a phone.
- On phones, a bottom bar with a new-expense button replaces the tabs.
- Live updates across open devices via Server-Sent Events.
- Installable as a home-screen app (PWA manifest), light and dark themes.

## Requirements

- Docker with Docker Compose on the homelab server.
- Tailscale on the server and on every device that will use the app.
- For local development only: Bun 1.4.4 or newer.

## Installation

```bash
git clone https://github.com/ovmelo03031/property-manager-spends.git gastos-gate-towers
cd gastos-gate-towers
```

Restrict the app to your tailnet. Copy the example env file and set `BIND_ADDR` to the server's Tailscale IP:

```bash
cp .env.example .env
```

```bash
tailscale ip -4
```

Optionally, add initial data: place `seed/seed.json` and `seed/blobs/<id>` (not in git; see [seed-example/README.md](seed-example/README.md)). The seed is loaded only when the database is empty.

Start the container:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

On first start with a seed, the log shows `Seed cargado: …`.

Create the login. Until you do, nobody can get in (the log shows `Sin usuario: nadie puede entrar…`):

```bash
docker compose exec gastos bun scripts/auth.ts alta
```

It asks for a password (at least 12 characters) and prints, once, a TOTP secret and 8 backup codes. Add the secret to an authenticator app (manual key, time-based) and keep the backup codes somewhere other than this server.

Trust Caddy's root certificate on each device once (see [HTTPS](#https) below), then open the app from any device on your tailnet and sign in with the password and the 6-digit code:

```
https://100.x.y.z:8443        # with the Tailscale IP
https://<server-name>:8443    # with MagicDNS, if listed in SITE_ADDRESSES
```

`http://…:8080` redirects to HTTPS, so old links keep working.

On a phone, use "Add to Home Screen" to open it as an app.

Each browser (and the home-screen app) signs in once and keeps its own session: 30 days, renewed while you use it, up to 90 days. "Cerrar sesión" ends the current one; "Cerrar todas las sesiones" ends them on every device.

### Login administration

```bash
docker compose exec gastos bun scripts/auth.ts alta
```

Creates the user, or replaces the password, TOTP secret, and backup codes (it ends every session). Use it if you lose the authenticator app and the backup codes.

```bash
docker compose exec gastos bun scripts/auth.ts desbloquear
```

After 5 failed attempts the login waits 30 seconds, doubling on each further failure up to 15 minutes. This clears the wait.

```bash
docker compose exec gastos bun scripts/auth.ts cerrar-sesiones
```

Ends every session, for example after losing a device. Open tabs return to the login within 30 seconds.

### HTTPS

Compose runs [Caddy](https://caddyserver.com) in front of the app with its own certificate authority (`tls internal`). Nothing is requested from a public CA, so no name ends up in a Certificate Transparency log. The app container publishes no port: only Caddy is reachable, on `BIND_ADDR` port 8443 (HTTPS) and 8080 (redirect to HTTPS). Ports 80 and 443 are left alone because other services on the host (Pi-hole) may use them.

By default the certificate covers only the Tailscale IP. To also use names, set `SITE_ADDRESSES` in `.env` (comma-separated, every address devices will type):

```
SITE_ADDRESSES=100.x.y.z, my-server, my-server.my-tailnet.ts.net
```

Caddy creates its root certificate on first start. The folder is readable only by root, so take the certificate out through the container, on the server:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt gastos-ca.crt
```

Then copy `gastos-ca.crt` to your computer. Copy only `root.crt`, never `root.key`.

Trust it once on each device:

- **iPhone/iPad:** send `gastos-ca.crt` to the device (AirDrop or Files) and open it. Install the profile in Settings → General → VPN & Device Management, then turn it on in Settings → General → About → Certificate Trust Settings.
- **Android:** Settings → Security (or Security & privacy → More security settings) → Encryption & credentials → Install a certificate → CA certificate. The path varies by vendor.
- **macOS:** open it in Keychain Access, add it to the System keychain, and set "When using this certificate" to "Always Trust".
- **Windows:** open it → Install Certificate → Local Machine → Trusted Root Certification Authorities.
- **Firefox** (any OS where it does not use the system store, e.g. Linux): Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.

The root lasts 10 years; Caddy renews the server certificates on its own. `caddy/` holds the root's private key: anyone with it can impersonate the app to your devices. It is git-ignored; keep it out of shared places. If you delete it, Caddy makes a new root and every device must trust it again.

> Why not `tailscale serve`? Tailscale HTTPS publishes the machine name and the tailnet DNS name in a public Certificate Transparency ledger, and its certificates cannot be revoked ([Tailscale docs](https://tailscale.com/kb/1153/enabling-https)).

## Configuration

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `BIND_ADDR` | `.env` (compose) | required | Host interface Caddy binds to (ports 8443 and 8080): the server's Tailscale IP. Compose refuses to start without it. |
| `SITE_ADDRESSES` | `.env` (compose) | `BIND_ADDR` | Comma-separated names and IPs the HTTPS certificate covers. |
| `PORT` | container | `8080` | Port the server listens on. |
| `COOKIE_SECURE` | container | — | `1` adds `Secure` to the session cookie. Compose sets it, since the app is only reached through Caddy. Leave it unset for plain-HTTP local development. |
| `DATA_DIR` | container | `./data` (`/data` in Docker) | SQLite database and uploaded files. |
| `SEED_DIR` | container | `./seed` (`/app/seed` in Docker) | Initial data, loaded only into an empty database. |
| `NTFY_URL` | `.env` (compose) | — | Root of your own ntfy server on the tailnet (e.g. `http://raspberrypi:8090`). With `NTFY_TOPIC`, turns on expiry notifications. Never point it at a public server such as ntfy.sh: nothing may leave your network. |
| `NTFY_TOPIC` | `.env` (compose) | — | ntfy topic to publish to on that server. |
| `NTFY_TOKEN` | `.env` (compose) | — | Optional access token for a protected topic. |
| `NTFY_CLICK` | `.env` (compose) | — | Optional URL opened when you tap a notification (e.g. the app's tailnet address). |

Expiry notifications: documents with a "Vence" date send a push 30 and 7 days before, on the day, and once after they expire. Each step is sent once (recorded in the `avisos` collection) and the server checks every 6 hours. The notification carries the document's name and date, so it must go to a self-hosted ntfy reachable only over Tailscale.

## Data and backups

Everything lives in `./data`:

| Path | Contents |
|---|---|
| `data/gastos.db` | SQLite database (expenses, documents, configuration) |
| `data/blobs/` | Uploaded receipts and PDFs |

Create a backup (produces `gastos-YYYYMMDD-HHMMSS.tar.gz`; defaults to `./backups`):

```bash
./scripts/backup.sh /path/to/your/nas
```

The script takes a consistent SQLite snapshot (`VACUUM INTO`) through the running container, so it is safe while the app is up.

To restore: stop the container, extract the archive into `data/`, rename `gastos-backup.db` to `gastos.db`, and start the container again.

## Security

Two layers protect the app: it answers only inside your tailnet, and every route needs a session.

- **Login:** one user, password hashed with argon2id plus a TOTP code (or a single-use backup code). A TOTP code works once.
- **Sessions:** a random token in an `HttpOnly`, `SameSite=Strict` cookie; the database stores only its SHA-256. In Docker the cookie is also `Secure`, since the app is served only over HTTPS.
- **HTTPS:** Caddy with its own certificate authority, so traffic is encrypted end to end on top of WireGuard and no name is published anywhere.
- **Other checks:** writes from another origin are rejected, failed logins lock the form for a growing wait, and files are revalidated on every view so the browser cache never shows them without a session.
- The login is an extra layer, not permission to expose the app. Set `BIND_ADDR` to the Tailscale IP. Never expose it through port forwarding or a public tunnel.
- `data/` and backups are **not encrypted**. They hold the data, the password hash, and the TOTP secret, so anyone with a copy needs only the password. Keep backups somewhere private.
- The repository is **public**. `data/`, `seed/`, and `.env` are git-ignored because they contain personal data (MOU with names and Emirates ID, receipts); never commit them.
- Use Tailscale ACLs to limit which tailnet devices can reach it.
- Uploads are limited to PNG, JPEG, GIF, WebP, and PDF, up to 20 MB each.

## Local development

The project uses [Bun](https://bun.sh) as runtime, package manager, and test runner. Bun runs the TypeScript sources directly, so there is no build step.

```bash
bun install
```

```bash
bun run dev
```

The app runs at http://localhost:8080 with data in `./data`. `bun run dev` restarts the server on changes under `src/`; frontend files are served as-is, so just reload the page.

| Script | Purpose |
|---|---|
| `bun run dev` | Server in watch mode |
| `bun test` | API tests (`bun:test`, in-process via `app.request`) |
| `bun run typecheck` | Type-check `src/` and `test/` with `tsc` |
| `bun run start` | Run the server without watch |

### Updating dependencies

The project enforces a 7-day supply-chain cooldown: `bunfig.toml` sets `minimumReleaseAge = 604800` (seconds), so Bun only installs versions published more than a week ago. Most malicious npm releases are detected and pulled within hours or days, so this window avoids them while staying close to the latest releases.

```bash
bun outdated
```

```bash
bun update
```

For an urgent security fix, bypass the window once: `bun add <pkg>@<version> --minimum-release-age=0`.

The Docker base image follows the same rule: it is pinned by version and digest (`oven/bun:1.4.4-slim@sha256:…`), so rebuilds are reproducible and never pull an image published minutes ago. When a newer Bun release is at least 7 days old, bump the `FROM` line and `packageManager` in `package.json` together.

## Project structure

```
src/server.ts           Entry point: config, seed, HTTP server, graceful shutdown
src/app.ts              Hono routes: access control, JSON documents, files, SSE, static files
src/auth.ts             Login: password, TOTP, backup codes, sessions, lockout
src/store.ts            SQLite document store, path parsing, seed loader
test/api.test.ts        API contract tests
test/auth.test.ts       Login and session tests
public/index.html       Page markup
public/login.html, login.js   Login page
public/styles.css       Styles (light and dark themes)
public/app.js           UI logic (plain JS, no build step)
public/claude-shim.js   Data layer: window.claude API on top of the server
public/manifest.webmanifest, icon.svg   PWA metadata
seed-example/           Format of the (git-ignored) seed/ folder
scripts/backup.sh       Backup of data/
scripts/auth.ts         Login administration: alta, desbloquear, cerrar-sesiones
Caddyfile               HTTPS reverse proxy with Caddy's internal CA
```

## API overview

The server is a small path-based JSON document store, Firestore style. A path with an even number of segments is a document (`gastos/abc`, `config/apto`); an odd number is a collection (`gastos`).

Every route except `/api/health`, `/api/login`, and the login page's files needs the session cookie. Without it, `/api/*` and `/_blob/*` answer 401 `{error:"no autenticado"}` and pages redirect to `/login.html`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (public) |
| `POST` | `/api/login` | Sign in with `{password, codigo}` (public). 401 on bad credentials, 429 with `Retry-After` while locked |
| `GET` | `/api/sesion` | 200 with a valid session, 401 otherwise |
| `POST` | `/api/logout` | End the current session |
| `POST` | `/api/logout-all` | End every session |
| `GET` | `/api/collection?path=` | List documents in a collection |
| `GET` | `/api/doc?path=` | Read one document |
| `PUT` | `/api/doc?path=` | Create or replace a document |
| `PATCH` | `/api/doc?path=` | Deep-merge into an existing document |
| `DELETE` | `/api/doc?path=` | Delete a document |
| `GET` | `/api/events` | Server-Sent Events: `{path, collection}` on every write |
| `POST` | `/api/assets` | Upload a file (raw body, `Content-Type`, `X-Filename`) |
| `DELETE` | `/api/assets/:id` | Delete a file |
| `GET` | `/_blob/:id` | Download a file |

## Disclaimer

Closing-cost and mortgage figures are estimates. The real numbers come from the MOU, the bank, and the conveyancer's statement. This is not legal or financial advice.
