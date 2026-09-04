# External install readiness

A true “install on someone else’s machine” needs that host. This file is the **ready pack** so that install is mechanical.

## Customer one-liner

```bash
git clone https://github.com/tobbikz/buho-monitor.git
cd buho-monitor
git checkout v1.3.0
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
| `ghcr.io/tobbikz/buho-monitor/collector` | `1.3.0` / `latest` |
| `ghcr.io/tobbikz/buho-monitor/web` | `1.3.0` / `latest` |

Published by `.github/workflows/publish-images.yml` on push of tag `v*`.
