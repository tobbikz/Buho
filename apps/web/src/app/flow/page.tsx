import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FlowSankey, OperationBars } from '@/components/FlowSankey';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber, formatPct } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
import { getFleetFlow } from '@/lib/fleet-flow';
import type { FlowActor, FlowDirection } from '@/lib/flow';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Flujo del parque · Búho' };

const WEIGHTS: { key: FlowWeight; label: string; hint: string }[] = [
  { key: 'rows', label: 'Filas', hint: 'dónde cae el volumen de datos' },
  { key: 'time', label: 'Tiempo', hint: 'dónde se gasta el servidor' },
  { key: 'calls', label: 'Llamadas', hint: 'qué se llama más veces' },
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
  searchParams: Promise<{ peso?: string; v?: string; dir?: string; quien?: string }>;
}) {
  const { peso, v, dir, quien } = await searchParams;

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const direction: FlowDirection = dir === 'lectura' ? 'lectura' : 'escritura';
  const actor: FlowActor = quien === 'aplicacion' ? 'aplicacion' : 'rol';

  let flow;
  try {
    flow = await getFleetFlow(window.minutes, weight, direction, actor);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Flujo' }]} />
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
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Flujo del parque' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Flujo del parque</h1>
            <p className="page-sub">
              El mismo diagrama de tráfico, pero de todos los servidores a la vez: qué tabla del parque recibe más
              {direction === 'escritura' ? ' escritura' : ' lectura'}, y en qué instancia está. La atribución sale de
              leer el texto de cada consulta, así que es <strong>aproximada</strong>; el detalle por tabla y el
              contraste con los contadores están en la pantalla de cada instancia.
            </p>
          </div>
          <AutoRefresh intervalMs={60000} />
        </header>

        <div className="stat-grid">
          <StatCard
            label={direction === 'escritura' ? 'Filas escritas' : 'Filas leídas'}
            value={formatUnit(total, unidad)}
            hint={`todo el parque, ventana ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Tabla más caliente"
            value={primera ? formatPct(concentracion, 0) : '·'}
            hint={primera ? `${primera.relation} en ${primera.alias}` : 'sin tráfico atribuido'}
            tone={concentracion >= 50 ? 'warn' : 'neutral'}
          />
          <StatCard
            label="Instancias con tráfico"
            value={`${formatNumber(flow.withTraffic)} / ${formatNumber(flow.instances)}`}
            hint="el resto no atribuyó nada"
          />
          <StatCard
            label="Peso atribuido"
            value={formatPct(cobertura, 0)}
            hint="del total que midió el motor"
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              Instancia → esquema → tabla · {direction === 'escritura' ? 'escrituras' : 'lecturas'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {(['rol', 'aplicacion'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ quien: opcion })}
                  className={`tag ${opcion === actor ? 'tag--info' : 'tag--muted'}`}
                  title={
                    opcion === 'rol'
                      ? 'exacto: pg_stat_statements guarda el rol'
                      : 'estimado por muestreo de pg_stat_activity'
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
            <FlowSankey
              nodes={flow.nodes}
              links={flow.links}
              unit={unidad}
              height={460}
              emptyMessage={
                direction === 'escritura'
                  ? 'Ninguna escritura del parque pudo atribuirse a una tabla en esta ventana. Si las bases sólo se leen, probar con "lectura".'
                  : 'Ninguna lectura del parque pudo atribuirse a una tabla en esta ventana.'
              }
            />
            <p className="mt-2 text-[11px] text-foreground-muted">
              El esquema va calificado por instancia: dos servidores pueden tener cada uno su{' '}
              <span className="font-mono">public</span>, y unirlos fundiría en una sola cinta tráfico de máquinas
              distintas. Cada instancia se calcula con el esquema por omisión de su motor, que no es el mismo en los
              tres.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">Tablas más calientes del parque</span>
              <span className="font-mono text-[10px] text-foreground-muted">ventana {window.label}</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">Sin tablas atribuidas en la ventana.</div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '26rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tabla</th>
                        <th>Instancia</th>
                        <th className="text-right">Peso</th>
                        <th className="text-right">Del parque</th>
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
              <span className="panel-title">Qué clase de tráfico</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">Sin datos.</div>
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
              <span className="panel-title">Instancias que no aportaron nada</span>
            </div>
            <div className="panel-body">
              {/* Se listan a propósito: una instancia ausente del diagrama por
                  falta de datos y una sin tráfico se ven igual, y no son lo
                  mismo. Decir cuántas consultas vio cada una separa los casos. */}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instancia</th>
                    <th>Motor</th>
                    <th className="text-right">Consultas vistas</th>
                    <th>Lectura probable</th>
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
                          ? 'sin estadísticas de consultas: o no llega tráfico de aplicación, o falta pg_stat_statements'
                          : direction === 'escritura'
                            ? 'hay consultas pero ninguna escribe en una tabla identificable'
                            : 'hay consultas pero ninguna lee de una tabla identificable'}
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
