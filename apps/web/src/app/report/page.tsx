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
  sin_recuperacion: 'no recovery',
  atrasado: 'overdue',
  no_verificable: 'not verifiable',
  ok: 'current',
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
  { key: 0, label: 'Last 7 days' },
  { key: 1, label: 'Previous week' },
  { key: 2, label: 'Two weeks ago' },
  { key: 3, label: 'Three weeks ago' },
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
      `There ${totals.critical === 1 ? 'is' : 'are'} ${totals.critical} critical finding${
        totals.critical === 1 ? '' : 's'
      } open at week close`,
    );
  } else if (totals.warning > 0) {
    frases.push(
      `No critical findings; ${totals.warning} warning${totals.warning === 1 ? '' : 's'} remain`,
    );
  } else {
    frases.push('The week closes with no critical findings or warnings');
  }

  if (trend !== null) {
    if (Math.abs(trend) < 1) frases.push('estate health stayed stable');
    else if (trend > 0) frases.push(`estate health improved ${trend.toFixed(0)} points`);
    else frases.push(`estate health dropped ${Math.abs(trend).toFixed(0)} points`);
  }
  if (totals.deadlocks > 0) frases.push(totals.deadlocks === 1
        ? 'one deadlock was logged'
        : `${totals.deadlocks} deadlocks were logged`);
  if (totals.lockEpisodes > 0) {
    frases.push(totals.lockEpisodes === 1
        ? 'one session waited on a lock'
        : `${totals.lockEpisodes} sessions waited on a lock`);
  }
  if (totals.growthBytes !== null && totals.growthBytes > 0) {
    frases.push(`data grew by ${formatBytes(totals.growthBytes)}`);
  }
  if (totals.lockWaitShare !== null && totals.lockWaitShare >= 0.1) {
    frases.push(
      `${(totals.lockWaitShare * 100).toFixed(0)} % of session time went to locks`,
    );
  }
  if (totals.ioWaitShare !== null && totals.ioWaitShare >= 0.2) {
    frases.push(`${(totals.ioWaitShare * 100).toFixed(0)} % of session time waited on disk`);
  }

  return <p className="text-[13px] leading-relaxed">{frases.join(', ')}.</p>;
}

function Plan({ report }: { report: WeeklyReport }) {
  if (report.plan.length === 0) return null;
  return (
    <div className="rounded-[3px] border border-border bg-surface-2/40 px-3 py-2.5">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        Plan de trabajo de la semana
      </div>
      <ol className="space-y-1.5 text-[12.5px] leading-relaxed">
        {report.plan.map((item, index) => (
          <li key={index} className="flex gap-2">
            <span className="font-mono text-foreground-muted">{index + 1}.</span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function InstanceBlock({ row }: { row: ReportInstance }) {
  const growth =
    row.sizeStartBytes !== null && row.sizeEndBytes !== null
      ? row.sizeEndBytes - row.sizeStartBytes
      : null;

  const filas: { label: string; metric: ReportMetric | null; fmt: (v: number | null) => string }[] = [
    { label: 'Connections used', metric: row.connectionsPct, fmt: (value: number | null) => pct(value) },
    { label: 'Cache hits', metric: row.cacheHitPct, fmt: (value: number | null) => pct(value) },
    { label: 'Host CPU', metric: row.cpuPct, fmt: (value: number | null) => pct(value) },
    { label: 'Host memory', metric: row.memPct, fmt: (value: number | null) => pct(value) },
    { label: 'Disk used', metric: row.diskPct, fmt: (value: number | null) => pct(value) },
    { label: 'Commits per second', metric: row.commitsPerSec, fmt: (value: number | null) => formatNumber(value, 1) },
    { label: 'XID age', metric: row.xidAgePct, fmt: (value: number | null) => pct(value) },
    { label: 'Replication lag', metric: row.replicationLag, fmt: (value: number | null) => seconds(value) },
  ].filter((fila) => fila.metric && fila.metric.avg !== null);

  const incidentes: string[] = [];
  if (row.lockEpisodes > 0) {
    incidentes.push(
      `${row.lockEpisodes} lock episode${row.lockEpisodes === 1 ? '' : 's'}` +
        `${row.lockWorstSeconds === null ? '' : `, worst waited ${seconds(row.lockWorstSeconds)}`}`,
    );
  }
  if (row.logAvailable) {
    if (row.logDeadlocks > 0) {
      incidentes.push(
        row.logDeadlocks === 1 ? 'one deadlock in the log' : `${row.logDeadlocks} deadlocks in the log`,
      );
    }
    if (row.logErrors > 0) {
      incidentes.push(
        row.logErrors === 1 ? 'one error in the log' : `${row.logErrors} errors in the log`,
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
          {row.scoreEnd !== null && ` · health ${row.scoreEnd}`}
          {row.scoreStart !== null &&
            row.scoreEnd !== null &&
            row.scoreStart !== row.scoreEnd &&
            ` (opened at ${row.scoreStart})`}
        </span>
      </div>

      <div className="panel-body space-y-3">
        {row.coveragePct !== null && row.coveragePct < 95 && (
          <p className="notice notice--warn text-[12px]">
            Monitoring covered {pct(row.coveragePct, 0)} of the week's hours. Averages
            excluyen las horas sin muestras.
          </p>
        )}

        {filas.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th className="text-right">Average</th>
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
          <p className="empty">No samples for this instance in the period.</p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Growth
            </div>
            <p className="mt-1 text-[12.5px]">
              {growth === null
                ? 'No size data in the period.'
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
                  ? 'None: no locks and no log errors.'
                  : 'No locks recorded. This instance log is not being read, so deadlocks and application errors are not in the report.'}
            </p>
          </div>
        </div>

        {row.waitProfile && row.waitProfile.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Where waits went · {row.waitSamples} samples
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {row.waitProfile.slice(0, 6).map((w) => (
                <span
                  key={w.waitType}
                  className={`tag ${
                    w.waitType === 'Lock'
                      ? 'tag--error'
                      : w.waitType === 'IO'
                        ? 'tag--warn'
                        : w.waitType === 'CPU'
                          ? 'tag--ok'
                          : 'tag--muted'
                  }`}
                >
                  {w.waitType} {(w.share * 100).toFixed(0)} %
                </span>
              ))}
            </div>
          </div>
        )}

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
                    <th className="text-right">Dead tuples</th>
                    <th className="text-right">Bloat</th>
                    <th className="text-right">Last vacuum</th>
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
                        {table.lastVacuum ? DATE.format(table.lastVacuum) : 'never'}
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
              Queries that consumed the most time
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
                      {(q.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 160)}
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
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Report' }]} />
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
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Weekly report' }]} />

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
            <Plan report={report} />

            <div className="stat-grid">
              <StatCard
                label="Average health"
                value={totals.scoreAvg === null ? '—' : totals.scoreAvg.toFixed(0)}
                tone={toneForScore(totals.scoreAvg)}
                hint={
                  trend === null
                    ? 'no previous week to compare'
                    : `${trend >= 0 ? '+' : '−'}${Math.abs(trend).toFixed(0)} vs. anterior`
                }
              />
              <StatCard
                label="Criticals"
                value={String(totals.critical)}
                tone={totals.critical > 0 ? 'error' : 'ok'}
                hint="open at close"
              />
              <StatCard
                label="Advertencias"
                value={String(totals.warning)}
                tone={totals.warning > 0 ? 'warn' : 'ok'}
                hint="open at close"
              />
              <StatCard
                label="Locks"
                value={String(totals.lockEpisodes)}
                tone={totals.lockEpisodes > 0 ? 'warn' : 'ok'}
                hint="sessions that waited"
              />
              <StatCard
                label="Tiempo en Lock"
                value={totals.lockWaitShare === null ? '—' : `${(totals.lockWaitShare * 100).toFixed(0)} %`}
                tone={
                  totals.lockWaitShare !== null && totals.lockWaitShare >= 0.15
                    ? 'error'
                    : totals.lockWaitShare !== null && totals.lockWaitShare >= 0.05
                      ? 'warn'
                      : 'ok'
                }
                hint="of session time"
              />
              <StatCard
                label="Tiempo en IO"
                value={totals.ioWaitShare === null ? '—' : `${(totals.ioWaitShare * 100).toFixed(0)} %`}
                tone={
                  totals.ioWaitShare !== null && totals.ioWaitShare >= 0.25 ? 'warn' : 'ok'
                }
                hint="of session time"
              />
              <StatCard
                label="Deadlocks"
                value={String(totals.deadlocks)}
                tone={totals.deadlocks > 0 ? 'error' : 'ok'}
                hint="read from the log"
              />
              <StatCard
                label="Growth"
                value={totals.growthBytes === null ? '—' : formatBytes(totals.growthBytes)}
                hint="data, in the period"
              />
              <StatCard label="Instances" value={String(totals.instances)} hint="monitoreadas" />
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
                      {action.severity === 'critical' ? 'critical' : 'warning'}
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
              <span className="panel-title">Backups</span>
            </div>
            <div className="panel-body space-y-2">
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instancia</th>
                      <th>Database</th>
                      <th>Tipo</th>
                      <th>State</th>
                      <th>Last</th>
                      <th>Data source</th>
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
                          {backup.finishedAt ? DATETIME.format(backup.finishedAt) : 'no record'}
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
                external tool that leaves no trail in the engine does not appear here, and that does not mean
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
