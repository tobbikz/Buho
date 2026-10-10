import Link from 'next/link';
import {
  fleetProveRestoreItems,
  ProveRestore,
} from '@/components/ProveRestore';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { ENGINE_LABEL } from '@/lib/estate';
import { formatDuration } from '@/lib/format';
import {
  formatRpoSeconds,
  getFleetRpo,
  type InstanceRpo,
  type RpoStatus,
} from '@/lib/rpo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'RPO · Estate · Búho' };

function statusTag(status: RpoStatus): string {
  if (status === 'met') return 'tag tag--ok';
  if (status === 'breached') return 'tag tag--error';
  if (status === 'broken') return 'tag tag--error';
  return 'tag tag--muted';
}

function statusLabel(status: RpoStatus): string {
  if (status === 'met') return 'Met';
  if (status === 'breached') return 'Breached';
  if (status === 'broken') return 'Broken';
  return 'Unknown';
}

function engineHow(engine: string): string {
  switch (engine) {
    case 'postgres':
      return 'WAL archive (archive_mode)';
    case 'mssql':
      return 'msdb log / full backup age';
    case 'mariadb':
      return 'Binary log (log_bin)';
    case 'oracle':
      return 'RMAN / archive inventory';
    default:
      return engine;
  }
}

export default async function EstateRpoPage() {
  let rows: InstanceRpo[];
  try {
    rows = await getFleetRpo();
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const met = rows.filter((r) => r.status === 'met').length;
  const breached = rows.filter((r) => r.status === 'breached').length;
  const broken = rows.filter((r) => r.status === 'broken').length;
  const unknown = rows.filter((r) => r.status === 'unknown').length;

  const byEngine = (['postgres', 'mssql', 'mariadb', 'oracle'] as const).map((engine) => ({
    engine,
    rows: rows.filter((r) => r.engine === engine),
  }));

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-[1.1rem] font-semibold m-0">Estate RPO · four engines</h1>
          <div className="flex flex-wrap gap-2">
            <Link className="btn" href="/observability/rpo">
              Probe RPO
            </Link>
          </div>
        </div>
        <p className="text-[12px] text-foreground-secondary m-0 max-w-[62rem]">
          How much data you could lose <em>right now</em> if the instance dies — calculated from what
          each engine can prove inside the server (WAL / log backups / binlog / RMAN). Default target{' '}
          <span className="font-mono">15m</span>; override with instance tags{' '}
          <span className="font-mono">rpo_seconds</span> / <span className="font-mono">rpo_hours</span>.
          Alert pack <span className="font-mono">rpo_exposure</span> fires on the same metric.
        </p>
        <div className="notice mt-2 max-w-[62rem]">
          <strong>Which RPO?</strong> This page is <em>Databases Estate RPO</em> (engine-proven
          backup/WAL exposure). Observability{' '}
          <Link href="/observability/rpo" className="underline">
            Probe RPO
          </Link>{' '}
          is a different plane (probe lag / backup-age samples) — do not treat them as the same
          number.
        </div>
      </header>

      <div className="stat-grid">
        <StatCard label="Met" value={String(met)} hint="exposure ≤ target" tone="ok" />
        <StatCard
          label="Breached"
          value={String(breached)}
          hint="signal older than target"
          tone={breached > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Broken"
          value={String(broken)}
          hint="PITR chain off / no backup"
          tone={broken > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Unknown"
          value={String(unknown)}
          hint="no inventory yet"
          tone={unknown > 0 ? 'neutral' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Fleet RPO</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            PG · SQL Server · MariaDB · Oracle
          </span>
        </div>
        <div className="panel-body p-0">
          {rows.length === 0 ? (
            <div className="p-4 text-[12px] text-foreground-muted">
              No SQL instances in the fleet yet.{' '}
              <Link href="/admin/targets" className="underline">
                Add a database
              </Link>
              .
            </div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 'none' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Instance</th>
                    <th>Engine</th>
                    <th>How measured</th>
                    <th className="num">Target</th>
                    <th className="num">Exposure</th>
                    <th>Signal</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.instanceId}>
                      <td>
                        <span className={statusTag(row.status)}>{statusLabel(row.status)}</span>
                      </td>
                      <td>
                        <Link href={row.href} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {ENGINE_LABEL[row.engine] ?? row.engine}
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {engineHow(row.engine)}
                      </td>
                      <td className="num text-[11px]">
                        {formatDuration(row.targetSeconds)}
                        {row.targetFromTag ? (
                          <span className="tag tag--info ml-1" title="From instance tag">
                            tag
                          </span>
                        ) : null}
                      </td>
                      <td className="num text-[11px]">
                        {formatRpoSeconds(row.exposureSeconds)}
                      </td>
                      <td className="text-[11px]">{row.signal}</td>
                      <td className="text-[11px] text-foreground-secondary max-w-[28rem]">
                        {row.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <ProveRestore items={fleetProveRestoreItems()} />

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        {byEngine.map(({ engine, rows: engRows }) => (
          <section key={engine} className="panel">
            <div className="panel-header">
              <span className="panel-title">{ENGINE_LABEL[engine] ?? engine}</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {engRows.length} instance(s) · {engineHow(engine)}
              </span>
            </div>
            <div className="panel-body text-[12px] text-foreground-secondary space-y-2">
              {engRows.length === 0 ? (
                <div className="text-foreground-muted">No instances of this engine.</div>
              ) : (
                engRows.map((row) => (
                  <div key={row.instanceId} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={row.href} className="font-medium text-foreground underline decoration-dotted">
                        {row.alias}
                      </Link>
                      <span className={statusTag(row.status)}>{statusLabel(row.status)}</span>
                      <span className="font-mono text-[10px] text-foreground-muted">
                        exposure {formatRpoSeconds(row.exposureSeconds)} / target{' '}
                        {formatDuration(row.targetSeconds)}
                      </span>
                    </div>
                    <div>{row.detail}</div>
                    <div className="text-[11px] text-foreground-muted">{row.method}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
