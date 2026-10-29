# Buho backup agent (Deep Platform W5 phase 3)

Placeholder for the Buho-managed backup **storage** agent.

- Monitor + restore-drill catalog already live in the store (`backup_jobs`, `backup_artifacts`, `restore_drills`).
- This agent will pull job rows with `status=queued`, write dumps to `backup.storage` targets (local/S3/NFS), and register artifacts.

Not started as a long-running binary in this cut — wire `InstanceConfig.backup.storage.enabled` when shipping M3.
