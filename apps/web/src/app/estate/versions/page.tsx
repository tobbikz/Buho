import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo, formatBytes } from '@/lib/format';
import { ENGINE_LABEL, getEngineVersions, type EngineRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Versions · Estate · Búho' };

const DAY_MS = 86_400_000;

/**
 * Días hasta el fin de soporte. Negativo = ya venció.
 *
 * Las fechas salen de una tabla local y no de una API: un despliegue on-prem
 * puede no tener salida a internet, y una herramienta de monitoreo que llama a
 * un servicio externo es lo que hace que seguridad la rechace. El costo es
 * mantener la tabla a mano.
 */
function daysToEol(eolDate: string | null): number | null {
  if (!eolDate) return null;
  return Math.round((new Date(`${eolDate}T00:00:00Z`).getTime() - Date.now()) / DAY_MS);
}

function eolTone(days: number | null): 'error' | 'warn' | 'ok' | 'neutral' {
  if (days === null) return 'neutral';
  if (days < 0) return 'error';
  if (days < 180) return 'warn';
  return 'ok';
}

export default async function VersionsPage() {
  let rows: EngineRow[];
  try {
    rows = await getEngineVersions();
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const expired = rows.filter((row) => (daysToEol(row.eolDate) ?? 1) < 0);
  const expiring = rows.filter((row) => {
    const days = daysToEol(row.eolDate);
    return days !== null && days >= 0 && days < 180;
  });

  // Versiones distintas del mismo motor: una diferencia de parche entre
  // servidores que deberían ser gemelos explica bugs que sólo pasan en uno.
  const spread = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = spread.get(row.engine) ?? new Set<string>();
    set.add(row.versionText);
    spread.set(row.engine, set);
  }
  const mixed = [...spread.entries()].filter(([, versions]) => versions.size > 1);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Out of support"
          value={String(expired.length)}
          hint="no longer receive security patches"
          tone={expired.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Expiring in 6 months"
          value={String(expiring.length)}
          hint="an upgrade needs planning"
          tone={expiring.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Engines with mixed versions"
          value={String(mixed.length)}
          hint="same-engine servers on different versions"
          tone={mixed.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Inventoried instances" value={String(rows.length)} />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Estate versions</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            support end dates from local table · no internet calls
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No inventoried instances yet.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Engine</th>
                  <th>Version</th>
                  <th>Edition</th>
                  <th>Patch</th>
                  <th>End of support</th>
                  <th className="text-right">Days</th>
                  <th>Started</th>
                  <th className="text-right">Cores</th>
                  <th className="text-right">Memory</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const days = daysToEol(row.eolDate);
                  const tone = eolTone(days);
                  return (
                    <tr key={row.instanceId}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                        <div className="font-mono text-[10px] text-foreground-muted">
                          {row.host}:{row.port} · {row.environment}
                        </div>
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {ENGINE_LABEL[row.engine] ?? row.engine}
                      </td>
                      <td className="font-mono text-[11px]">{row.versionText}</td>
                      <td className="text-[11px]">{row.edition ?? '·'}</td>
                      <td className="text-[11px]">{row.updateLevel ?? row.productLevel ?? '·'}</td>
                      <td>
                        {row.eolDate ? (
                          <span
                            className={`tag ${
                              tone === 'error' ? 'tag--error' : tone === 'warn' ? 'tag--warn' : 'tag--ok'
                            }`}
                          >
                            {row.eolDate}
                          </span>
                        ) : (
                          <span className="tag tag--muted">unknown</span>
                        )}
                      </td>
                      <td className="num">
                        {days === null ? '·' : days < 0 ? `${-days}d ago` : days}
                      </td>
                      <td className="text-[11px]">{row.startedAt ? formatAgo(row.startedAt) : '·'}</td>
                      <td className="num">{row.cores ?? '·'}</td>
                      <td className="num">{row.memoryBytes ? formatBytes(row.memoryBytes) : '·'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {mixed.length > 0 && (
        <section className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
          <div className="panel-header">
            <span className="panel-title">Mixed versions</span>
          </div>
          <div className="panel-body flex flex-col gap-2 text-[12px]">
            {mixed.map(([engine, versions]) => (
              <div key={engine}>
                <strong>{ENGINE_LABEL[engine] ?? engine}</strong> runs {versions.size} different versions:{' '}
                <span className="font-mono text-[11px]">{[...versions].join(' · ')}</span>. A patch gap across
                servers that should be twins explains bugs that only happen on one.
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
