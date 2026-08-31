#!/usr/bin/env bash
#
# Ensayo de instalación desde cero, como lo haría alguien que nunca vio esto.
#
# Es la prueba que faltaba: `install.sh` y `INSTALL.md` existían, pero nadie
# ajeno los había seguido nunca. Aquí se hace en una copia limpia del proyecto,
# con secretos nuevos, un servidor de PostgreSQL recién creado para monitorear y
# puertos distintos a los del entorno de desarrollo, para que el ensayo no toque
# ni vea los datos reales.
#
# Lo que comprueba, en orden:
#
#   1. Sin `config.json`, el instalador se detiene y explica qué editar.
#   2. Con `config.json` puesto, levanta store, colector y consola.
#   3. El colector escribe muestras de verdad contra un servidor externo.
#   4. La consola responde y deja entrar con la contraseña de arranque.
#   5. Correrlo por segunda vez no rompe nada ni regenera los secretos.
#
# Uso:
#   ./scripts/ensayo-instalacion.sh            ensaya y limpia al terminar
#   ./scripts/ensayo-instalacion.sh --dejar    deja todo arriba para mirarlo
set -euo pipefail

DEJAR=0
[[ "${1:-}" == '--dejar' ]] && DEJAR=1

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ENSAYO="${TMPDIR:-/tmp}/buho-ensayo-$$"
RED='buho-ensayo-red'
OBJETIVO='buho-ensayo-objetivo'
PUERTO_WEB=3200
PUERTO_STORE=55433

VERDE=$'\033[32m'; ROJO=$'\033[31m'; NEGRITA=$'\033[1m'; FIN=$'\033[0m'
paso() { printf '\n%s==>%s %s\n' "$NEGRITA" "$FIN" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$VERDE" "$FIN" "$1"; }
mal()  { printf '  %s✗%s %s\n' "$ROJO" "$FIN" "$1"; FALLOS=$((FALLOS + 1)); }
FALLOS=0

limpiar() {
  [[ "$DEJAR" -eq 1 ]] && { printf '\nSe deja todo arriba en %s (consola en http://127.0.0.1:%s)\n' "$ENSAYO" "$PUERTO_WEB"; return; }
  paso 'Limpiando'
  if [[ -d "$ENSAYO" ]]; then
    (cd "$ENSAYO" && BUHO_WEB_PORT=$PUERTO_WEB BUHO_STORE_PORT=$PUERTO_STORE docker compose down -v >/dev/null 2>&1) || true
    # Los respaldos los escribe el contenedor como root en un volumen montado,
    # así que el usuario no puede borrarlos desde fuera. Se borran desde dentro
    # de un contenedor, que sí es root ahí.
    docker run --rm -v "$ENSAYO:/ensayo" alpine:3 sh -c 'rm -rf /ensayo/respaldos' >/dev/null 2>&1 || true
    rm -rf "$ENSAYO"
  fi
  docker rm -f "$OBJETIVO" >/dev/null 2>&1 || true
  docker network rm "$RED" >/dev/null 2>&1 || true
  ok 'ensayo borrado'
}
trap limpiar EXIT

# ----------------------------------------------------------------- copia limpia
paso 'Copia limpia del proyecto'
mkdir -p "$ENSAYO"
# Se excluye todo lo que un cliente no recibiría: dependencias, artefactos de
# compilación, y sobre todo el .env y el config.json de desarrollo. Si el ensayo
# heredara esos dos, no estaría probando la instalación sino la actualización.
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude 'config.json' \
  --exclude 'respaldos' \
  "$RAIZ/" "$ENSAYO/"
ok "copiado en $ENSAYO"
[[ -f "$ENSAYO/.env" ]] && mal 'el .env de desarrollo se colό en la copia'
[[ -f "$ENSAYO/config.json" ]] && mal 'el config.json de desarrollo se colό en la copia'

# ------------------------------------------------------- servidor a monitorear
paso 'Servidor de PostgreSQL para monitorear'
docker network create "$RED" >/dev/null 2>&1 || true
docker rm -f "$OBJETIVO" >/dev/null 2>&1 || true
docker run -d --name "$OBJETIVO" --network "$RED" \
  -e POSTGRES_PASSWORD=ensayo \
  -e POSTGRES_DB=tienda \
  postgres:18-alpine \
  -c shared_preload_libraries=pg_stat_statements \
  -c track_io_timing=on \
  -c compute_query_id=on >/dev/null
for _ in $(seq 1 40); do
  docker exec "$OBJETIVO" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$OBJETIVO" psql -U postgres -d tienda -qX \
  -c 'create extension if not exists pg_stat_statements' \
  -c 'create table if not exists pedidos (id serial primary key, cliente text, total numeric(12,2))' \
  -c "insert into pedidos (cliente, total) select 'cliente-' || g, random() * 500 from generate_series(1, 5000) g" \
  >/dev/null
ok 'servidor arriba, con pg_stat_statements y datos'

# El usuario de monitoreo se crea con el script documentado, no a mano: si ese
# script está roto, el ensayo tiene que enterarse.
docker cp "$RAIZ/sql/monitor-user.sql" "$OBJETIVO:/tmp/monitor-user.sql" >/dev/null
if docker exec "$OBJETIVO" psql -U postgres -d tienda -qX -v ON_ERROR_STOP=1 -f /tmp/monitor-user.sql >/dev/null 2>&1; then
  ok 'usuario de monitoreo creado con sql/monitor-user.sql'
else
  mal 'sql/monitor-user.sql falló contra un PostgreSQL limpio'
  docker exec "$OBJETIVO" psql -U postgres -d tienda -qX -f /tmp/monitor-user.sql 2>&1 | tail -5
fi
docker exec "$OBJETIVO" psql -U postgres -qX \
  -c "alter role buho_monitor with password 'monitor-ensayo'" >/dev/null 2>&1 || true

# ------------------------------------------- primer arranque: falta config.json
paso 'Primer arranque sin config.json'
cd "$ENSAYO"
salida=$(./install.sh 2>&1 || true)
if grep -q 'Se creó config.json' <<<"$salida" && [[ -f config.json ]]; then
  ok 'el instalador se detuvo y explicó qué editar'
else
  mal 'el instalador no explicó el paso de config.json'
  printf '%s\n' "$salida" | tail -10
fi
if grep -q 'sql/monitor-user.sql' <<<"$salida"; then
  ok 'indica cómo crear el usuario de mínimo privilegio'
else
  mal 'no menciona los scripts de usuario de monitoreo'
fi
if [[ -f .env ]] && grep -q '^BUHO_AUTH_SECRET=..*' .env; then
  ok 'secretos generados'
else
  mal 'no generó .env con secretos'
fi
SECRETO_ANTES=$(grep '^BUHO_AUTH_SECRET=' .env | cut -d= -f2-)

# --------------------------------------------------------------- config.json
paso 'Configurando la instancia a monitorear'
python3 - <<PY
import json, pathlib
p = pathlib.Path('config.json')
c = json.loads(p.read_text())
c['instances'] = [{
    'alias': 'tienda-ensayo',
    'host': '$OBJETIVO',
    'port': 5432,
    'database': 'tienda',
    'user': 'buho_monitor',
    'password': 'monitor-ensayo',
    'environment': 'lab',
    'tags': {'grupo': 'ensayo'},
}]
p.write_text(json.dumps(c, indent=2, ensure_ascii=False) + '\n')
PY
# El colector tiene que alcanzar al servidor por nombre, así que se le agrega la
# red del ensayo sin quitarle la del compose (donde vive el store).
cat > docker-compose.override.yml <<YAML
services:
  collector:
    networks:
      default: null
      ensayo: null
networks:
  ensayo:
    external: true
    name: $RED
YAML
ok 'config.json y red listos'

# ------------------------------------------------------------ segundo arranque
paso 'Instalando de verdad'
if BUHO_WEB_PORT=$PUERTO_WEB BUHO_STORE_PORT=$PUERTO_STORE ./install.sh > /tmp/buho-ensayo-install.log 2>&1; then
  ok 'install.sh terminó sin error'
else
  mal 'install.sh falló'
  tail -25 /tmp/buho-ensayo-install.log
fi

# Se buscan las frases de éxito y no la palabra suelta: 'muestras' aparece
# también en el aviso de "sin muestras todavía", así que la primera versión de
# este ensayo daba por buena una instalación que no recolectaba nada.
for clave in 'esquema aplicado en el store' 'el colector ya escribió' 'la consola responde en'; do
  if grep -q "$clave" /tmp/buho-ensayo-install.log; then
    ok "verificación del instalador: $clave"
  else
    mal "el instalador no confirmó: $clave"
  fi
done

# ---------------------------------------------------------------- comprobar
paso 'Comprobando la instalación'
consulta() {
  docker compose exec -T store psql -qtAX \
    "postgres://buho:$(grep '^BUHO_STORE_PASSWORD=' .env | cut -d= -f2-)@localhost:5432/buho" \
    -c "$1" 2>/dev/null | tr -d '[:space:]'
}

muestras=0
for _ in $(seq 1 30); do
  muestras=$(consulta 'select count(*) from buho.metric_samples')
  [[ "${muestras:-0}" -gt 100 ]] && break
  sleep 3
done
[[ "${muestras:-0}" -gt 100 ]] && ok "$muestras muestras del servidor externo" || mal "sólo ${muestras:-0} muestras"

# Los chequeos corren cada cinco minutos, con arranque escalonado: hay que
# esperarlos, no preguntar una vez. La primera versión de este ensayo falló por
# eso y no por un problema del producto.
chequeos=0
for _ in $(seq 1 40); do
  chequeos=$(consulta 'select count(*) from buho.check_results')
  [[ "${chequeos:-0}" -gt 0 ]] && break
  sleep 5
done
[[ "${chequeos:-0}" -gt 0 ]] && ok "$chequeos chequeos ejecutados" || mal 'ningún chequeo ejecutado'

# Tráfico para que haya algo que atribuir en el flujo.
for _ in $(seq 1 3); do
  docker exec "$OBJETIVO" psql -U postgres -d tienda -qX \
    -c "insert into pedidos (cliente, total) select 'x' || g, random() from generate_series(1, 200) g" \
    -c 'update pedidos set total = total + 1 where id % 7 = 0' \
    -c 'select count(*) from pedidos' >/dev/null 2>&1
  sleep 20
done

sentencias=$(consulta 'select count(*) from buho.statement_stats')
[[ "${sentencias:-0}" -gt 0 ]] && ok "$sentencias deltas de consultas" || mal 'sin estadísticas de consultas'

# ------------------------------------------------------------------- consola
paso 'Consola'
codigo=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PUERTO_WEB/login" || echo 000)
[[ "$codigo" == '200' ]] && ok 'la pantalla de entrada responde' || mal "la consola devolvió $codigo"

PASSWORD=$(grep '^BUHO_AUTH_PASSWORD=' .env | cut -d= -f2-)
if BUHO_URL="http://127.0.0.1:$PUERTO_WEB" BUHO_USER= BUHO_PASSWORD="$PASSWORD" \
   PW_CHROME="${PW_CHROME:-}" node "$RAIZ/scripts/verify-v1.mjs" > /tmp/buho-ensayo-web.log 2>&1; then
  ok 'todas las pantallas responden en la instalación nueva'
else
  mal 'alguna pantalla falló en la instalación nueva'
  tail -20 /tmp/buho-ensayo-web.log
fi

# ------------------------------------------------------------- idempotencia
paso 'Correrlo otra vez (actualización)'
if BUHO_WEB_PORT=$PUERTO_WEB BUHO_STORE_PORT=$PUERTO_STORE ./install.sh --sin-build > /tmp/buho-ensayo-otra.log 2>&1; then
  ok 'la segunda corrida terminó sin error'
else
  mal 'la segunda corrida falló'
  tail -20 /tmp/buho-ensayo-otra.log
fi
SECRETO_DESPUES=$(grep '^BUHO_AUTH_SECRET=' .env | cut -d= -f2-)
[[ "$SECRETO_ANTES" == "$SECRETO_DESPUES" ]] && ok 'no regeneró los secretos' || mal 'regeneró el secreto de sesiones'

despues=$(consulta 'select count(*) from buho.metric_samples')
[[ "${despues:-0}" -ge "${muestras:-0}" ]] && ok 'no perdió datos al actualizar' || mal "las muestras bajaron de $muestras a $despues"

# ---------------------------------------------------------------------- final
if [[ "$FALLOS" -eq 0 ]]; then
  printf '\n%sEl ensayo de instalación pasó completo.%s\n' "$NEGRITA" "$FIN"
else
  printf '\n%s%s fallo(s) en el ensayo de instalación.%s\n' "$ROJO" "$FALLOS" "$FIN"
  exit 1
fi
