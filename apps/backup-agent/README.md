# `@buho/backup-agent`

Storage agent for Deep Platform **W5**. Drains `buho.backup_jobs` with `status=queued`, writes artifacts under a local path, and registers `buho.backup_artifacts`.

## Run

```bash
# Enable storage on an instance in BUHO_CONFIG:
#   "backup": { "storage": { "enabled": true, "target": "local", "path": "./data/backups" } }

BUHO_STORE_URL=postgres://buho:buho@127.0.0.1:55432/buho \
BUHO_CONFIG=config.lab-core.json \
BUHO_BACKUP_ONCE=1 \
npm run backup-agent
```

Long-running (poll every 15s):

```bash
npm run backup-agent
```

## Behaviour

1. For each config instance with `backup.storage.enabled` and no recent `logical` job (~12h), enqueue one.
2. Claim queued jobs (`FOR UPDATE SKIP LOCKED`).
3. Write `data/backups/<alias>/logical/<jobId>/manifest.json` (sha256 recorded).
4. Mark job `done` / `failed`.

`s3` / `nfs` targets are rejected cleanly until wired. Engine-native dumps (`pg_dump`, etc.) can attach beside the manifest later.
