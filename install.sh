#!/usr/bin/env bash
#
# Puesta en marcha de Búho.
#
# El objetivo de este script es que alguien que nunca vio el proyecto lo tenga
# corriendo sin leer código: comprueba lo que hace falta, genera los secretos,
# levanta los tres contenedores y verifica que de verdad esté recolectando.
#
# Es idempotente: se puede correr otra vez para actualizar sin perder datos ni
# regenerar secretos (regenerarlos cerraría todas las sesiones abiertas).
#
# Uso:
#   ./install.sh                 instala o actualiza (construye si hace falta)
#   ./install.sh --pull          baja imágenes publicadas; el cliente no compila
#   ./install.sh --actualizar    reconstruye colector y consola; el store no se reinicia
#   ./install.sh --sin-build     usa las imágenes ya presentes en el host
#   ./install.sh --verificar     sólo comprueba el estado de una instalación
set -euo pipefail

cd "$(dirname "$0")"

ROJO=$'\033[31m'; VERDE=$'\033[32m'; AMARILLO=$'\033[33m'; NEGRITA=$'\033[1m'; FIN=$'\033[0m'
paso()  { printf '\n%s==>%s %s\n' "$NEGRITA" "$FIN" "$1"; }
ok()    { printf '  %s✓%s %s\n' "$VERDE" "$FIN" "$1"; }
aviso() { printf '  %s!%s %s\n' "$AMARILLO" "$FIN" "$1"; }
fatal() { printf '\n%serror:%s %s\n' "$ROJO" "$FIN" "$1" >&2; exit 1; }

BUILD=1
PULL=0
SOLO_VERIFICAR=0
ACTUALIZAR=0
for arg in "$@"; do
  case "$arg" in
    --sin-build) BUILD=0 ;;
    --pull) PULL=1; BUILD=0 ;;
    --actualizar) ACTUALIZAR=1 ;;
    --verificar) SOLO_VERIFICAR=1 ;;
    -h|--help)
      sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fatal "opción desconocida: $arg" ;;
  esac
done

# --------------------------------------------------------------- requisitos

paso 'Comprobando requisitos'

command -v docker >/dev/null 2>&1 || fatal 'falta docker. Ver https://docs.docker.com/engine/install/'
docker info >/dev/null 2>&1 || fatal 'docker está instalado pero el demonio no responde. Probar: sudo systemctl start docker'

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fatal 'falta el plugin compose de docker (docker compose version)'
fi
ok "docker y compose disponibles"

# openssl sólo se necesita para generar secretos la primera vez.
if [[ ! -f .env ]] && ! command -v openssl >/dev/null 2>&1; then
  fatal 'falta openssl, que es lo que genera los secretos. Instalarlo o crear .env a mano desde .env.example'
fi

# ------------------------------------------------------------------ secretos

paso 'Secretos'

if [[ -f .env ]]; then
  ok '.env ya existe; no se toca (regenerar el secreto cerraría las sesiones abiertas)'
else
  umask 077
  {
    echo "# Generado por install.sh el $(date -Iseconds). No se versiona."
    echo "# Contraseña del PostgreSQL interno donde Búho guarda su historia."
    echo "BUHO_STORE_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')"
    echo
    echo "# Firma las sesiones de la consola. Si cambia, todos vuelven a entrar."
    echo "BUHO_AUTH_SECRET=$(openssl rand -base64 36 | tr -d '/+=')"
    echo
    echo "# Contraseña de arranque: entra como administrador MIENTRAS NO EXISTA"
    echo "# ninguna cuenta, para poder crear la primera. Después deja de servir."
    echo "BUHO_AUTH_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')"
    echo
    echo "# Activar sólo si la consola termina TLS ella misma. Detrás de un proxy"
    echo "# que ya lo termina, exigir secure impide entrar."
    echo "BUHO_AUTH_COOKIE_SECURE=false"
  } > .env
  ok '.env generado con secretos nuevos'
fi

# ---------------------------------------------------------------- instancias

paso 'Instancias a monitorear'

if [[ ! -f config.json ]]; then
  cp config.example.json config.json
  cat <<'TEXTO'

  Se creó config.json a partir del ejemplo. Hay que editarlo antes de seguir:

    1. store.url  —  dejarlo como está si se usa docker compose; la URL real la
                     inyecta el compose por variable de entorno.
    2. instances  —  una entrada por servidor, con host, puerto, base, usuario y
                     contraseña del usuario de monitoreo.

  El usuario de monitoreo se crea con los scripts de sql/, que dan el mínimo
  privilegio necesario por motor:

    psql -h TU_SERVIDOR -U postgres -f sql/monitor-user.sql
    mariadb -h TU_SERVIDOR -u root  < sql/monitor-user-mariadb.sql
    sqlcmd  -S TU_SERVIDOR -U sa    -i sql/monitor-user-mssql.sql

  Cuando config.json esté listo, correr otra vez: ./install.sh

TEXTO
  exit 1
fi

# Un config con las contraseñas del ejemplo levanta tres contenedores que no
# pueden conectarse a nada. Es mejor decirlo antes que dejar la consola vacía.
if grep -qE '"password"[[:space:]]*:[[:space:]]*"(CAMBIAR|cambiar)"' config.json; then
  fatal "config.json todavía tiene las contraseñas de ejemplo (\"CAMBIAR\"). Editarlo y volver a correr."
fi

INSTANCIAS=$(grep -c '"alias"' config.json || true)
[[ "$INSTANCIAS" -gt 0 ]] || fatal 'config.json no declara ninguna instancia en "instances"'
ok "config.json declara $INSTANCIAS instancia(s)"

# ------------------------------------------------------------------ arranque

if [[ "$SOLO_VERIFICAR" -eq 0 && "$ACTUALIZAR" -eq 1 ]]; then
  # El store guarda la historia. Recrearlo no borra el volumen, pero sí corta
  # la recolección y la consola unos segundos sin necesidad: el código nuevo
  # vive en collector y web.
  paso 'Actualizando colector y consola (el store sigue corriendo)'
  # No hacer `up store`. En Podman eso intenta volver a publicar 55432 aunque
  # el contenedor ya lo tenga, y el script muere con "address already in use"
  # antes de construir el colector y la consola. `ps --status running` en el
  # compose de Podman tampoco lista el servicio, así que no se usa como prueba.
  ok 'el store no se toca'
  if [[ "$PULL" -eq 1 ]]; then
    "${COMPOSE[@]}" pull collector web
    ok 'imágenes de colector y consola bajadas'
  elif [[ "$BUILD" -eq 1 ]]; then
    "${COMPOSE[@]}" build collector web
    ok 'imágenes de colector y consola construidas'
  else
    aviso 'sin construir ni bajar: se recrean colector y consola con la imagen que ya está'
  fi
  "${COMPOSE[@]}" up -d --no-deps --force-recreate collector web
  ok 'colector y consola recreados; el volumen del store no se tocó'
elif [[ "$SOLO_VERIFICAR" -eq 0 ]]; then
  if [[ "$PULL" -eq 1 ]]; then
    paso 'Bajando imágenes publicadas (sin compilar)'
    # Se puede fijar la versión: BUHO_COLLECTOR_IMAGE=ghcr.io/.../collector:0.3.0
    "${COMPOSE[@]}" pull collector web store
    ok 'imágenes listas'
  elif [[ "$BUILD" -eq 1 ]]; then
    paso 'Construyendo imágenes (la primera vez tarda varios minutos)'
    "${COMPOSE[@]}" build
    ok 'imágenes construidas'
  fi

  paso 'Levantando store, colector y consola'
  "${COMPOSE[@]}" up -d
  ok 'contenedores arriba'
fi

# ---------------------------------------------------------------- verificación

paso 'Verificando'

# El colector aplica el esquema al arrancar, así que la primera vez hay que
# darle tiempo antes de preguntarle si ya hay datos.
STORE_URL="postgres://buho:$(grep -E '^BUHO_STORE_PASSWORD=' .env | cut -d= -f2-)@localhost:5432/buho"
consulta() { "${COMPOSE[@]}" exec -T store psql -qtAX "$STORE_URL" -c "$1" 2>/dev/null || true; }

listo=0
for _ in $(seq 1 60); do
  if [[ "$(consulta 'select count(*) from buho.metric_samples')" =~ ^[0-9]+$ ]]; then
    listo=1
    break
  fi
  sleep 2
done

if [[ "$listo" -eq 1 ]]; then
  ok "esquema aplicado en el store"
else
  aviso "el store todavía no tiene el esquema. Ver: ${COMPOSE[*]} logs collector"
fi

muestras=0
for _ in $(seq 1 30); do
  muestras=$(consulta 'select count(*) from buho.metric_samples' | tr -d '[:space:]')
  [[ "${muestras:-0}" -gt 0 ]] && break
  sleep 2
done

if [[ "${muestras:-0}" -gt 0 ]]; then
  ok "el colector ya escribió $muestras muestras"
else
  aviso "sin muestras todavía. Suele ser credenciales o red hacia las instancias:"
  aviso "  ${COMPOSE[*]} logs --tail 40 collector"
fi

PUERTO_WEB="${BUHO_WEB_PORT:-$(grep -E '^BUHO_WEB_PORT=' .env 2>/dev/null | cut -d= -f2-)}"
PUERTO_WEB="${PUERTO_WEB:-3100}"

codigo=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PUERTO_WEB}/login" || echo 000)
if [[ "$codigo" == "200" ]]; then
  ok "la consola responde en http://127.0.0.1:${PUERTO_WEB}"
else
  aviso "la consola devolvió $codigo. Ver: ${COMPOSE[*]} logs --tail 40 web"
fi

# --------------------------------------------------------------------- final

PASSWORD=$(grep -E '^BUHO_AUTH_PASSWORD=' .env | cut -d= -f2-)

cat <<TEXTO

${NEGRITA}Búho está corriendo.${FIN}

  Consola:     http://127.0.0.1:${PUERTO_WEB}
  Contraseña:  ${PASSWORD}

Esa contraseña es sólo para el primer ingreso: entra como administrador
mientras no exista ninguna cuenta. Lo primero que conviene hacer es crear la
cuenta propia en Administración → Usuarios; desde ese momento la contraseña de
arranque deja de funcionar.

El puerto escucha en 127.0.0.1 a propósito. Para exponerlo, poner un proxy con
TLS delante o llegar por VPN; la autenticación no reemplaza a ninguno de los dos.

Siguientes pasos y detalle de cada opción: INSTALL.md
TEXTO
