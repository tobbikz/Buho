/**
 * Lightweight HTTP mocks for Deep Platform W1/W2 lab (no full Airflow/DataSync).
 *   npx tsx scripts/platform-lab-mocks.ts
 * Airflow REST → :18998 · DataSync health → :18999
 */
import { createServer } from 'node:http';

function listen(port: number, name: string, handler: Parameters<typeof createServer>[0]): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`${name} listening on 127.0.0.1:${port}`);
      resolve(() =>
        new Promise<void>((res) => {
          server.close(() => res());
        }),
      );
    });
  });
}

async function main() {
  const stopAirflow = await listen(18998, 'airflow-mock', (req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url.startsWith('/api/v1/health') || url === '/health') {
      res.end(JSON.stringify({ metadatabase: { status: 'healthy' }, scheduler: { status: 'healthy' } }));
      return;
    }
    if (url.startsWith('/api/v1/dags') && req.method === 'GET') {
      res.end(
        JSON.stringify({
          dags: [
            { dag_id: 'demo', is_paused: false, has_import_errors: false },
            { dag_id: 'etl_hourly', is_paused: false, has_import_errors: false },
          ],
          total_entries: 2,
        }),
      );
      return;
    }
    if (url.startsWith('/api/v1/importErrors')) {
      res.end(JSON.stringify({ import_errors: [], total_entries: 0 }));
      return;
    }
    if (url.startsWith('/api/v1/pools')) {
      res.end(
        JSON.stringify({
          pools: [{ name: 'default_pool', slots: 128, open_slots: 10, occupied_slots: 118 }],
        }),
      );
      return;
    }
    if (req.method === 'PATCH' && url.includes('/dags/')) {
      res.end(JSON.stringify({ is_paused: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  const stopDatasync = await listen(18999, 'datasync-health-mock', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });

  console.log('platform lab mocks ready (Ctrl+C to stop)');
  const shutdown = async () => {
    await stopAirflow();
    await stopDatasync();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
