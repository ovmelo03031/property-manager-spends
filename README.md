# Gastos Gate Towers

Personal expense, receipt, and document tracker for **apartment 2810 · The Gate Tower 1 · Al Reem Island, Abu Dhabi**.
It runs in Docker on a homelab server and is used from a phone or laptop over Tailscale. There is no login: access control is the tailnet.

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

Open it from any device on your tailnet:

```
http://<server-name>:8080     # with MagicDNS
http://100.x.y.z:8080         # with the Tailscale IP
```

On a phone, use "Add to Home Screen" to open it as an app.

### HTTPS (optional)

With Tailscale on the host you can serve the app with a valid certificate inside your tailnet:

```bash
tailscale serve --bg 8080
```

The app is then available at `https://<server>.<your-tailnet>.ts.net`. In this setup, set `BIND_ADDR=127.0.0.1` in `.env`, since Tailscale forwards traffic from localhost.

## Configuration

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `BIND_ADDR` | `.env` (compose) | `0.0.0.0` | Host interface the port binds to. Set it to the Tailscale IP or `127.0.0.1`. |
| `HOST_PORT` | `.env` (compose) | `8080` | Host port. |
| `PORT` | container | `8080` | Port the server listens on. |
| `DATA_DIR` | container | `./data` (`/data` in Docker) | SQLite database and uploaded files. |
| `SEED_DIR` | container | `./seed` (`/app/seed` in Docker) | Initial data, loaded only into an empty database. |

> The compose default `0.0.0.0` exposes the app to your whole LAN. Always set `BIND_ADDR`.

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

The app has **no authentication**. Its only protection is that it answers inside your tailnet:

- Set `BIND_ADDR` to the Tailscale IP (or `127.0.0.1` with `tailscale serve`). Never expose it through port forwarding or a public tunnel.
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
src/app.ts              Hono routes: JSON documents, files, SSE, static files
src/store.ts            SQLite document store, path parsing, seed loader
test/api.test.ts        API contract tests
public/index.html       Page markup
public/styles.css       Styles (light and dark themes)
public/app.js           UI logic (plain JS, no build step)
public/claude-shim.js   Data layer: window.claude API on top of the server
public/manifest.webmanifest, icon.svg   PWA metadata
seed-example/           Format of the (git-ignored) seed/ folder
scripts/backup.sh       Backup of data/
```

## API overview

The server is a small path-based JSON document store, Firestore style. A path with an even number of segments is a document (`gastos/abc`, `config/apto`); an odd number is a collection (`gastos`).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
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
