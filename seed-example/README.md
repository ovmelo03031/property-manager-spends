Formato de `seed/seed.json` (la carpeta `seed/` no se sube a git porque tiene datos personales):

```json
{
  "docs":   { "gastos/<id>": { ... }, "config/apto": { ... } },
  "assets": { "<id de 32 hex>": { "nombre": "archivo.pdf", "tipo": "application/pdf" } }
}
```

Cada archivo va en `seed/blobs/<id>`. Solo se carga cuando la base de datos está vacía.
