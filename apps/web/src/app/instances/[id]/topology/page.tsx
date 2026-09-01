import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import {
  diffTopologyWeeks,
  getTopologyWeek,
  listTopologyWeeks,
  snapshotTopologyWeek,
  weekStartOf,
} from '@/lib/topology';

export const dynamic = 'force-dynamic';

export default async function TopologyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ d?: string; snap?: string }>;
}) {
  const { id } = await params;
  const { d, snap } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  const direction = d === 'lectura' ? 'lectura' : 'escritura';

  let instance;
  let weeks: Date[];
  let current;
  let previous;
  let diff;
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();

    // Congelar la semana actual si falta (o si se pide explícitamente).
    weeks = await listTopologyWeeks(instanceId);
    const thisWeek = weekStartOf();
    const hasThis = weeks.some((w) => w.getTime() === thisWeek.getTime());
    if (!hasThis || snap === '1') {
      await snapshotTopologyWeek(instanceId, engine, 'aplicacion');
      weeks = await listTopologyWeeks(instanceId);
    }

    const newer = weeks[0] ?? thisWeek;
    const older = weeks[1] ?? null;
    current = await getTopologyWeek(instanceId, newer, direction);
    previous = older ? await getTopologyWeek(instanceId, older, direction) : null;
    diff = older ? await diffTopologyWeeks(instanceId, newer, older, direction) : null;
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const base = `/instances/${instanceId}/topology`;

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Flota', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Topología' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Topología · {instance.alias}</h1>
            <p className="page-sub">
              Dependencias app ↔ tabla congeladas semana a semana. El flujo vivo sigue en{' '}
              <Link href={`/instances/${instanceId}/flow`} className="underline">
                Flujo
              </Link>
              ; aquí se ve qué cambió entre semanas.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href={`${base}?d=escritura`}
              className={`tag ${direction === 'escritura' ? 'tag--info' : 'tag--muted'}`}
            >
              escritura
            </Link>
            <Link
              href={`${base}?d=lectura`}
              className={`tag ${direction === 'lectura' ? 'tag--info' : 'tag--muted'}`}
            >
              lectura
            </Link>
            <Link href={`${base}?d=${direction}&snap=1`} className="tag tag--muted">
              refrescar semana
            </Link>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        <div className="grid grid-cols-3 gap-[0.875rem]">
          <div className="stat">
            <div className="stat__label">Semana</div>
            <div className="stat__value text-[1rem]">
              {current.weekStart.toLocaleDateString('es')}
            </div>
            <div className="stat__hint">{weeks.length} semana(s) guardada(s)</div>
          </div>
          <div className="stat">
            <div className="stat__label">Aplicaciones</div>
            <div className="stat__value">{formatNumber(current.actors, 0)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Tablas</div>
            <div className="stat__value">{formatNumber(current.tables, 0)}</div>
          </div>
        </div>

        {diff && (
          <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
            <div className="panel-header">
              <span className="panel-title">Cambio vs. semana anterior</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {previous?.weekStart.toLocaleDateString('es') ?? '—'}
              </span>
            </div>
            <div className="panel-body grid grid-cols-1 gap-3 text-[12px] xl:grid-cols-3">
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  Nuevas ({diff.added.length})
                </div>
                {diff.added.length === 0 ? (
                  <p className="text-foreground-muted">Ninguna.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.added.slice(0, 8).map((e) => (
                      <li key={`${e.actor}-${e.relation}`}>
                        {e.actor} → {e.schemaName}.{e.relation.split('.').slice(1).join('.') || e.relation}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  Desaparecidas ({diff.removed.length})
                </div>
                {diff.removed.length === 0 ? (
                  <p className="text-foreground-muted">Ninguna.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.removed.slice(0, 8).map((e) => (
                      <li key={`${e.actor}-${e.relation}`}>
                        {e.actor} → {e.schemaName}.{e.relation.split('.').slice(1).join('.') || e.relation}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  Creció ≥2× ({diff.grown.length})
                </div>
                {diff.grown.length === 0 ? (
                  <p className="text-foreground-muted">Ninguna.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.grown.slice(0, 8).map((g) => (
                      <li key={`${g.edge.actor}-${g.edge.relation}`}>
                        {g.edge.actor} →{' '}
                        {g.edge.relation.split('.').slice(1).join('.') || g.edge.relation}{' '}
                        <span className="text-foreground-muted">×{g.ratio.toFixed(1)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Aristas de esta semana ({direction})</span>
          </div>
          {current.edges.length === 0 ? (
            <div className="empty" style={{ height: 120 }}>
              Sin aristas todavía. Hace falta tráfico en statement_stats y un refresco.
            </div>
          ) : (
            <div className="panel-body overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="font-semibold uppercase tracking-wide text-foreground-muted">
                  <tr>
                    <th className="pb-2 pr-3">App</th>
                    <th className="pb-2 pr-3">Tabla</th>
                    <th className="pb-2 pr-3 text-right">Peso (ms)</th>
                    <th className="pb-2 text-right">Muestras</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {current.edges.slice(0, 60).map((e) => (
                    <tr key={`${e.actor}|${e.relation}`} className="border-t border-[var(--border)]">
                      <td className="py-1.5 pr-3">{e.actor}</td>
                      <td className="py-1.5 pr-3">
                        {e.schemaName}.{e.relation.split('.').slice(1).join('.') || e.relation}
                      </td>
                      <td className="py-1.5 pr-3 text-right">{formatNumber(e.weight, 0)}</td>
                      <td className="py-1.5 text-right">{formatNumber(e.samples, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
