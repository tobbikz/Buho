/**
 * Enqueue one logical job for pg-lab, then run the agent once.
 *   BUHO_STORE_URL=... BUHO_CONFIG=config.lab-core.json npx tsx scripts/backup-agent-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '@buho/store';

const storeUrl = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';
const configPath = process.env.BUHO_CONFIG ?? 'config.lab-core.json';

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    instances: Array<{
      alias: string;
      engine?: string;
      host: string;
      port: number;
      database: string;
      user?: string;
      password?: string;
      environment?: string;
    }>;
  };
  const pg = config.instances.find((i) => i.alias === 'pg-lab');
  if (!pg) throw new Error('pg-lab missing from config');

  const root = join(process.cwd(), 'data', 'backups');
  const store = new Store(storeUrl);
  let jobId = 0;
  let instanceId = 0;
  try {
    instanceId = await store.upsertInstance({
      alias: pg.alias,
      engine: 'postgres',
      host: pg.host,
      port: pg.port,
      database: pg.database,
      user: pg.user,
      password: pg.password,
      environment: pg.environment ?? 'lab',
    });
    jobId = await store.enqueueBackupJob({
      instanceId,
      kind: 'logical',
      config: { target: 'local', path: root, alias: pg.alias, engine: 'postgres' },
    });
  } finally {
    await store.close();
  }

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', 'apps/backup-agent/src/main.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUHO_STORE_URL: storeUrl,
          BUHO_CONFIG: configPath,
          BUHO_BACKUP_ONCE: '1',
        },
        stdio: 'inherit',
        shell: true,
      },
    );
    child.on('error', reject);
    child.on('exit', (c) => resolve(c ?? 1));
  });

  const verify = new Store(storeUrl);
  try {
    const jobs = await verify.listBackupJobs(instanceId, 5);
    const arts = await verify.listLatestBackupArtifacts(instanceId, 5);
    console.log(
      JSON.stringify(
        {
          ok: code === 0 && jobs.some((j) => j.status === 'done'),
          jobId,
          latestJobs: jobs.slice(0, 3),
          artifacts: arts.slice(0, 3),
        },
        null,
        2,
      ),
    );
    if (code !== 0) process.exitCode = code;
  } finally {
    await verify.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
