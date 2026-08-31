import Link from 'next/link';
import { StatCard, toneForScore } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import type { BackupState } from '@/lib/estate';
import { formatBytes, formatNumber } from '@/lib/format';
import { getWeeklyReport, type ReportInstance, type ReportMetric, type WeeklyReport } from '@/lib/report';

export const dynamic = 'force-dynamic';

const DATE = new Intl.DateTimeFormat('es-CR', { dateStyle: 'long' });
const DATETIME = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' });

const BACKUP_STATE: Record<BackupState, string> = {
  sin_recuperacion: 'sin recuperación',
  atrasado: 'atrasado',
  no_verificable: 'no verificable',
  ok: 'al día',
};

const BACKUP_TAG: Record<BackupState, string> = {
  sin_recuperacion: 'tag--error',
  atrasado: 'tag--warn',
  no_verificable: 'tag--muted',
  ok: 'tag--ok',
};

const BACKUP_KIND: Record<string, string> = {
  full: 'Completo',
  differential: 'Diferencial',
  log: 'Log',
  wal_archive: 'Archivado de WAL',
};

const WEEKS = [
  { key: 0, label: 'Últimos 7 días' },
  { key: 1, label: 'Semana anterior' },
  { key: 2, label: 'Hace dos semanas' },
  { key: 3, label: 'Hace tres semanas' },
];

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} %`;
}

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${value.toFixed(1)} s`;
  if (value < 3600) return `${(value / 60).toFixed(1)} min`;
  return `${(value / 3600).toFixed(1)} h`;
}

/** El delta contra la semana anterior, que es la única lectura que importa. */
function Delta({ metric, digits = 1 }: { metric: ReportMetric | null; digits?: number }) {
  if (!metric || metric.avg === null || metric.prevAvg === null) {
    return <span className="text-foreground-muted">—</span>;
  }
  const diff = metric.avg - metric.prevAvg;
  if (Math.abs(diff) < 0.05) return <span className="text-foreground-muted">igual</span>;
  return (
    <span className="font-mono">
      {diff > 0 ? '+' : '−'}
      {Math.abs(diff).toFixed(digits)}
    </span>
  );
}

function Verdict({ report }: { report: WeeklyReport }) {
  const { totals } = report;
  const trend =
    totals.scoreAvg !== null && totals.scorePrevAvg !== null
      ? totals.scoreAvg - totals.scorePrevAvg
      : null;

  const frases: string[] = [];
  if (totals.critical > 0) {
    frases.push(
      `Hay ${totals.critical} hallazgo${totals.critical === 1 ? '' : 's'} crítico${
        totals.critical === 1 ? '' : 's'
      } abierto${totals.critical === 1 ? '' : 's'} al cierre de la semana`,
    );
  } else if (totals.warning > 0) {
    frases.push(
      `Sin hallazgos críticos; quedan ${totals.warning} advertencia${totals.warning === 1 ? '' : 's'}`,
    );
  } else {
    frases.push('La semana cierra sin hallazgos críticos ni advertencias');
  }

  if (trend !== null) {
    if (Math.abs(trend) < 1) frases.push('la salud del parque se mantuvo estable');
    else if (trend > 0) frases.push(`la salud del parque mejoró ${trend.toFixed(0)} puntos`);
    else frases.push(`la salud del parque cayó ${Math.abs(trend).toFixed(0)} puntos`);
  }
  if (totals.deadlocks > 0) frases.push(totals.deadlocks === 1
        ? 'se registró un deadlock en el log'
        : `se registraron ${totals.deadlocks} deadlocks en el log`);
  if (totals.lockEpisodes > 0) {
    frases.push(totals.lockEpisodes === 1
        ? 'una sesión estuvo esperando un lock'
        : `${totals.lockEpisodes} sesiones estuvieron esperando un lock`);
  }
  if (totals.growthBytes !== null && totals.growthBytes > 0) {
    frases.push(`los datos crecieron ${formatBytes(totals.growthBytes)}`);
  }

  return <p className="text-[13px] leading-relaxed">{frases.join(', ')}.</p>;
}

function InstanceBlock({ row }: { row: ReportInstance }) {
  const growth =
    row.sizeStartBytes !== null && row.sizeEndBytes !== null
      ? row.sizeEndBytes - row.sizeStartBytes
      : null;

  const filas: { label: string; metric: ReportMetric | null; fmt: (v: number | null) => string }[] = [
    { label: 'Conexiones usadas', metric: row.connectionsPct, fmt: (value: number | null) => pct(value) },
    { label: 'Aciertos de caché', metric: row.cacheHitPct, fmt: (value: number | null) => pct(value) },
    { label: 'CPU del host', metric: row.cpuPct, fmt: (value: number | null) => pct(value) },
    { label: 'Memoria del host', metric: row.memPct, fmt: (value: number | null) => pct(value) },
    { label: 'Disco usado', metric: row.diskPct, fmt: (value: number | null) => pct(value) },
    { label: 'Commits por segundo', metric: row.commitsPerSec, fmt: (value: number | null) => formatNumber(value, 1) },
    { label: 'Edad del XID', metric: row.xidAgePct, fmt: (value: number | null) => pct(value) },
    { label: 'Lag de replicación', metric: row.replicationLag, fmt: (value: number | null) => seconds(value) },
  ].filter((fila) => fila.metric && fila.metric.avg !== null);

  const incidentes: string[] = [];
  if (row.lockEpisodes > 0) {
    incidentes.push(
      `${row.lockEpisodes} episodio${row.lockEpisodes === 1 ? '' : 's'} de bloqueo` +
        `${row.lockWorstSeconds === null ? '' : `, el peor esperó ${seconds(row.lockWorstSeconds)}`}`,
    );
  }
  if (row.logAvailable) {
    if (row.logDeadlocks > 0) {
      incidentes.push(
        row.logDeadlocks === 1 ? 'un deadlock en el log' : `${row.logDeadlocks} deadlocks en el log`,
      );
    }
    if (row.logErrors > 0) {
      incidentes.push(
        row.logErrors === 1 ? 'un error en el log' : `${row.logErrors} errores en el log`,
      );
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">
          <Link href={`/instances/${row.instanceId}`} className="underline">
            {row.alias}
          </Link>
        </span>
        <span className="font-mono text-[10.5px] text-foreground-muted">
          {row.environment} · {row.engine}
          {row.scoreEnd !== null && ` · salud ${row.scoreEnd}`}
          {row.scoreStart !== null &&
            row.scoreEnd !== null &&
            row.scoreStart !== row.scoreEnd &&
            ` (abrió en ${row.scoreStart})`}
        </span>
      </div>

      <div className="panel-body space-y-3">
        {row.coveragePct !== null && row.coveragePct < 95 && (
          <p className="notice notice--warn text-[12px]">
            El monitoreo cubrió {pct(row.coveragePct, 0)} de las horas de la semana. Los promedios
            excluyen las horas sin muestras.
          </p>
        )}

        {filas.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th className="text-right">Promedio</th>
                  <th className="text-right">Pico</th>
                  <th className="text-right">Semana anterior</th>
                  <th className="text-right">Cambio</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((fila) => (
                  <tr key={fila.label}>
                    <td>{fila.label}</td>
                    <td className="text-right font-mono">{fila.fmt(fila.metric!.avg)}</td>
                    <td className="text-right font-mono">{fila.fmt(fila.metric!.max)}</td>
                    <td className="text-right font-mono text-foreground-secondary">
                      {fila.fmt(fila.metric!.prevAvg)}
                    </td>
                    <td className="text-right">
                      <Delta metric={fila.metric} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No hay muestras de esta instancia en el periodo.</p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Crecimiento
            </div>
            <p className="mt-1 text-[12.5px]">
              {growth === null
                ? 'Sin datos de tamaño en el periodo.'
                : `De ${formatBytes(row.sizeStartBytes)} a ${formatBytes(row.sizeEndBytes)}: ${
                    growth >= 0 ? '+' : '−'
                  }${formatBytes(Math.abs(growth))}.`}
            </p>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Incidentes
            </div>
            <p className="mt-1 text-[12.5px]">
              {incidentes.length > 0
                ? `${incidentes.join('; ')}.`
                : row.logAvailable
                  ? 'Ninguno: ni bloqueos ni errores en el log.'
                  : 'Sin bloqueos registrados. El log de esta instancia no se está leyendo, así que los deadlocks y los errores de la aplicación no entran en el informe.'}
            </p>
          </div>
        </div>

        {row.worstTables.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Mantenimiento pendiente
            </div>
            <div className="table-scroll mt-1">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tabla</th>
                    <th className="text-right">Tuplas muertas</th>
                    <th className="text-right">Bloat</th>
                    <th className="text-right">Último vacuum</th>
                  </tr>
                </thead>
                <tbody>
                  {row.worstTables.map((table) => (
                    <tr key={`${table.schema}.${table.table}`}>
                      <td className="font-mono text-[11px]">
                        {table.schema}.{table.table}
                      </td>
                      <td className="text-right font-mono">{pct(table.deadPct)}</td>
                      <td className="text-right font-mono">
                        {pct(table.bloatPct)}
                        {table.bloatBytes !== null && (
                          <span className="ml-1 text-foreground-muted">
                            ({formatBytes(table.bloatBytes)})
                          </span>
                        )}
                      </td>
                      <td className="text-right font-mono">
                        {table.lastVacuum ? DATE.format(table.lastVacuum) : 'nunca'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {row.topQueries.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Consultas que más tiempo consumieron
            </div>
            <ul className="mt-1 space-y-1.5">
              {row.topQueries.map((q) => (
                <li key={q.queryid} className="text-[12px]">
                  <span className="font-mono">
                    {formatNumber(q.execMs / 1000, 1)} s · {formatNumber(q.calls, 0)} llamadas ·{' '}
                    {q.meanMs.toFixed(2)} ms de media
                  </span>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-foreground-secondary">
                    <Link href={`/instances/${row.instanceId}/queries/${q.queryid}`} className="underline">
                      {(q.text ?? '(sin texto)').replace(/\s+/g, ' ').slice(0, 160)}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Number(Array.isArray(params['semana']) ? params['semana'][0] : params['semana']);
  const weeksAgo = Number.isFinite(raw) ? Math.max(0, Math.min(12, raw)) : 0;

  let report: WeeklyReport;
  try {
    report = await getWeeklyReport(weeksAgo);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Informe' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const { totals, window: w } = report;
  const trend =
    totals.scoreAvg !== null && totals.scorePrevAvg !== null
      ? totals.scoreAvg - totals.scorePrevAvg
      : null;

  return (
    <>
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Informe semanal' }]} />

      <div className="page space-y-[0.875rem]">
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              Del {DATE.format(w.from)} al {DATE.format(w.to)}
            </span>
            <span className="font-mono text-[10.5px] text-foreground-muted">
              generado {DATETIME.format(report.generatedAt)}
            </span>
          </div>
          <div className="panel-body space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {WEEKS.map((option) => (
                <Link
                  key={option.key}
                  href={option.key === 0 ? '/report' : `/report?semana=${option.key}`}
                  className={`tag ${option.key === weeksAgo ? 'tag--info' : 'tag--muted'}`}
                >
                  {option.label}
                </Link>
              ))}
              <a
                className="btn btn--primary ml-auto"
                href={weeksAgo === 0 ? '/report/export' : `/report/export?semana=${weeksAgo}`}
              >
                Descargar Markdown
              </a>
            </div>

            <Verdict report={report} />

            <div className="stat-grid">
              <StatCard
                label="Salud promedio"
                value={totals.scoreAvg === null ? '—' : totals.scoreAvg.toFixed(0)}
                tone={toneForScore(totals.scoreAvg)}
                hint={
                  trend === null
                    ? 'sin semana anterior para comparar'
                    : `${trend >= 0 ? '+' : '−'}${Math.abs(trend).toFixed(0)} vs. anterior`
                }
              />
              <StatCard
                label="Críticos"
                value={String(totals.critical)}
                tone={totals.critical > 0 ? 'error' : 'ok'}
                hint="abiertos al cierre"
              />
              <StatCard
                label="Advertencias"
                value={String(totals.warning)}
                tone={totals.warning > 0 ? 'warn' : 'ok'}
                hint="abiertas al cierre"
              />
              <StatCard
                label="Bloqueos"
                value={String(totals.lockEpisodes)}
                tone={totals.lockEpisodes > 0 ? 'warn' : 'ok'}
                hint="sesiones que esperaron"
              />
              <StatCard
                label="Deadlocks"
                value={String(totals.deadlocks)}
                tone={totals.deadlocks > 0 ? 'error' : 'ok'}
                hint="leídos del log"
              />
              <StatCard
                label="Crecimiento"
                value={totals.growthBytes === null ? '—' : formatBytes(totals.growthBytes)}
                hint="datos, en el periodo"
              />
              <StatCard label="Instancias" value={String(totals.instances)} hint="monitoreadas" />
            </div>
          </div>
        </section>

        {report.actions.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Acciones recomendadas</span>
              <span className="text-[10.5px] text-foreground-muted">
                por severidad y alcance
              </span>
            </div>
            <div className="panel-body space-y-2.5">
              {report.actions.map((action, index) => (
                <div key={action.checkId} className="border-b border-border pb-2.5 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[11px] text-foreground-muted">{index + 1}.</span>
                    <span
                      className={`tag ${action.severity === 'critical' ? 'tag--error' : 'tag--warn'}`}
                    >
                      {action.severity === 'critical' ? 'crítico' : 'advertencia'}
                    </span>
                    <span className="text-[12.5px] font-semibold">{action.title}</span>
                    <span className="font-mono text-[10.5px] text-foreground-muted">
                      {action.instances.length} instancia{action.instances.length === 1 ? '' : 's'}:{' '}
                      {action.instances.join(', ')}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px]">{action.message}</p>
                  <p className="mt-0.5 text-[12px] text-foreground-secondary">
                    {action.remediation}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {report.backups.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Respaldos</span>
            </div>
            <div className="panel-body space-y-2">
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instancia</th>
                      <th>Base</th>
                      <th>Tipo</th>
                      <th>Estado</th>
                      <th>Último</th>
                      <th>Origen del dato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.backups.map((backup, index) => (
                      <tr key={`${backup.alias}:${backup.kind}:${index}`}>
                        <td className="font-mono text-[11px]">{backup.alias}</td>
                        <td className="font-mono text-[11px]">{backup.database}</td>
                        <td>{BACKUP_KIND[backup.kind] ?? backup.kind}</td>
                        <td>
                          <span className={`tag ${BACKUP_TAG[backup.state]}`}>
                            {BACKUP_STATE[backup.state]}
                          </span>
                        </td>
                        <td className="font-mono text-[11px]">
                          {backup.finishedAt ? DATETIME.format(backup.finishedAt) : 'sin registro'}
                        </td>
                        <td className="font-mono text-[11px] text-foreground-secondary">
                          {backup.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11.5px] text-foreground-muted">
                Búho reporta lo que el motor sabe de sus propios respaldos. Un respaldo hecho por una
                herramienta externa que no deja rastro en el motor no aparece aquí, y eso no significa
                que no exista.
              </p>
            </div>
          </section>
        )}

        {report.instances.map((row) => (
          <InstanceBlock key={row.instanceId} row={row} />
        ))}
      </div>
    </>
  );
}
