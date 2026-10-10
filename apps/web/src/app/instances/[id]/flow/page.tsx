import { notFound } from 'next/navigation';
import Link from 'next/link';
import { OperationBars } from '@/components/FlowSankey';
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
    calor?: string;
    cv?: string;
    agg?: string;
  }>;
}) {
  const { id } = await params;
  const { peso, v, calor, cv, agg } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const heatOption = HEAT_OPTIONS.find((entrada) => entrada.key === calor) ?? HEAT_OPTIONS[0]!;
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

  const escriturasContadas = counters.reduce(
    (suma, fila) => suma + fila.inserted + fila.updated + fila.deleted,
    0,
  );
  const escriturasAtribuidas = flow.writeTotal;
  const lecturasAtribuidas = flow.readTotal;
  const hotTables = [...flow.tables].sort((a, b) => pesoTabla(b) - pesoTabla(a));
  const weightSum = hotTables.reduce((suma, tabla) => suma + pesoTabla(tabla), 0);

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
            <h1 className="page-title">Flow · {instance.alias}</h1>
            <p className="page-sub">
              Which tables are taking the heat in this window — by rows, time, or calls. Attribution is
              approximate (from query text)
              {engine === 'postgres'
                ? '; PostgreSQL table counters below are the ground truth when they disagree.'
                : '.'}{' '}
              Full catalog map:{' '}
              <Link href={`/instances/${instanceId}/orm`} className="underline">
                ORM
              </Link>
              .
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Write heat"
            value={formato(escriturasAtribuidas)}
            hint={`attributed · ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Read heat"
            value={formato(lecturasAtribuidas)}
            hint={`attributed · ${window.label}`}
          />
          <StatCard
            label="Hot tables"
            value={formatNumber(flow.tables.length)}
            hint="with attributed traffic"
          />
          <StatCard
            label="Attribution coverage"
            value={formatPct(cobertura, 0)}
            hint={`${formatNumber(flow.attributed)} / ${formatNumber(flow.statements)} queries`}
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
        </div>

        {flow.catalogGated ? (
          <div className="notice">
            <strong>Catalog-gated attribution.</strong> Crowns and heat only include tables inventoried on
            this instance
            {flow.droppedOutsideCatalog > 0
              ? ` · ${formatNumber(flow.droppedOutsideCatalog)} lexical hit(s) outside the catalog were dropped (query-text guesses from other schemas/DBs).`
              : ' · no foreign-schema guesses in this window.'}
          </div>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Where traffic lands · writes &amp; reads</span>
            <div className="flex flex-wrap items-center gap-1">
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
            {flow.tables.length === 0 ? (
              <div className="empty">
                {flow.statements === 0
                  ? escriturasContadas > 0
                    ? engine === 'postgres'
                      ? 'Counters see writes but no query was recorded in pg_stat_statements. Often intentional exclusion: Búho tags monitor queries and does not attribute them.'
                      : engine === 'mariadb'
                        ? 'Counters see activity but no digest was recorded in performance_schema. Often intentional exclusion: Búho tags monitor queries and does not attribute them.'
                        : 'Counters see activity but no query text was recorded for attribution in this window.'
                    : "No application queries in the window. Búho's own queries do not count, so an instance that only receives monitoring looks empty here."
                  : weight === 'rows' && engine === 'mssql'
                    ? 'SQL Server does not count rows modified per query, so weighting writes by rows is zero. Try "Time" or "Calls".'
                    : weight === 'rows' && engine === 'mariadb'
                      ? 'MariaDB digests often report zero rows affected, so weighting by rows is empty even when time and calls are not. Try "Time" or "Calls".'
                      : 'No traffic could be attributed to a table in this window.'}
              </div>
            ) : (
              <LiveFlow
                scope="instancia"
                instanceId={instanceId}
                weight={weight}
                unit={unidad}
                height={520}
                animated
                windowMinutes={window.minutes}
              />
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              Green = writes, blue = reads. Live motion on by default (slower for 60 Hz); use Static / Zoom in the
              map toolbar. Coverage {formatPct(cobertura, 0)} — the rest could not be pinned to a table from the
              statement text.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">Hottest tables</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                by {weight} · {window.label}
              </span>
            </div>
            <div className="panel-body">
              {hotTables.length === 0 ? (
                <div className="empty">No attributed tables in the window.</div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '22rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Table</th>
                        <th className="text-right">Write</th>
                        <th className="text-right">Read</th>
                        <th className="text-right">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hotTables.slice(0, 25).map((tabla, index) => {
                        const peso = pesoTabla(tabla);
                        return (
                          <tr key={tabla.relation}>
                            <td className="num text-foreground-muted">{index + 1}</td>
                            <td className="font-mono text-[11px]">{tabla.relation}</td>
                            <td className="num">{formato(tabla.writeWeight ?? 0)}</td>
                            <td className="num">{formato(tabla.readWeight ?? 0)}</td>
                            <td className="num">
                              {weightSum > 0 ? formatPct((peso / weightSum) * 100, 1) : '·'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="panel xl:col-span-1">
            <div className="panel-header">
              <span className="panel-title">Traffic mix</span>
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
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {engine === 'postgres'
                ? 'Engine counters (ground truth)'
                : 'Contrast with engine counters'}
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">window {window.label}</span>
          </div>
          <div className="panel-body">
            {engine !== 'postgres' ? (
              <div className="empty">
                {engine === 'mariadb'
                  ? 'MariaDB has no per-table insert/update/delete counters in this view, so the diagram is the only source and its attribution is approximate.'
                  : engine === 'mssql'
                    ? 'SQL Server has no per-table insert/update/delete counters in this view, so the diagram is the only source and its attribution is approximate.'
                    : engine === 'oracle'
                      ? 'Oracle has no per-table insert/update/delete counters in this view, so the diagram is the only source and its attribution is approximate.'
                      : 'This engine has no per-table row counters for contrast, so the diagram is the only source and its attribution is approximate.'}
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
                      <th className="text-right">Seq scan</th>
                      <th className="text-right">Idx scan</th>
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
            {engine === 'postgres' && counters.length > 0 && (
              <p className="mt-2 text-[11px] text-foreground-muted">
                These do not depend on parsing SQL. If they disagree with the map above, trust them — attribution is
                lost with triggers, FK cascades, and statements that left{' '}
                <span className="font-mono">pg_stat_statements</span>. HOT below 50% usually means updates are
                rewriting indexes.
              </p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">When it is used · {heatOption.label}</span>
            <div className="flex flex-wrap items-center gap-1">
              {HEAT_OPTIONS.map((opcion) => (
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

          <div className="panel-body">
            {heat.cells.length === 0 ? (
              <div className="empty">
                No hourly rollups yet for {heatOption.label.toLowerCase()}. The first appears in the hour you start
                the collector.
              </div>
            ) : (
              <>
                <Heatmap cells={heat.cells} max={heat.max} unit={unidadCalor} minSamples={2} />
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
                          ; quietest is{' '}
                          <strong>
                            {WEEKDAY_LABEL[tranquila.weekday]} at{' '}
                            {String(tranquila.hour).padStart(2, '0')}:00
                          </strong>{' '}
                          with {formatoCalor(tranquila.value)} — a maintenance window candidate
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
    </>
  );
}
