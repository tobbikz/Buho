# OpenTelemetry collector

Optional. Apps can also post traces straight to the Búho console.

```bash
docker compose up -d otel-collector
```

Config: `deploy/otel-collector/config.yaml`.  
Búho ingest: `POST /api/otlp/v1/logs` and `POST /api/otlp/v1/traces`.

## Point an app at the collector

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=orders-api
```

## Point an app at Búho directly

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:3100/api/otlp/v1/traces
```

If that endpoint is reachable beyond loopback, set `BUHO_OTLP_TOKEN`. Exporters send `Authorization: Bearer` or `X-Buho-Otlp-Token`.

Búho does not invent traces. An empty Services view means nothing has exported yet.
