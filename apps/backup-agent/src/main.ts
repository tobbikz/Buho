#!/usr/bin/env node
/**
 * Buho backup storage agent (Deep Platform W5).
 *
 * Env:
 *   BUHO_STORE_URL     (required)
 *   BUHO_CONFIG        config with instances[].backup.storage (default config.json)
 *   BUHO_BACKUP_POLL_MS  poll interval (default 15000)
 *   BUHO_BACKUP_ONCE=1   process one drain cycle and exit
 *
 * Flow: ensure enqueue for storage-enabled instances → claim queued jobs →
 * write local manifest artifact → mark done/failed + saveBackupArtifact.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type InstanceConfig } from '@buho/core';
import { Store } from '@buho/store';

const STORE_URL = process.env.BUHO_STORE_URL?.trim();
if (!STORE_URL) {
  console.error('BUHO_STORE_URL is required');
  process.exit(1);
}

const POLL_MS = Number(process.env.BUHO_BACKUP_POLL_MS ?? 15_000);
const ONCE = process.env.BUHO_BACKUP_ONCE === '1';
const DEFAULT_LOCAL = join(process.cwd(), 'data', 'backups');

function log(level: 'info' | 'warn' | 'error', msg: string) {
  console.log(`${new Date().toISOString()} ${level.toUpperCase()}  ${msg}`);
}

async function ensureEnqueued(store: Store, instances: InstanceConfig[]): Promise<number> {
  let n = 0;
  for (const instance of instances) {
    const storage = instance.backup?.storage;
    if (!storage?.enabled) continue;
    if (storage.target !== 'local') {
      log('warn', `${instance.alias}: storage.target=${storage.target} not implemented yet (local only)`);
      continue;
    }
    const instanceId = await store.upsertInstance(instance);
    const recent = await store.countRecentBackupJobs(instanceId, 'logical', 12);
    if (recent > 0) continue;
    const jobId = await store.enqueueBackupJob({
      instanceId,
      kind: 'logical',
      config: {
        target: storage.target,
        path: storage.path ?? DEFAULT_LOCAL,
        retainDays: storage.retainDays ?? 7,
        alias: instance.alias,
        engine: instance.engine ?? 'postgres',
      },
    });
    log('info', `${instance.alias}: enqueued logical job ${jobId}`);
    n += 1;
  }
  return n;
}

async function writeLocalManifest(opts: {
  root: string;
  alias: string;
  engine: string;
  kind: string;
  jobId: number;
}): Promise<{ path: string; sizeBytes: number; checksum: string }> {
  const dir = join(opts.root, opts.alias, opts.kind, String(opts.jobId));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  const body = `${JSON.stringify(
    {
      agent: 'buho-backup-agent',
      alias: opts.alias,
      engine: opts.engine,
      kind: opts.kind,
      jobId: opts.jobId,
      createdAt: new Date().toISOString(),
      note: 'Logical backup manifest (storage phase). Pair with engine-native dumps when operators attach pg_dump/mysqldump/sqlcmd.',
    },
    null,
    2,
  )}\n`;
  await writeFile(path, body, 'utf8');
  return {
    path,
    sizeBytes: Buffer.byteLength(body),
    checksum: createHash('sha256').update(body).digest('hex'),
  };
}

async function drain(store: Store): Promise<number> {
  const jobs = await store.claimQueuedBackupJobs(5);
  let done = 0;
  for (const job of jobs) {
    const target = String(job.config['target'] ?? 'local');
    const root = String(job.config['path'] ?? DEFAULT_LOCAL);
    try {
      if (target !== 'local') {
        throw new Error(`unsupported storage target: ${target}`);
      }
      const artifact = await writeLocalManifest({
        root,
        alias: job.alias,
        engine: job.engine,
        kind: job.kind,
        jobId: job.jobId,
      });
      await store.saveBackupArtifact({
        instanceId: job.instanceId,
        jobId: job.jobId,
        kind: job.kind,
        target: 'local',
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        checksum: artifact.checksum,
      });
      await store.finishBackupJob({
        jobId: job.jobId,
        status: 'done',
        message: `artifact ${artifact.path} sha256=${artifact.checksum.slice(0, 12)}…`,
      });
      log('info', `${job.alias} job ${job.jobId}: done (${artifact.sizeBytes} B)`);
      done += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.finishBackupJob({ jobId: job.jobId, status: 'failed', message });
      log('error', `${job.alias} job ${job.jobId}: ${message}`);
    }
  }
  return done;
}

async function cycle(store: Store, instances: InstanceConfig[]): Promise<void> {
  const enqueued = await ensureEnqueued(store, instances);
  const finished = await drain(store);
  if (enqueued === 0 && finished === 0) {
    log('info', 'idle (no enqueue / no queued jobs)');
  }
}

async function main() {
  const config = await loadConfig();
  const store = new Store(STORE_URL!);
  log(
    'info',
    `backup-agent start · instances=${config.instances.length} · poll=${POLL_MS}ms · once=${ONCE}`,
  );

  const run = async () => {
    try {
      await cycle(store, config.instances);
    } catch (error) {
      log('error', error instanceof Error ? error.message : String(error));
    }
  };

  await run();
  if (ONCE) {
    await store.close();
    return;
  }

  const timer = setInterval(() => void run(), POLL_MS);
  const shutdown = async () => {
    clearInterval(timer);
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
