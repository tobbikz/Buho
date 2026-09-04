# buho-check (CLI gratis / lead gen)

Informe de salud **read-only** de una instancia PostgreSQL. Reutiliza el mismo
catálogo de checks que el colector — sin store, sin Docker, sin agente.

## Uso

```bash
# desde el monorepo
npm install
npm run check -- 'postgres://usuario:clave@127.0.0.1:5432/mibase'

# o variables libpq
PGHOST=… PGDATABASE=… PGUSER=… PGPASSWORD=… npm run check
```

## Códigos de salida

| Código | Significado |
|--------|-------------|
| 0 | Sin hallazgos |
| 1 | Solo avisos / info |
| 2 | Al menos un crítico |
| 3 | Error de conexión o ejecución |

## Por qué es lead gen

Un DBA puede pegarlo en cron o CI **hoy**, sin comprar Búho. Cuando quiera
historial, alertas y flota multi-motor, el camino es `./install.sh --pull`.

Licencia del producto: ver `LICENSE` (BSL 1.1). El uso de `buho-check` para
evaluación y CI está cubierto por el Additional Use Grant.
