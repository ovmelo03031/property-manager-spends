# Gastos Gate Towers

Registro de gastos, comprobantes y documentos del apartamento **2810 · The Gate Tower 1 · Al Reem Island**.
Corre en Docker dentro del homelab y se usa desde el teléfono o el PC a través de Tailscale.

- **Movimientos:** gastos de compra, remodelación y recurrentes, con fotos o PDF de cada comprobante.
- **Vivienda y crédito:** precio, lo pagado al vendedor, hipoteca (cuota, capital, intereses, saldo) y costo total.
- **Costos de compra:** costos de cierre según el MOU (transfer fee ADGM, comisión, NOC de Aldar…) y recurrentes (service charge, Tasleem).
- **Documentos:** título, plano, MOU, NOC, POA y demás papeles de la unidad.
- **Exportar a Excel (CSV)** desde el botón superior.

## Requisitos

- Docker con Docker Compose en el servidor del homelab.
- Tailscale instalado en el servidor y en los dispositivos desde los que vas a entrar.

## Instalación

```bash
git clone <tu-repo-privado> gastos-gate-towers
cd gastos-gate-towers

# 1. Que solo se vea dentro de tu tailnet
cp .env.example .env
tailscale ip -4            # copia esa IP en BIND_ADDR dentro de .env

# 2. (Opcional) datos iniciales: copia la carpeta seed/ que no está en git
#    seed/seed.json + seed/blobs/<id>   → se cargan solo si la base está vacía

# 3. Arrancar
docker compose up -d --build
docker compose logs -f     # debe decir "Seed cargado..." la primera vez
```

Entra desde cualquier dispositivo de tu tailnet:

```
http://<nombre-del-servidor>:8080     # con MagicDNS
http://100.x.y.z:8080                 # con la IP de Tailscale
```

En el teléfono, usa "Agregar a pantalla de inicio" para abrirla como app.

### HTTPS (opcional)

Con Tailscale en el host puedes publicar la app con certificado válido en tu tailnet:

```bash
tailscale serve --bg 8080
# → https://<servidor>.<tu-tailnet>.ts.net
```

Con `tailscale serve`, puedes dejar `BIND_ADDR=127.0.0.1` en `.env`, porque Tailscale toma el tráfico desde localhost.

## Datos y respaldos

Todo vive en `./data`:

| Ruta | Contenido |
|---|---|
| `data/gastos.db` | Base de datos SQLite (gastos, documentos, configuración) |
| `data/blobs/` | Comprobantes y PDFs subidos |

Respaldo:

```bash
./scripts/backup.sh /ruta/a/tu/nas    # crea gastos-AAAAMMDD-HHMMSS.tar.gz
```

Para restaurar, detén el contenedor, extrae el `.tar.gz` en `data/` (renombra `gastos-backup.db` a `gastos.db`) y vuelve a arrancarlo.

## Seguridad

La app **no tiene login**: la protección es que solo responde dentro de tu tailnet. Por eso:

- Pon `BIND_ADDR` con la IP de Tailscale (o `127.0.0.1` si usas `tailscale serve`). No la publiques con port-forwarding ni con un túnel público.
- Mantén el repositorio **privado**. `data/`, `seed/` y `.env` están en `.gitignore` porque tienen datos personales (MOU con nombres y Emirates ID, comprobantes).
- Si quieres limitar quién de tu tailnet entra, usa las ACL de Tailscale.

## Desarrollo local

```bash
npm install
npm run dev        # http://localhost:8080, datos en ./data
```

## Estructura

```
server.js               API (Express + SQLite) y archivos
public/index.html       Estructura de la página
public/styles.css       Estilos (tema claro y oscuro)
public/app.js           Lógica de la app
public/claude-shim.js   Capa de datos: conecta app.js con la API
seed/                   Datos iniciales (fuera de git)
scripts/backup.sh       Respaldo de data/
```

Los montos son en AED. Los estimados de costos de cierre e hipoteca son orientativos; las cifras reales las dan el MOU, el banco y el estado de cuenta del conveyancer.
