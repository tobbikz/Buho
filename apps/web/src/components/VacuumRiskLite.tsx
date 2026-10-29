import Link from 'next/link';
import { getVacuumTables } from '@/lib/vacuum';

/** Top dead-tuple / bloat tables for Blame — PG vacuum health at a glance. */
export async function VacuumRiskLite({ instanceId }: { instanceId: number }) {
  const tables = await getVacuumTables(instanceId, 'muertas', 6).catch(() => []);
  const risky = tables.filter((t) => {
    const freeze = Math.max(t.xidPct ?? 0, t.mxidPct ?? 0);
    return (t.deadPct ?? 0) >= 5 || (t.bloatPct ?? 0) >= 20 || freeze >= 50;
  });

  if (risky.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Vacuum / bloat</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No high dead-tuple or bloat tables in the latest vacuum snapshot.{' '}
          <Link className="underline" href={`/instances/${instanceId}/vacuum`}>
            Vacuum
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Vacuum / bloat</span>
        <Link className="text-[12px] underline" href={`/instances/${instanceId}/vacuum`}>
          Full view
        </Link>
      </div>
      <div className="overflow-x-auto px-4 pb-4">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-foreground-secondary">
              <th className="py-1 pr-2 font-medium">table</th>
              <th className="py-1 pr-2 font-medium">dead%</th>
              <th className="py-1 pr-2 font-medium">bloat%</th>
              <th className="py-1 pr-2 font-medium">xid%</th>
            </tr>
          </thead>
          <tbody>
            {risky.map((t) => {
              const freeze = Math.max(t.xidPct ?? 0, t.mxidPct ?? 0);
              return (
              <tr key={`${t.schema}.${t.table}`} className="border-b border-border/60 font-mono text-[12px]">
                <td className="py-1.5 pr-2">
                  {t.schema}.{t.table}
                </td>
                <td className="py-1.5 pr-2">{t.deadPct != null ? t.deadPct.toFixed(1) : '—'}</td>
                <td className="py-1.5 pr-2">{t.bloatPct != null ? t.bloatPct.toFixed(1) : '—'}</td>
                <td className="py-1.5 pr-2">{freeze > 0 ? freeze.toFixed(0) : '—'}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
