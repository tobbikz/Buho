import Link from 'next/link';
import { OperationBars } from '@/components/FlowSankey';
import { LiveFlow } from '@/components/LiveFlow';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber, formatPct } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
import { getFleetFlow } from '@/lib/fleet-flow';
import { listScopeChoices, scopeEngines } from '@/lib/fleet-scope';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Estate flow · Búho' };

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

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
};

export default async function FleetFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ peso?: string; v?: string }>;
}) {
  const { peso, v } = await searchParams;

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;

  let flow;
  let choices: Awaited<ReturnType<typeof listScopeChoices>> = [];
  try {
    [flow, choices] = await Promise.all([
      getFleetFlow(window.minutes, weight, 20, {
        engine: engine || undefined,
        alias: conn || undefined,
      }),
      listScopeChoices(),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Flow' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const unidad: Unit = weight === 'time' ? 'ms' : 'count';
  const enlace = (cambios: Record<string, string>) => {
    const parametros = new URLSearchParams({
      peso: weight,
      v: window.key,
      ...cambios,
    });
    return `/flow?${parametros.toString()}`;
  };

  const total = flow.tables.reduce((suma, tabla) => suma + tabla.weight, 0);
  const primera = flow.tables[0];
  const concentracion = total > 0 && primera ? (primera.weight / total) * 100 : 0;
  const cobertura = flow.weightTotal > 0 ? (flow.weightAttributed / flow.weightTotal) * 100 : 0;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Estate flow' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Estate flow</h1>
            <p className="page-sub">
              Hot tables across the fleet in this window — which servers and tables take the heat. Attribution is
              approximate (from query text). Per-instance detail:{' '}
              <Link href="/" className="underline">
                open an instance → Flow
              </Link>
              .
            </p>
          </div>
        </header>

        <FleetScopeFilters
          engines={scopeEngines(choices)}
          instances={choices}
          engine={engine}
          conn={conn}
          preserve={{ peso: weight, v: window.key, vista: enVivo ? 'vivo' : 'acumulado' }}
        />

        <div className="stat-grid">
          <StatCard
            label="Write heat"
            value={formatUnit(flow.writeTotal, unidad)}
            hint={`estate · ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Read heat"
            value={formatUnit(flow.readTotal, unidad)}
            hint={`estate · ${window.label}`}
          />
          <StatCard
            label="Hottest table"
            value={primera ? formatPct(concentracion, 0) : '·'}
            hint={primera ? `${primera.relation} on ${primera.alias}` : 'no attributed traffic'}
            tone={concentracion >= 50 ? 'warn' : 'neutral'}
          />
          <StatCard
            label="Attribution coverage"
            value={formatPct(cobertura, 0)}
            hint={`${formatNumber(flow.withTraffic)} / ${formatNumber(flow.instances)} instances with traffic`}
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
        </div>

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
              <div className="empty">No estate traffic could be attributed to a table in this window.</div>
            ) : (
              <LiveFlow
                scope="flota"
                weight={weight}
                unit={unidad}
                height={520}
                animated
                windowMinutes={window.minutes}
              />
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              Green = writes, blue = reads. Live by default (slower particles for 60 Hz); toolbar has Static and
              Zoom. Schemas are per instance — two servers can each have their own{' '}
              <span className="font-mono">public</span>.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">Hottest tables in the estate</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                by {weight} · {window.label}
              </span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">No attributed tables in the window.</div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '26rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Table</th>
                        <th>Instance</th>
                        <th className="text-right">Write</th>
                        <th className="text-right">Read</th>
                        <th className="text-right">Of estate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flow.tables.map((tabla, index) => (
                        <tr key={`${tabla.instanceId}-${tabla.relation}`}>
                          <td className="num text-foreground-muted">{index + 1}</td>
                          <td className="font-mono text-[11px]">{tabla.relation}</td>
                          <td>
                            <Link href={`/instances/${tabla.instanceId}/flow`} className="link">
                              {tabla.alias}
                            </Link>
                            <span className="ml-1 text-[10px] text-foreground-muted">
                              {ENGINE_LABEL[tabla.engine] ?? tabla.engine}
                            </span>
                          </td>
                          <td className="num">{formatUnit(tabla.writeWeight, unidad)}</td>
                          <td className="num">{formatUnit(tabla.readWeight, unidad)}</td>
                          <td className="num">
                            {total > 0 ? formatPct((tabla.weight / total) * 100, 1) : '·'}
                          </td>
                        </tr>
                      ))}
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
                <div className="empty">No data.</div>
              ) : (
                <OperationBars
                  rows={flow.tables.slice(0, 10).map((tabla) => ({
                    relation: `${tabla.alias}·${tabla.relation}`,
                    byOperation: tabla.byOperation,
                    total: tabla.weight,
                  }))}
                  unit={unidad}
                />
              )}
            </div>
          </section>
        </div>

        {flow.silent.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Instances with nothing attributed</span>
            </div>
            <div className="panel-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Engine</th>
                    <th className="text-right">Queries seen</th>
                    <th>Likely read</th>
                  </tr>
                </thead>
                <tbody>
                  {flow.silent.map((instancia) => (
                    <tr key={instancia.alias}>
                      <td>{instancia.alias}</td>
                      <td>{ENGINE_LABEL[instancia.engine] ?? instancia.engine}</td>
                      <td className="num">{formatNumber(instancia.statements)}</td>
                      <td className="text-[11px] text-foreground-muted">
                        {instancia.statements === 0
                          ? 'no query statistics, or no application traffic'
                          : 'queries seen but none pinned to a table'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
