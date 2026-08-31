#!/usr/bin/env sh
#
# Respaldo del store de Búho.
#
# Es el único dato que no se reconstruye: las instancias salen de config.json,
# pero la historia —métricas, chequeos, bloqueos, consultas, líneas base— vive
# sólo acá. Un cliente que pierda el store pierde justo lo que está pagando.
#
# Corre como servicio del compose, en bucle, y deja el resultado escrito en
# buho.collector_events para que la consola lo muestre junto al resto de la
# operación: un respaldo que falla en silencio es peor que no tenerlo, porque
# se cree que existe.
#
# Variables:
#   BUHO_STORE_URL       a qué store conectarse (obligatoria)
#   BUHO_BACKUP_DIR      dónde escribir              (por omisión /respaldos)
#   BUHO_BACKUP_EVERY    segundos entre respaldos    (por omisión 86400)
#   BUHO_BACKUP_KEEP     cuántas copias conservar    (por omisión 7)
set -eu

DIR="${BUHO_BACKUP_DIR:-/respaldos}"
CADA="${BUHO_BACKUP_EVERY:-86400}"
CONSERVAR="${BUHO_BACKUP_KEEP:-7}"

[ -n "${BUHO_STORE_URL:-}" ] || { echo 'falta BUHO_STORE_URL' >&2; exit 1; }
mkdir -p "$DIR"

registrar() {
  nivel="$1"
  mensaje="$2"
  detalle="${3:-{\}}"
  # Best-effort: si el store no responde, el respaldo igual se intentó y el log
  # del contenedor lo cuenta. Las comillas se duplican porque el mensaje trae
  # rutas y texto de error que vienen de afuera.
  m=$(printf '%s' "$mensaje" | sed "s/'/''/g")
  d=$(printf '%s' "$detalle" | sed "s/'/''/g")
  psql "$BUHO_STORE_URL" -qtAX -c \
    "insert into buho.collector_events (level, component, message, detail)
     values ('$nivel', 'respaldo', '$m', '$d'::jsonb)" >/dev/null 2>&1 || true
}

echo "respaldo: destino $DIR, cada ${CADA}s, conservando $CONSERVAR copias"

while true; do
  marca=$(date -u +%Y%m%dT%H%M%SZ)
  archivo="$DIR/buho-$marca.dump"
  inicio=$(date +%s)

  # Formato propio de pg_dump (-Fc) y no un pipe a gzip: ya viene comprimido,
  # permite restaurar en paralelo o sólo una tabla, y sobre todo devuelve un
  # código de salida propio. Con `pg_dump | gzip` el estado que ve el shell es
  # el de gzip, así que un dump fallido se guardaba como éxito de 20 bytes.
  if pg_dump -Fc -f "$archivo.parcial" "$BUHO_STORE_URL" 2>/tmp/error-respaldo; then
    # Se renombra al final: un archivo con nombre definitivo siempre está
    # completo, así que nadie restaura a medias un dump interrumpido.
    mv "$archivo.parcial" "$archivo"
    segundos=$(( $(date +%s) - inicio ))
    bytes=$(wc -c < "$archivo" | tr -d ' ')

    # Purga por cantidad y no por fecha: así el disco tiene un techo conocido
    # aunque el reloj o la frecuencia cambien.
    sobrantes=$(ls -1t "$DIR"/buho-*.dump 2>/dev/null | tail -n +$((CONSERVAR + 1)) || true)
    borradas=0
    for viejo in $sobrantes; do
      rm -f "$viejo"
      borradas=$((borradas + 1))
    done

    echo "respaldo: $archivo ($bytes bytes en ${segundos}s), $borradas copia(s) vieja(s) borrada(s)"
    registrar info "respaldo del store completo: $(( bytes / 1024 )) KB en ${segundos}s" \
      "{\"archivo\": \"$archivo\", \"bytes\": $bytes, \"segundos\": $segundos, \"borradas\": $borradas}"
  else
    rm -f "$archivo.parcial"
    motivo=$(tr -d '"' < /tmp/error-respaldo | tail -3 | tr '\n' ' ')
    echo "respaldo: FALLÓ — $motivo" >&2
    registrar error "el respaldo del store falló" "{\"motivo\": \"$motivo\"}"
  fi

  sleep "$CADA"
done
