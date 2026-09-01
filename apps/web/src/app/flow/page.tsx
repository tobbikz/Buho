import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FlowSankey, OperationBars } from '@/components/FlowSankey';
import { LiveFlow } from '@/components/LiveFlow';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber, formatPct } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
import { getFleetFlow } from '@/lib/fleet-flow';
import type { FlowActor, FlowDirection } from '@/lib/flow';
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
  searchParams: Promise<{ peso?: string; v?: string; dir?: string; quien?: string; vista?: string }>;
}) {
  const { peso, v, dir, quien, vista } = await searchParams;

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const direction: FlowDirection = dir === 'lectura' ? 'lectura' : 'escritura';
  const actor: FlowActor = quien === 'aplicacion' ? 'aplicacion' : 'rol';
  const enVivo = vista !== 'acumulado';

  let flow;
  try {
    flow = await getFleetFlow(window.minutes, weight, direction, actor);
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
      dir: direction,
      quien: actor,
      vista: enVivo ? 'vivo' : 'acumulado',
      ...cambios,
    });
    return `/flow?${parametros.toString()}`;
  };

  const total = flow.tables.reduce((suma, tabla) => suma + tabla.weight, 0);
  const primera = flow.tables[0];
  // La concentración es la lectura más accionable de esta pantalla: si una sola
  // tabla del parque se lleva la mitad del tráfico, ahí empieza cualquier
  // trabajo de rendimiento.
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
              The same traffic diagram, but for every server at once: which estate table gets the most
              {direction === 'escritura' ? ' write' : ' read'} traffic, and which instance it is on. Attribution comes from
              reading each query's text, so it is <strong>approximate</strong>; per-table detail and
              contraste con los contadores están en la pantalla de cada instancia.
            </p>
          </div>
          <AutoRefresh intervalMs={60000} />
        </header>

        <div className="stat-grid">
          <StatCard
            label={direction === 'escritura' ? 'Rows written' : 'Rows read'}
            value={formatUnit(total, unidad)}
            hint={`whole estate, window ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Hottest table"
            value={primera ? formatPct(concentracion, 0) : '·'}
            hint={primera ? `${primera.relation} en ${primera.alias}` : 'no attributed traffic'}
            tone={concentracion >= 50 ? 'warn' : 'neutral'}
          />
          <StatCard
            label="Instances with traffic"
            value={`${formatNumber(flow.withTraffic)} / ${formatNumber(flow.instances)}`}
            hint="the rest attributed nothing"
          />
          <StatCard
            label="Attributed weight"
            value={formatPct(cobertura, 0)}
            hint="of the total the engine measured"
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              Instancia → esquema → tabla · {direction === 'escritura' ? 'escrituras' : 'lecturas'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <Link
                href={enlace({ vista: 'vivo' })}
                className={`tag ${enVivo ? 'tag--ok' : 'tag--muted'}`}
                title="what is moving now across the estate"
              >
                en vivo
              </Link>
              <Link
                href={enlace({ vista: 'acumulado' })}
                className={`tag ${enVivo ? 'tag--muted' : 'tag--info'}`}
              >
                acumulado
              </Link>
              <span className="mx-1 text-foreground-muted">·</span>
              {(['rol', 'aplicacion'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ quien: opcion })}
                  className={`tag ${opcion === actor ? 'tag--info' : 'tag--muted'}`}
                  title={
                    opcion === 'rol'
                      ? 'exact: pg_stat_statements stores the role'
                      : 'estimated by sampling pg_stat_activity'
                  }
                >
                  por {opcion}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {(['escritura', 'lectura'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ dir: opcion })}
                  className={`tag ${opcion === direction ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion}
                </Link>
              ))}
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
              <LiveFlow
                scope="flota"
                weight={weight}
                direction={direction}
                actor={actor}
                unit={unidad}
                height={460}
              />
            ) : (
            <FlowSankey
              nodes={flow.nodes}
              links={flow.links}
              unit={unidad}
              height={460}
              emptyMessage={
                direction === 'escritura'
                  ? 'No estate writes could be attributed to a table in this window. If databases are read-only, try "lectura".'
                  : 'No estate reads could be attributed to a table in this window.'
              }
            />
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              El esquema va calificado por instancia: dos servidores pueden tener cada uno su{' '}
              <span className="font-mono">public</span>, and merging them would fuse traffic from machines into one ribbon
              distintas. Cada instancia se calcula con el esquema por omisión de su motor, que no es el mismo en los
              tres.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">Hottest tables in the estate</span>
              <span className="font-mono text-[10px] text-foreground-muted">window {window.label}</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">No attributed tables in the window.</div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '26rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tabla</th>
                        <th>Instancia</th>
                        <th className="text-right">Peso</th>
                        <th className="text-right">From the estate</th>
                        <th>{actor === 'rol' ? 'Roles' : 'Aplicaciones'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flow.tables.map((tabla) => (
                        <tr key={`${tabla.instanceId}-${tabla.relation}`}>
                          <td className="font-mono text-[11px]">{tabla.relation}</td>
                          <td>
                            <Link href={`/instances/${tabla.instanceId}/flow`} className="link">
                              {tabla.alias}
                            </Link>
                            <span className="ml-1 text-[10px] text-foreground-muted">
                              {ENGINE_LABEL[tabla.engine] ?? tabla.engine}
                            </span>
                          </td>
                          <td className="num">{formatUnit(tabla.weight, unidad)}</td>
                          <td className="num">
                            {total > 0 ? formatPct((tabla.weight / total) * 100, 1) : '·'}
                          </td>
                          <td className="text-[11px] text-foreground-muted">
                            {tabla.actors.slice(0, 3).join(', ')}
                            {tabla.actors.length > 3 ? ` +${tabla.actors.length - 3}` : ''}
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
              <span className="panel-title">What kind of traffic</span>
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
              <span className="panel-title">Instances that contributed nothing</span>
            </div>
            <div className="panel-body">
              {/* Se listan a propósito: una instancia ausente del diagrama por
                  falta de datos y una sin tráfico se ven igual, y no son lo
                  mismo. Decir cuántas consultas vio cada una separa los casos. */}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instancia</th>
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
                          ? 'no query statistics: either no application traffic, or pg_stat_statements is missing'
                          : direction === 'escritura'
                            ? 'there are queries but none write to an identifiable table'
                            : 'there are queries but none read from an identifiable table'}
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
