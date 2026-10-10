# External install readiness

A true “install on someone else’s machine” needs that host. This file is the **ready pack** so that install is mechanical.

## Customer one-liner

```bash
git clone https://github.com/tobbikz/buho-monitor.git
cd buho-monitor
git checkout v1.6.1
./install.sh --pull
```

Then open the console → **Get started** → follow `GO_LIVE.md`.

## Local proof (this repo)

Automated clean-room install (same machine, isolated compose):

```bash
npm run ensayo:instalacion
```

Parity gate before calling the build production-ready:

```bash
npx tsx scripts/assert-check-parity.ts
```

## Operator checklist (remote host)

1. Docker + Compose v2
2. Outbound pull from `ghcr.io` (or mirror the two images)
3. Open ports only for console (TLS) and store (not public)
4. Run `GO_LIVE.md` §§1–7
5. Sign `PILOT_AGREEMENT.md` or Pro order (`PRICING.md`)

## Images

| Image | Tag |
|-------|-----|
| `ghcr.io/tobbikz/buho-monitor/collector` | `1.6.1` / `latest` |
| `ghcr.io/tobbikz/buho-monitor/web` | `1.6.1` / `latest` |

Published by `.github/workflows/publish-images.yml` on push of tag `v*`.


## Air-gapped / offline

On a machine with GHCR access:

```bash
docker pull ghcr.io/tobbikz/buho-monitor/collector:1.6.1
docker pull ghcr.io/tobbikz/buho-monitor/web:1.6.1
docker save ghcr.io/tobbikz/buho-monitor/collector:1.6.1 \
            ghcr.io/tobbikz/buho-monitor/web:1.6.1 \
  | gzip > buho-1.6.1-images.tgz
```

On the foreign host (no registry pull):

```bash
gunzip -c buho-1.6.1-images.tgz | docker load
# then install.sh / compose with image tags pinned to 1.6.1 (no :latest drift)
export BUHO_OTLP_TOKEN="$(openssl rand -hex 24)"   # required off-loopback
```

### Foreign host smoke checklist

- [ ] `curl -sS http://HOST:3100/api/otlp/v1/traces` → auth hint / token mode
- [ ] `npm run smoke:otlp` (or equivalent) with `Authorization: Bearer $BUHO_OTLP_TOKEN`
- [ ] Console login + `npm run verify:v1` against foreign `BUHO_BASE_URL`
- [ ] Collector scrape at least one DB target
