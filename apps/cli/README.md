# buho-check

Read-only health report for one PostgreSQL instance. Same check catalog as the collector. No store, no Docker, no agent on the database host.

## Use

```bash
npm install
npm run check -- 'postgres://user:password@127.0.0.1:5432/mydb'

# or libpq variables
PGHOST=… PGDATABASE=… PGUSER=… PGPASSWORD=… npm run check
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings |
| 1 | Warnings or info only |
| 2 | At least one critical |
| 3 | Connection or runtime error |

Suitable for cron or CI. History, alerts, and the four-engine fleet are the full product: `./install.sh --pull`.

License: [`LICENSE`](../../LICENSE) (Apache License 2.0). `buho-check` can be used freely for evaluation and CI.
