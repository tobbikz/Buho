import { notFound } from 'next/navigation';
import Link from 'next/link';
import { FlowSankey, OperationBars } from '@/components/FlowSankey';
import { LiveFlow } from '@/components/LiveFlow';
import { Heatmap } from '@/components/Heatmap';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber, formatPct } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getFlow, getTableCounters } from '@/lib/flow';
import {
  busiestHour,
  getHeatmap,
  quietestHour,
  HEAT_OPTIONS,
  WEEKDAY_LABEL,
  type HeatAgg,
} from '@/lib/heatmap';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';

const WEIGHTS: { key: FlowWeight; label: string; hint: string }[] = [
  { key: 'rows', label: 'Rows', hint: 'where data volume lands' },
  { key: 'time', label: 'Time', hint: 'where the server spends time' },
  { key: 'calls', label: 'Calls', hint: 'what is called most often' },
];

const WINDOWS: { key: string; label: string; minutes: number }[] = [
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '6h', label: '6 h', minutes: 360 },
  { key: '24h', label: '24 h', minutes: 1440 },
  { key: '7d', label: '7 d', minutes: 10080 },
];

const HEAT_WINDOWS: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '365d', label: '1 year', days: 365 },
];

/** La unidad del peso elegido: el tiempo viene en milisegundos, el resto son cuentas. */
function unitFor(weight: FlowWeight): Unit {
  return weight === 'time' ? 'ms' : 'count';
}

export default async function FlowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    peso?: string;
    v?: string;
    vista?: string;
    calor?: string;
    cv?: string;
    agg?: string;
  }>;
}) {
  const { id } = await params;
  const { peso, v, vista, calor, cv, agg } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const enVivo = vista === 'vivo';
  const heatChoices =
    engine === 'postgres' ? HEAT_OPTIONS.filter((option) => option.key !== 'batch') : HEAT_OPTIONS;
  const heatOption = heatChoices.find((entrada) => entrada.key === calor) ?? heatChoices[0]!;
  const heatWindow = HEAT_WINDOWS.find((entrada) => entrada.key === cv) ?? HEAT_WINDOWS[1]!;
  const heatAgg: HeatAgg = agg === 'max' ? 'max' : 'avg';

  let instance;
  let flow: Awaited<ReturnType<typeof getFlow>>;
  let counters: Awaited<ReturnType<typeof getTableCounters>>;
  let heat: Awaited<ReturnType<typeof getHeatmap>>;
  try {
    [instance, flow, counters, heat] = await Promise.all([
      getInstance(instanceId),
      getFlow(instanceId, window.minutes, weight, 'both', engine, 'aplicacion', 14),
      getTableCounters(instanceId, window.minutes),
      getHeatmap(instanceId, heatOption, heatWindow.days, heatAgg),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Flow' },
  ];

  const enlace = (cambios: Record<string, string>) => {
    const parametros = new URLSearchParams({
      peso: weight,
      v: window.key,
      vista: enVivo ? 'vivo' : 'acumulado',
      calor: heatOption.key,
      cv: heatWindow.key,
      agg: heatAgg,
      ...cambios,
    });
    return `/instances/${instanceId}/flow?${parametros.toString()}`;
  };

  const unidad = unitFor(weight);
  const formato = (valor: number): string => formatUnit(valor, unidad);
  const pesoTabla = (tabla: (typeof flow.tables)[number]): number =>
    weight === 'calls' ? tabla.calls : weight === 'time' ? tabla.execMs : tabla.rows;

  const cobertura =
    flow.weightTotal > 0 ? (flow.weightAttributed / flow.weightTotal) * 100 : 0;

  // Los contadores del propio PostgreSQL, para contrastar la atribución.
  const escriturasContadas = counters.reduce(
    (suma, fila) => suma + fila.inserted + fila.updated + fila.deleted,
    0,
  );
  const escriturasAtribuidas = flow.writeTotal;
  const lecturasAtribuidas = flow.readTotal;

  const tranquila = quietestHour(heat, 2);
  const cargada = busiestHour(heat, 2);
  const unidadCalor: Unit = heatOption.unit === 'rate' ? 'rate' : 'count';
  const formatoCalor = (valor: number): string => formatUnit(valor, unidadCalor);

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Flow and usage · {instance.alias}</h1>
            <p className="page-sub">
              Where traffic enters and where it lands. <strong>Writes</strong> and <strong>Reads</strong> are the two
              entry points, then schema, then table. Diagram attribution is <strong>approximate</strong> — it comes
              from reading each query&apos;s text
              {engine === 'postgres'
                ? ', and PostgreSQL counters are below for contrast. For the full catalog map, see the ORM tab.'
                : '.'}{' '}
              <Link href="/design-lab/flow" className="underline">
                Design lab
              </Link>
              : polish packs for this layout.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Write heat"
            value={formato(escriturasAtribuidas)}
            hint={`attributed, window ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Read heat"
            value={formato(lecturasAtribuidas)}
            hint={`attributed, window ${window.label}`}
          />
          <StatCard
            label="Tables with traffic"
            value={formatNumber(flow.tables.length)}
            hint="touched by some query"
          />
          <StatCard
            label="Attributed queries"
            value={`${formatNumber(flow.attributed)} / ${formatNumber(flow.statements)}`}
            hint={`${formatPct(cobertura, 0)} of total weight`}
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
        </div>

        <div className="grid grid-cols-1 items-stretch gap-[0.875rem] xl:grid-cols-4">
        <section className="panel flex h-full flex-col xl:col-span-3">
          <div className="panel-header">
            <span className="panel-title">Hot tables · writes &amp; reads</span>
            <div className="flex flex-wrap items-center gap-1">
              <Link
                href={enlace({ vista: 'vivo' })}
                className={`tag ${enVivo ? 'tag--ok' : 'tag--muted'}`}
                title="what is moving now, last 5 minutes"
              >
                Live
              </Link>
              <Link
                href={enlace({ vista: 'acumulado' })}
                className={`tag ${enVivo ? 'tag--muted' : 'tag--info'}`}
                title="total for the selected window"
              >
                Accumulated
              </Link>
              <span className="mx-1 text-foreground-muted">·</span>
              {WEIGHTS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ peso: opcion.key })}
                  className={`tag ${opcion.key === weight ? 'tag--info' : 'tag--muted'}`}
                  title={opcion.hint}
                >
                  {opcion.label}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {WINDOWS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ v: opcion.key })}
                  className={`tag ${opcion.key === window.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="panel-body">
            {enVivo ? (
              <LiveFlow scope="instancia" instanceId={instanceId} weight={weight} unit={unidad} />
            ) : (
            <FlowSankey
              nodes={flow.nodes}
              links={flow.links}
              unit={unidad}
              emptyMessage={
                flow.statements === 0
                  ? escriturasContadas > 0
                    ? 'Counters see writes but no query was recorded in pg_stat_statements. Often intentional exclusion: Búho tags monitor queries and does not attribute them.'
                    : "No application queries in the window. Búho's own queries do not count, so an instance that only receives monitoring looks empty here."
                  : weight === 'rows' && engine === 'mssql'
                    ? 'SQL Server does not count rows modified per query, so weighting writes by rows is zero. Try "Time" or "Calls".'
                    : 'No traffic could be attributed to a table in this window.'
              }
            />
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              Green bands are writes, blue bands are reads. When a query touches several tables, its weight is split
              across them. System schemas are excluded. For the full database catalog, open the{' '}
              <Link href={`/instances/${instanceId}/orm`} className="underline">
                ORM
              </Link>{' '}
              tab.
            </p>
          </div>
        </section>

        <section className="panel flex h-full min-h-0 flex-col xl:col-span-1">
          <div className="panel-header">
            <span className="panel-title">When it is used · {heatOption.label}</span>
            <div className="flex flex-wrap items-center gap-1">
              {heatChoices.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ calor: opcion.key })}
                  className={`tag ${opcion.key === heatOption.key ? 'tag--info' : 'tag--muted'}`}
                  title={opcion.hint}
                >
                  {opcion.label}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {(['avg', 'max'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ agg: opcion })}
                  className={`tag ${opcion === heatAgg ? 'tag--info' : 'tag--muted'}`}
                  title={opcion === 'avg' ? 'what a typical hour looks like' : 'how bad it ever got at that hour'}
                >
                  {opcion === 'avg' ? 'typical' : 'worst case'}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {HEAT_WINDOWS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ cv: opcion.key })}
                  className={`tag ${opcion.key === heatWindow.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="panel-body flex min-h-0 flex-1 flex-col">
            {heat.cells.length === 0 ? (
              <div className="empty">
                {heatOption.key === 'batch' && engine === 'postgres'
                  ? 'PostgreSQL does not publish Batch Requests/sec. That counter is SQL Server and MariaDB. Transactions and writes are the load on this server.'
                  : `No rollups yet for ${heatOption.label.toLowerCase()}. Five-minute buckets fill this grid; the first cells appear a few minutes after the collector starts.`}
              </div>
            ) : (
              <>
                <Heatmap cells={heat.cells} max={heat.max} unit={unidadCalor} minSamples={2} fill />
                <p className="mt-3 text-[12px]">
                  {cargada && (
                    <>
                      Busiest hour is{' '}
                      <strong>
                        {WEEKDAY_LABEL[cargada.weekday]} at {String(cargada.hour).padStart(2, '0')}:00
                      </strong>{' '}
                      with {formatoCalor(cargada.value)}
                      {tranquila && (
                        <>
                          , and quietest is{' '}
                          <strong>
                            {WEEKDAY_LABEL[tranquila.weekday]} at {String(tranquila.hour).padStart(2, '0')}:00
                          </strong>{' '}
                          with {formatoCalor(tranquila.value)} — a good maintenance window
                        </>
                      )}
                      .
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </section>
        </div>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          {/* ------------------------------------------------- por operación */}
          <section className="panel xl:col-span-1">
            <div className="panel-header">
              <span className="panel-title">Traffic mix per table</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">No attributed tables in the window.</div>
              ) : (
                <OperationBars
                  rows={flow.tables.map((tabla) => ({
                    relation: tabla.relation,
                    byOperation: tabla.byOperation as Record<string, number | undefined>,
                    total: pesoTabla(tabla),
                  }))}
                  unit={unidad}
                />
              )}
            </div>
          </section>

          {/* ----------------------------------------------- contraste honesto */}
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">
                {engine === 'postgres'
                  ? 'What PostgreSQL counters say'
                  : 'Contrast with engine counters'}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted">window {window.label}</span>
            </div>
            <div className="panel-body">
              {engine !== 'postgres' ? (
                <div className="empty">
                  {engine === 'mariadb' ? 'MariaDB' : 'SQL Server'} does not expose per-table row counters like{' '}
                  <span className="font-mono">pg_stat_user_tables</span>, so there is nothing here to contrast: on
                  this engine the diagram is the only source and its attribution is approximate.
                </div>
              ) : counters.length === 0 ? (
                <div className="empty">
                  No two activity samples per table yet. The collector takes them every minute.
                </div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '20rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Table</th>
                        <th className="text-right">Inserted</th>
                        <th className="text-right">Updated</th>
                        <th className="text-right">HOT</th>
                        <th className="text-right">Deleted</th>
                        <th className="text-right">Sequential</th>
                        <th className="text-right">By index</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counters.slice(0, 20).map((fila) => {
                        const hotPct =
                          fila.updated > 0 ? (fila.hotUpdated / fila.updated) * 100 : null;
                        return (
                          <tr key={fila.relation}>
                            <td className="font-mono text-[11px]">{fila.relation}</td>
                            <td className="num">{formatNumber(Math.round(fila.inserted))}</td>
                            <td className="num">{formatNumber(Math.round(fila.updated))}</td>
                            <td className="num">
                              {hotPct === null ? (
                                '·'
                              ) : (
                                // Por debajo del 50 % de HOT, cada update está
                                // reescribiendo indexs: es la señal más directa
                                // de que sobran indexes en una tabla caliente.
                                <span className={hotPct < 50 ? 'text-[var(--warning)]' : ''}>
                                  {hotPct.toFixed(0)}%
                                </span>
                              )}
                            </td>
                            <td className="num">{formatNumber(Math.round(fila.deleted))}</td>
                            <td className="num">{formatNumber(Math.round(fila.seqScans))}</td>
                            <td className="num">{formatNumber(Math.round(fila.idxScans))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {engine === 'postgres' && (
                <p className="mt-2 text-[11px] text-foreground-muted">
                  These numbers do not depend on parsing any query. If they disagree with the diagram, trust them:
                  attribution is lost with triggers, foreign-key cascades, and queries that fell out of{' '}
                  <span className="font-mono">pg_stat_statements</span>. The HOT column is the share of updates that
                  touched no index.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
