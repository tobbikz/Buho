import { Store } from '../packages/store/src/index.ts';

const url = process.env['BUHO_STORE_URL'];
if (!url) {
  console.error('BUHO_STORE_URL required');
  process.exit(2);
}

const store = new Store(url);
const ids = await (store as unknown as { pool: { query: Function } }).pool.query(
  `select instance_id::text, alias from buho.instances order by instance_id`,
);

for (const row of ids.rows as Array<{ instance_id: string; alias: string }>) {
  const id = Number(row.instance_id);
  const latest = await (store as unknown as { pool: { query: Function } }).pool.query(
    `select distinct on (check_id, coalesce(object, ''))
            check_id, title, severity, object, message, remediation, value
       from buho.check_results
      where instance_id = $1
      order by check_id, coalesce(object, ''), ts desc`,
    [id],
  );
  const results = (latest.rows as Array<Record<string, unknown>>).map((r) => ({
    checkId: String(r['check_id']),
    title: String(r['title']),
    severity: r['severity'] as 'critical' | 'warning' | 'info',
    object: (r['object'] as string | null) ?? undefined,
    message: String(r['message']),
    remediation: String(r['remediation']),
    value: (r['value'] as number | null) ?? undefined,
  }));
  const summary = await store.reconcileAlerts(id, results);
  console.log(`${row.alias}: ${results.length} findings →`, summary);
}

await store.close();
