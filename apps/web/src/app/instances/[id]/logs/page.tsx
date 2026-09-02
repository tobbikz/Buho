import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatClock, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import {
  FAILURE_KINDS,
  KIND_LABEL,
  getLogCoverage,
  getLogGroups,
  getLogRate,
  getLogTotals,
  type LogGroup,
  type LogKind,
} from '@/lib/logs';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
  { hours: 72, label: '3 d' },
  { hours: 168, label: '7 d' },
];

const FILTERS: { key: string; label: string; kinds: LogKind[] }[] = [
  { key: 'fallas', label: 'Fallas', kinds: FAILURE_KINDS },
  { key: 'deadlocks', label: 'Deadlocks and locks', kinds: ['deadlock', 'lock_wait'] },
  { key: 'connections', label: 'Connections', kinds: ['connection'] },
  { key: 'mantenimiento', label: 'Mantenimiento', kinds: ['checkpoint', 'autovacuum', 'temp_file'] },
  {
    key: 'todo',
    label: 'Todo',
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

function kindTone(kind: LogKind): string {
  if (kind === 'fatal' || kind === 'deadlock') return 'tag--error';
  if (kind === 'error' || kind === 'cancelled' || kind === 'lock_wait') return 'tag--warn';
  return 'tag--muted';
}

function GroupRow({ group }: { group: LogGroup }) {
  // El detalle de un deadlock trae las dos consultas que se cruzaron: es la
  // única fuente que lo dice, y por eso se muestra siempre abierto en vez de
  // esconderlo detrás de un clic.
  const alwaysOpen = group.kind === 'deadlock';

  return (
    <details className="log-group" open={alwaysOpen}>
      <summary className="log-group__head">
        <span className={`tag ${kindTone(group.kind)}`}>{KIND_LABEL[group.kind]}</span>
        <span className="log-group__times font-mono">{formatNumber(group.times)}×</span>
        <span className="log-group__message">{group.sample}</span>
        <span className="log-group__when font-mono">{formatAgo(group.lastAt)}</span>
      </summary>

      <div className="log-group__body">
        <div className="log-group__meta">
          <span>
            primera vez <span className="font-mono">{formatClock(group.firstAt)}</span>
          </span>
          <span>
            última <span className="font-mono">{formatClock(group.lastAt)}</span>
          </span>
          <span>
            nivel <span className="font-mono">{group.level}</span>
          </span>
          {group.sqlstate && (
            <span>
              SQLSTATE <span className="font-mono">{group.sqlstate}</span>
            </span>
          )}
          {group.databases.length > 0 && <span>database {group.databases.join(', ')}</span>}
          {group.users.length > 0 && <span>rol {group.users.join(', ')}</span>}
        </div>

        {group.detail && (
          <div>
            <div className="log-group__label">Detail</div>
            <div className="query-block">{group.detail}</div>
          </div>
        )}

        {group.sampleQuery && (
          <div>
            <div className="log-group__label">Statement from the last occurrence</div>
            <div className="query-block">{group.sampleQuery}</div>
          </div>
        )}

        {group.context && (
          <div>
            <div className="log-group__label">Contexto</div>
            <div className="query-block">{group.context}</div>
          </div>
        )}

        {group.hint && <p className="text-[11.5px] text-foreground-secondary">Server hint: {group.hint}</p>}
      </div>
    </details>
  );
}

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
  const filter = FILTERS.find((entry) => entry.key === tipo) ?? FILTERS[0]!;

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
            <strong>This instance has no log reading configured.</strong> El colector no lee journald ni
            files unless asked: set <span className="font-mono">logs</span> in config.json. See{' '}
            <span className="font-mono">sql/monitor-user.sql</span> para las dos formas y lo que cada una necesita.
          </div>
        )}

        {coverage && coverage.warnings.length > 0 && (
          <div className="notice">
            <strong>What is not being seen.</strong> A screen with no errors can mean there were none or that they could not be
            read; this says which of the two.
            <ul className="mt-1 list-disc pl-4">
              {coverage.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Fatales"
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
            label="Canceladas"
            value={formatNumber(totals.cancelled)}
            tone={totals.cancelled > 0 ? 'warn' : 'ok'}
            hint="by timeout or intervention"
          />
          <StatCard
            label="Lock waits"
            value={formatNumber(totals.lockWait)}
            tone={totals.lockWait > 0 ? 'warn' : 'neutral'}
            hint="requires log_lock_waits"
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
          <span className="ml-3 text-[11px] uppercase tracking-wide text-foreground-muted">Tipo</span>
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
            { metric: 'fatal', label: 'Fatales', color: '#b01818' },
            { metric: 'error', label: 'Errors', color: '#c96a1b' },
            { metric: 'deadlock', label: 'Deadlocks', color: '#7b1fa2' },
            { metric: 'cancelled', label: 'Canceladas', color: '#4a6fa5' },
          ]}
        />

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {filter.label} agrupadas · {groups.length}
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">most repeated first</span>
          </div>

          {groups.length === 0 ? (
            <div className="empty">
              {coverage
                ? `No entries of this type in the ${hours} h window.`
                : 'No log reading configured for this instance.'}
            </div>
          ) : (
            <div className="log-list">
              {groups.map((group) => (
                <GroupRow key={`${group.kind}:${group.fingerprint}`} group={group} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
