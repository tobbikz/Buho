#!/usr/bin/env bash
# Zero-code APM via Grafana Beyla (eBPF) → Buho OTLP collector (:4318).
#
# One container per listen port so Enable APM for the console (:3100) does not
# replace another service (e.g. orders-api :18083).
#
#   scripts/apm-ebpf.sh start <host> <port> [service]
#   scripts/apm-ebpf.sh stop [port]
#   scripts/apm-ebpf.sh status [port]
#   scripts/apm-ebpf.sh command <host> <port> [service]

set -euo pipefail

IMAGE="${BUHO_BEYLA_IMAGE:-grafana/beyla:latest}"
OTLP="${BUHO_OTEL_COLLECTOR_ENDPOINT:-http://127.0.0.1:4318}"
PROTOCOL="${BUHO_OTEL_PROTOCOL:-http/protobuf}"
LABEL_FILTER="label=buho.apm=ebpf"

container_name() {
  local port="$1"
  # Keep legacy single-name override for one-off labs.
  if [[ -n "${BUHO_BEYLA_NAME:-}" ]]; then
    printf '%s' "$BUHO_BEYLA_NAME"
    return
  fi
  printf 'buho-beyla-%s' "$port"
}

is_local() {
  local h
  h=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$h" in
    127.0.0.1|localhost|::1|0.0.0.0|host.docker.internal) return 0 ;;
  esac
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null || true); do
      [[ "$ip" == "$1" ]] && return 0
    done
  fi
  return 1
}

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'
}

build_command() {
  local host="$1" port="$2" service="${3:-}"
  local name
  name=$(container_name "$port")
  local svc_line=""
  if [[ -n "$service" ]]; then
    svc_line="  -e OTEL_SERVICE_NAME=${service} \\
"
  fi
  cat <<EOF
docker run -d --name ${name} --restart unless-stopped \\
  --privileged --pid=host --network=host \\
  -v /sys/fs/bpf:/sys/fs/bpf \\
  -v /sys/kernel/tracing:/sys/kernel/tracing \\
  -e BEYLA_OPEN_PORT=${port} \\
  -e OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP} \\
  -e OTEL_EXPORTER_OTLP_PROTOCOL=${PROTOCOL} \\
${svc_line}  -l buho.apm=ebpf \\
  -l buho.apm.host=${host} \\
  -l buho.apm.port=${port} \\
  ${IMAGE}
EOF
}

inspect_one() {
  local name="$1"
  if ! docker inspect "$name" >/dev/null 2>&1; then
    return 1
  fi
  local state host port service
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo unknown)
  host=$(docker inspect -f '{{index .Config.Labels "buho.apm.host"}}' "$name" 2>/dev/null || true)
  port=$(docker inspect -f '{{index .Config.Labels "buho.apm.port"}}' "$name" 2>/dev/null || true)
  service=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" 2>/dev/null | sed -n 's/^OTEL_SERVICE_NAME=//p' | head -1)
  local running=false
  [[ "$state" == "running" ]] && running=true
  printf '{"running":%s,"container":"%s","state":"%s","host":"%s","port":"%s","service":"%s","otlp":"%s"}' \
    "$running" "$name" "$state" "$host" "$port" "$service" "$OTLP"
}

cmd_status() {
  local want_port="${1:-}"
  if [[ -n "$want_port" ]]; then
    local name
    name=$(container_name "$want_port")
    if inspect_one "$name"; then
      printf '\n'
      return 0
    fi
    # Legacy name used before per-port containers.
    if [[ -z "${BUHO_BEYLA_NAME:-}" ]] && inspect_one "buho-beyla"; then
      printf '\n'
      return 0
    fi
    printf '%s\n' '{"running":false}'
    return 0
  fi

  # Aggregate: any labeled agent; prefer :3100 (console) then first running.
  local ids
  ids=$(docker ps -aq --filter "$LABEL_FILTER" 2>/dev/null || true)
  if [[ -z "$ids" ]]; then
    # Legacy single container
    if inspect_one "buho-beyla"; then
      printf '\n'
      return 0
    fi
    printf '%s\n' '{"running":false}'
    return 0
  fi

  BUHO_OTLP="$OTLP" BUHO_IDS="$ids" python3 <<'PY'
import json, os, subprocess
otlp = os.environ.get("BUHO_OTLP", "")
ids = os.environ.get("BUHO_IDS", "").split()
agents = []
for i in ids:
    try:
        out = subprocess.check_output(
            [
                "docker",
                "inspect",
                "-f",
                '{{.Name}}|{{.State.Status}}|{{index .Config.Labels "buho.apm.host"}}|{{index .Config.Labels "buho.apm.port"}}|{{range .Config.Env}}{{println .}}{{end}}',
                i,
            ],
            text=True,
        )
    except Exception:
        continue
    parts = out.split("|", 4)
    if len(parts) < 4:
        continue
    name = parts[0].lstrip("/")
    state = parts[1].strip()
    host = parts[2].strip()
    port = parts[3].strip()
    env = parts[4] if len(parts) > 4 else ""
    service = ""
    for line in env.splitlines():
        if line.startswith("OTEL_SERVICE_NAME="):
            service = line.split("=", 1)[1]
            break
    agents.append(
        {
            "running": state == "running",
            "container": name,
            "state": state,
            "host": host,
            "port": port,
            "service": service,
            "otlp": otlp,
        }
    )

preferred = None
for a in agents:
    if a.get("running") and str(a.get("port")) == "3100":
        preferred = a
        break
if preferred is None:
    for a in agents:
        if a.get("running"):
            preferred = a
            break
if preferred is None and agents:
    preferred = agents[0]

if not preferred:
    print(json.dumps({"running": False, "agents": []}))
else:
    out = dict(preferred)
    out["agents"] = agents
    out["running"] = any(a.get("running") for a in agents)
    print(json.dumps(out))
PY
}

cmd_stop() {
  local want_port="${1:-}"
  local stopped=false
  if [[ -n "$want_port" ]]; then
    local name
    name=$(container_name "$want_port")
    if docker inspect "$name" >/dev/null 2>&1; then
      docker rm -f "$name" >/dev/null
      stopped=true
    fi
    if [[ -z "${BUHO_BEYLA_NAME:-}" ]] && docker inspect "buho-beyla" >/dev/null 2>&1; then
      # Only remove legacy if it matches this port
      local lp
      lp=$(docker inspect -f '{{index .Config.Labels "buho.apm.port"}}' "buho-beyla" 2>/dev/null || true)
      if [[ "$lp" == "$want_port" ]]; then
        docker rm -f "buho-beyla" >/dev/null
        stopped=true
      fi
    fi
  else
    local ids
    ids=$(docker ps -aq --filter "$LABEL_FILTER" 2>/dev/null || true)
    if [[ -n "$ids" ]]; then
      # shellcheck disable=SC2086
      docker rm -f $ids >/dev/null
      stopped=true
    fi
    if docker inspect "buho-beyla" >/dev/null 2>&1; then
      docker rm -f "buho-beyla" >/dev/null
      stopped=true
    fi
  fi
  if $stopped; then
    printf '%s\n' '{"ok":true,"stopped":true}'
  else
    printf '%s\n' '{"ok":true,"stopped":false}'
  fi
}

cmd_start() {
  local host="$1" port="$2" service="${3:-}"
  if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    printf '%s\n' '{"ok":false,"error":"valid port required"}' >&2
    exit 1
  fi

  local name command
  name=$(container_name "$port")
  command=$(build_command "$host" "$port" "$service")

  if ! is_local "$host"; then
    printf '{"ok":false,"mode":"remote","error":"eBPF must run on the target host — copy the command","command":%s}\n' \
      "$(json_escape "$command")"
    exit 2
  fi

  docker rm -f "$name" >/dev/null 2>&1 || true
  # Migrate away from legacy shared name if it owns this port (or no port label).
  if docker inspect "buho-beyla" >/dev/null 2>&1; then
    local lp
    lp=$(docker inspect -f '{{index .Config.Labels "buho.apm.port"}}' "buho-beyla" 2>/dev/null || true)
    if [[ -z "$lp" || "$lp" == "$port" ]]; then
      docker rm -f "buho-beyla" >/dev/null 2>&1 || true
    fi
  fi
  docker pull -q "$IMAGE" >/dev/null 2>&1 || true

  local args=(
    -d --name "$name" --restart unless-stopped
    --privileged --pid=host --network=host
    -v /sys/fs/bpf:/sys/fs/bpf
    -v /sys/kernel/tracing:/sys/kernel/tracing
    -e "BEYLA_OPEN_PORT=${port}"
    -e "OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP}"
    -e "OTEL_EXPORTER_OTLP_PROTOCOL=${PROTOCOL}"
    -e "BEYLA_TRACE_PRINTER=text"
    -l "buho.apm=ebpf"
    -l "buho.apm.host=${host}"
    -l "buho.apm.port=${port}"
  )
  if [[ -n "$service" ]]; then
    args+=(-e "OTEL_SERVICE_NAME=${service}")
  fi
  docker run "${args[@]}" "$IMAGE" >/dev/null

  local st
  st=$(cmd_status "$port")
  printf '%s\n' "$st" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["ok"]=True; d["mode"]="local"; print(json.dumps(d))'
}

usage() {
  echo "usage: $0 {start|stop|status|command} ..." >&2
  exit 1
}

case "${1:-}" in
  start)
    [[ $# -ge 3 ]] || usage
    cmd_start "$2" "$3" "${4:-}"
    ;;
  stop)
    cmd_stop "${2:-}"
    ;;
  status)
    cmd_status "${2:-}"
    ;;
  command)
    [[ $# -ge 3 ]] || usage
    build_command "$2" "$3" "${4:-}"
    ;;
  *) usage ;;
esac
