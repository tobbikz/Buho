# Contributing to Búho

Thanks for helping improve on-prem database monitoring.

## Development setup

Requirements: **Node.js ≥ 22**, Docker + Compose v2.

```bash
git clone https://github.com/tobbikz/buho.git
cd buho
cp config.example.json config.json   # optional lab targets
cp .env.example .env                 # auth / store secrets for local web
npm install
docker compose up -d                 # store on :55432 by default
npm run migrate
npm run collector                    # terminal 1
npm run web:dev                      # terminal 2 — http://127.0.0.1:3100
```

Demo login (local only): see `.env.example` / seed scripts. Never commit real passwords.

## Project map

| Path | Role |
|------|------|
| `apps/collector` | Scrapes engines, writes store, reconciles alerts |
| `apps/web` | Next.js console |
| `apps/cli` | `buho-check` one-shot health report |
| `apps/mcp` | MCP server for agents |
| `packages/core` | Collectors, inventory, security, foreign engines |
| `packages/checks` | Check catalog + remediation |
| `packages/store` | Schema, partitions, rollups |
| `packages/sensors` | Host / ICMP / SNMP / process sensors |
| `sql/` | Least-privilege monitor users |
| `lab/` | Optional lab compose helpers (not required for prod) |

## Checks before a PR

```bash
npm run typecheck
npm run verify:parity
npx tsx scripts/assert-check-parity.ts
npm run test:sensors
```

Prefer small, focused PRs. Conventional commits (`feat`, `fix`, `docs`, `chore`, …).

## Code style

- Match surrounding TypeScript / React patterns.
- User-facing console copy is **English**.
- Do not add secrets, personal lab configs, or absolute machine paths.
- New engines or checks should extend the existing parity / catalog patterns.

## Security issues

Do **not** open a public issue for vulnerabilities. See [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
