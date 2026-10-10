import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { LogGroupsList } from '@/components/LogGroupsList';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import {
  FAILURE_KINDS,
  getLogCoverage,
  getLogGroups,
  getLogRate,
  getLogTotals,
  type LogGroup,
  type LogKind,
} from '@/lib/logs';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** Map legacy Spanish collector tips so the UI stays English until the next probe. */
function localizeLogWarning(warning: string): string {
  if (warning.includes('log_destination es "')) {
    const dest = warning.match(/log_destination es "([^"]+)"/)?.[1] ?? 'stderr';
    return `log_destination is "${dest}": fields are inferred from free text. With jsonlog (PG 15+) or csvlog they arrive structured, including SQLSTATE and user.`;
  }
  if (warning.includes('log_lock_waits está apagado')) {
    return 'log_lock_waits is off: lock waits leave no trail in the log.';
  }
  if (warning.includes('log_min_duration_statement es -1')) {
    return 'log_min_duration_statement is -1: slow queries are not logged.';
  }
  if (warning.includes('logging_collector está apagado')) {
    return 'logging_collector is off: logs go to stderr, usually captured by systemd on Linux. Set `logs.source = "journal"` in config.json to read them.';
  }
  if (warning.includes('necesita logging_collector')) {
    return 'logs.source=sql needs logging_collector=on. With the collector off, logs go to stderr/journald — set logs.source=journal.';
  }
  if (warning.includes('no se configuró un origen')) {
    return 'The server writes log files, but no source was configured (sql / file / journal).';
  }
  return warning;
}

const WINDOWS = [
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
  { hours: 72, label: '3 d' },
  { hours: 168, label: '7 d' },
];

const FILTERS: { key: string; label: string; kinds: LogKind[] }[] = [
  { key: 'fallas', label: 'Failures', kinds: FAILURE_KINDS },
  { key: 'deadlocks', label: 'Deadlocks and locks', kinds: ['deadlock', 'lock_wait'] },
  { key: 'connections', label: 'Connections', kinds: ['connection'] },
  { key: 'mantenimiento', label: 'Maintenance', kinds: ['checkpoint', 'autovacuum', 'temp_file'] },
  {
    key: 'todo',
    label: 'All',
    kinds: [
      'deadlock',
      'lock_wait',
      'error',
      'fatal',
      'connection',
      'checkpoint',
      'autovacuum',
      'temp_file',
      'cancelled',
      'other',
    ],
  },
];

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ window?: string; tipo?: string }>;
}) {
  const { id } = await params;
  const { window, tipo } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engineKind = await getInstanceEngine(instanceId);
  // Bloqueos, métricas, consultas y log existen en los tres motores desde la
  // paridad; sólo Vacuum, Host y Replicación siguen siendo de PostgreSQL.
  const engine = engineKind ?? 'postgres';

  const hours = WINDOWS.some((w) => String(w.hours) === window) ? Number(window) : 24;
  // Default Fallas for Postgres; foreign engines often only have kind=other
  // (alert/errorlog noise) until real failures appear — open Todo so Log is not empty.
  const defaultTipo =
    engine === 'postgres' ? 'fallas' : 'todo';
  const filter =
    FILTERS.find((entry) => entry.key === tipo) ??
    FILTERS.find((entry) => entry.key === defaultTipo) ??
    FILTERS[0]!;

  let instance;
  try {
    instance = await getInstance(instanceId);
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
    { label: 'Log' },
  ];

  let coverage: Awaited<ReturnType<typeof getLogCoverage>>;
  let totals: Awaited<ReturnType<typeof getLogTotals>>;
  let groups: LogGroup[];
  let rate: Awaited<ReturnType<typeof getLogRate>>;
  try {
    [coverage, totals, groups, rate] = await Promise.all([
      getLogCoverage(instanceId),
      getLogTotals(instanceId, hours),
      getLogGroups(instanceId, hours, filter.kinds, 60),
      getLogRate(instanceId, hours, hours <= 6 ? 5 : hours <= 24 ? 15 : 60),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const link = (next: { window?: number; tipo?: string }) => {
    const search = new URLSearchParams();
    search.set('window', String(next.window ?? hours));
    search.set('tipo', next.tipo ?? filter.key);
    return `/instances/${instanceId}/logs?${search.toString()}`;
  };

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Log · {instance.alias}</h1>
            <p className="page-sub">
              What no statistics view shows: the full report of each deadlock with the two
              queries that crossed, and the errors the application saw. Grouped by message, because a hundred
              errors from the same insert are one problem, not a hundred.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        {!coverage && (
          <div className="notice notice--warn">
            <strong>This instance has no log reading yet.</strong>{' '}
            {engine === 'oracle' ? (
              <>
                Oracle reads the alert log via <span className="font-mono">V$DIAG_ALERT_EXT</span>. Grant the
                monitor user <span className="font-mono">SELECT_CATALOG_ROLE</span> (or SELECT on diagnostic
                views) and wait one collector cycle (~30s).
              </>
            ) : engine === 'mssql' ? (
              <>
                SQL Server reads <span className="font-mono">xp_readerrorlog</span> / system_health. The
                monitor login needs VIEW SERVER STATE (and xp_readerrorlog access). Wait one collector cycle.
              </>
            ) : engine === 'mariadb' ? (
              <>
                MariaDB reads InnoDB status and <span className="font-mono">mysql.slow_log</span> when
                enabled. Grant SELECT on those sources; enable <span className="font-mono">slow_query_log</span>{' '}
                for slow-query lines.
              </>
            ) : (
              <>
                For PostgreSQL the collector defaults to{' '}
                <span className="font-mono">logs.source = &quot;sql&quot;</span> (reads via{' '}
                <span className="font-mono">pg_ls_logdir</span>
                ). Install <span className="font-mono">buho_read_log</span> from{' '}
                <span className="font-mono">sql/monitor-user.sql</span> so the monitor role can read files
                without superuser. Alternatives: <span className="font-mono">journal</span> or{' '}
                <span className="font-mono">file</span> in config.json.
              </>
            )}
          </div>
        )}

        {coverage ? (
          <div className="notice">
            <strong>Log source (this instance only).</strong> Reading{' '}
            <span className="font-mono">{coverage.source}</span>
            {coverage.detail ? (
              <>
                {' '}
                · <span className="font-mono text-[11px]">{coverage.detail}</span>
              </>
            ) : null}
            {' '}
            · last read {coverage.readAt ? new Date(coverage.readAt).toLocaleString('en') : '—'} ·{' '}
            {formatNumber(coverage.entries)} cursor entries. Counts below are scoped to this instance&apos;s configured
            stream — not the whole host journal unless <span className="font-mono">source=journal</span> was chosen
            for this target.
          </div>
        ) : null}

        {coverage && coverage.warnings.length > 0 && (
          <div className="notice">
            <strong>What is not being seen.</strong> A screen with no errors can mean there were none or that they could not be
            read; this says which of the two.
            <ul className="mt-1 list-disc pl-4">
              {coverage.warnings.map((warning) => (
                <li key={warning}>{localizeLogWarning(warning)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Fatals"
            value={formatNumber(totals.fatal)}
            tone={totals.fatal > 0 ? 'error' : 'ok'}
            hint="session terminated by the server"
          />
          <StatCard
            label="Errors"
            value={formatNumber(totals.error)}
            tone={totals.error > 0 ? 'warn' : 'ok'}
            hint="failures the application saw"
          />
          <StatCard
            label="Deadlocks"
            value={formatNumber(totals.deadlock)}
            tone={totals.deadlock > 0 ? 'error' : 'ok'}
            hint={totals.deadlock > 0 ? 'with correlated queries' : 'none in the window'}
          />
          <StatCard
            label="Cancelled"
            value={formatNumber(totals.cancelled)}
            tone={totals.cancelled > 0 ? 'warn' : 'ok'}
            hint="by timeout or intervention"
          />
          <StatCard
            label="Lock waits"
            value={formatNumber(totals.lockWait)}
            tone={totals.lockWait > 0 ? 'warn' : 'neutral'}
            hint={
              engine === 'postgres'
                ? 'requires log_lock_waits'
                : engine === 'oracle'
                  ? 'from alert log / wait noise when present'
                  : engine === 'mssql'
                    ? 'from errorlog / system_health when present'
                    : 'when the log source emits them'
            }
          />
          <StatCard
            label="Entries read"
            value={formatNumber(totals.total)}
            tone="neutral"
            hint={coverage ? coverage.detail : 'no source'}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Window</span>
          {WINDOWS.map((window) => (
            <a
              key={window.hours}
              href={link({ window: window.hours })}
              className={`tag ${window.hours === hours ? 'tag--info' : 'tag--muted'}`}
            >
              {window.label}
            </a>
          ))}
          <span className="ml-3 text-[11px] uppercase tracking-wide text-foreground-muted">Type</span>
          {FILTERS.map((entry) => (
            <a
              key={entry.key}
              href={link({ tipo: entry.key })}
              className={`tag ${entry.key === filter.key ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        <TimeseriesPanel
          title="Failures over time"
          hint={`window ${hours} h`}
          data={rate}
          unit="count"
          height={160}
          series={[
            { metric: 'fatal', label: 'Fatals', color: '#b01818' },
            { metric: 'error', label: 'Errors', color: '#c96a1b' },
            { metric: 'deadlock', label: 'Deadlocks', color: '#7b1fa2' },
            { metric: 'cancelled', label: 'Cancelled', color: '#4a6fa5' },
          ]}
        />

        <LogGroupsList
          title={`${filter.label} · ${groups.length} group(s)`}
          empty={
            coverage
              ? `No entries of this type in the ${hours} h window.`
              : 'No log reading configured for this instance.'
          }
          groups={groups.map((group) => ({
            ...group,
            firstAt: group.firstAt.toISOString(),
            lastAt: group.lastAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
