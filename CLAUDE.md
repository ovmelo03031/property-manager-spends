# CLAUDE.md

App personal para llevar los gastos, comprobantes y documentos del apartamento 2810 en The Gate Tower 1 (Al Reem Island, Abu Dhabi). Interfaz y textos en **español**; montos en **AED**. Se despliega con Docker en un homelab y se accede por Tailscale (sin login).

## Arquitectura

- `server.js` — Express + better-sqlite3. Almacén de documentos JSON por ruta, estilo Firestore:
  - Rutas con número par de segmentos = documento (`gastos/abc`, `config/apto`); impar = colección (`gastos`).
  - `GET /api/collection?path=`, `GET|PUT|PATCH|DELETE /api/doc?path=` (PATCH hace merge profundo y exige que exista).
  - `GET /api/events` — Server-Sent Events con `{path, collection}` en cada escritura.
  - `POST /api/assets` (cuerpo binario, `Content-Type` = tipo del archivo, `X-Filename`), `DELETE /api/assets/:id`, `GET /_blob/:id`. Solo PNG, JPEG, GIF, WebP y PDF, máx. 20 MB.
  - Seed: si la tabla `docs` está vacía, carga `seed/seed.json` y `seed/blobs/`.
- `public/claude-shim.js` — define `window.claude.use(name)` con `db`, `assets`, `user`, `downloads`. La app nació como artifact de claude.ai y usa esa API; el shim la implementa sobre el servidor (onSnapshot = fetch + refetch con SSE). Si cambias la API del servidor, actualiza el shim.
- `public/app.js` — toda la lógica de UI en JS plano, sin build ni framework.
- `public/styles.css` — tokens de color en `:root` con variantes oscuras (`prefers-color-scheme` y `[data-theme]`).

## Modelo de datos

- `gastos/<id>`: `concepto, fecha (YYYY-MM-DD), monto (AED), categoria, etapa (compra|remodelacion|recurrente), estado (pagado|pendiente), moneda, montoOrig, proveedor, metodo, notas, comprobantes[{id,nombre,tipo,bytes}], creado, actualizado`.
- `documentos/<id>`: `tipo, nombre, fecha, ref, notas, archivos[{id,nombre,tipo,bytes}], creado, actualizado`.
- `config/apto`: `precio, loan, area, scRate, share, banco, tasa, plazo, inicio`.
- `config/unidad`: ficha de la unidad (torre, piso, área, parqueadero, vendedor, agencia…).
- Las categorías están en `STAGES` (app.js); los costos de cierre del MOU en `FEES`; los recurrentes en `RECS`; los tipos de documento en `DOC_TYPES`.

## Convenciones

- Sin dependencias de frontend ni paso de build; mantenerlo así salvo que haga falta de verdad.
- Escapa todo texto de usuario con `esc()` antes de meterlo en `innerHTML`.
- Nunca subir `data/`, `seed/` ni `.env` (datos personales). El repo debe ser privado.
- Probar: `npm run dev`, abrir http://localhost:8080.
