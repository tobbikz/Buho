#!/usr/bin/env bash
# Lab for remote Add APM (SSH → Beyla → OTLP).
# - SSH: lab@127.0.0.1:2222  key: ./lab_id_ed25519
# - App: http://orders.lab:18083  (python on host — Beyla needs a real process, not docker-proxy)
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f lab_id_ed25519 ]]; then
  ssh-keygen -t ed25519 -f ./lab_id_ed25519 -N '' -C 'buho-apm-ssh-lab'
fi
cp -f lab_id_ed25519.pub authorized_keys

if ! grep -qE '[[:space:]]orders\.lab([[:space:]]|$)' /etc/hosts 2>/dev/null; then
  echo '127.0.0.1 orders.lab' | sudo tee -a /etc/hosts >/dev/null
fi

docker compose up -d --build ssh-lab

fuser -k 18083/tcp 2>/dev/null || true
sleep 0.2
nohup python3 -c '
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"orders-api lab ok\n")
    def log_message(self, *a): pass
HTTPServer(("0.0.0.0", 18083), H).serve_forever()
' >/tmp/buho-orders-lab.log 2>&1 &
echo $! >/tmp/buho-orders-lab.pid

echo "SSH  lab@127.0.0.1 -p 2222 -i $(pwd)/lab_id_ed25519"
echo "APP  http://orders.lab:18083"
echo "UI   Host orders.lab:18083 · SSH 127.0.0.1:2222 · user lab · key $(pwd)/lab_id_ed25519"
