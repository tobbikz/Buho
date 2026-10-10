# OTel Collector (Búho traces)

Part of the main stack — **not** a side project.

```bash
docker compose up -d otel-collector
```

Config: `deploy/otel-collector/config.yaml`  
Ingest in Buho: `POST /api/otlp/v1/traces` (http/json)

## Wire an app

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=orders-api
```

Direct to Buho (no collector): `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` +  
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:3100/api/otlp/v1/traces`

## Lab

```bash
npm run otel:emit
npm run smoke:otlp
```

There is **no** fake APM bootstrap (`SELECT 1`) anymore — only real OTLP.
