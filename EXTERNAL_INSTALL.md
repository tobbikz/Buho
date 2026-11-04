# Install on another host

Customer install, including machines that cannot pull from GHCR.

## Customer install

```bash
git clone https://github.com/tobbikz/buho.git
cd buho
git checkout v1.8.0
./install.sh --pull
```

Then open the console → **Get started**, and follow [`GO_LIVE.md`](GO_LIVE.md).

## Before you start

1. Docker and Compose v2 are installed.
2. The host can pull from `ghcr.io`, or you loaded the two images with the steps below.
3. The console is reached through TLS or a VPN. The store port is not public.
4. [`GO_LIVE.md`](GO_LIVE.md) sections 1–7 are done.
5. The pilot is signed ([`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md)) or there is a Pro/Fleet order ([`PRICING.md`](PRICING.md)).

## Images

| Image | Tag |
| --- | --- |
| `ghcr.io/tobbikz/buho/collector` | `1.8.0` / `latest` |
| `ghcr.io/tobbikz/buho/web` | `1.8.0` / `latest` |

Published by `.github/workflows/publish-images.yml` when a `v*` tag is pushed. Pin `1.8.0` for a customer host so `latest` cannot move under you.

## Air-gapped

On a machine that can reach GHCR:

```bash
docker pull ghcr.io/tobbikz/buho/collector:1.8.0
docker pull ghcr.io/tobbikz/buho/web:1.8.0
docker save ghcr.io/tobbikz/buho/collector:1.8.0 \
            ghcr.io/tobbikz/buho/web:1.8.0 \
  | gzip > buho-1.8.0-images.tgz
```

On the customer host:

```bash
gunzip -c buho-1.8.0-images.tgz | docker load
export BUHO_COLLECTOR_IMAGE=ghcr.io/tobbikz/buho/collector:1.8.0
export BUHO_WEB_IMAGE=ghcr.io/tobbikz/buho/web:1.8.0
export BUHO_OTLP_TOKEN="$(openssl rand -hex 24)"   # required if OTLP is not loopback-only
./install.sh --pull
```

## After it is up

- [ ] Console login works.
- [ ] One database shows a health score.
- [ ] One alert channel **Test** arrived.
- [ ] If OTLP is exposed: exporters send the bearer token, and traces show up under Observability.
