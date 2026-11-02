# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` / latest release | Yes |
| Older tags | Best effort |

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security bugs.

Email **IKZ Technologies** via the contact on the GitHub org profile, or open a
**private** security advisory on this repository (GitHub → Security → Advisories).

Include:

- Affected component (`apps/web`, `apps/collector`, `packages/*`, …)
- Reproduction steps or PoC (non-destructive if possible)
- Impact assessment (auth bypass, data exposure, RCE, …)

We aim to acknowledge within a few business days and coordinate a fix + disclosure.

## Hardening tips for operators

- Set a strong `BUHO_AUTH_PASSWORD` (and rotate demo users in production).
- Do not expose the store port (`55432`) or collector APIs to the public internet.
- Prefer least-privilege monitor users from `sql/monitor-user*.sql`.
- Keep OTLP ingest loopback-only or token-gated (`BUHO_OTLP_TOKEN`).
