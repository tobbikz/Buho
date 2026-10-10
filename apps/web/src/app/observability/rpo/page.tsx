import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatDuration } from '@/lib/format';
import { listObservabilityRpo, type ObsRpoRow } from '@/lib/obs-ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'RPO · Observability · Búho' };

function statusTag(status: ObsRpoRow['status']): string {
  if (status === 'met') return 'tag tag--ok';
  if (status === 'breached') return 'tag tag--error';
  return 'tag tag--muted';
}

function fmtSeconds(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  return formatDuration(sec);
}

export default async function ObservabilityRpoPage() {
  let rows: ObsRpoRow[];
  try {
    rows = await listObservabilityRpo();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const met = rows.filter((r) => r.status === 'met').length;
  const breached = rows.filter((r) => r.status === 'breached').length;
  const unknown = rows.filter((r) => r.status === 'unknown').length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="RPO"
        title="RPO"
        sub={
          <>
            Recovery Point Objective vs replication lag and last backup · default target 15m ·
            override with instance tag <span className="font-mono">rpo_seconds</span>
          </>
        }
        actions={
          <Link className="btn" href="/">
            Databases fleet
          </Link>
        }
      />

      <div className="stat-grid">
        <StatCard label="Met" value={String(met)} hint="exposure ≤ RPO" />
        <StatCard label="Breached" value={String(breached)} hint="lag or backup too old" />
        <StatCard label="Unknown" value={String(unknown)} hint="no lag / backup sample" />
      </div>

      {rows.length === 0 ? (
        <ObsEmpty title="No databases in the fleet" actions={[{ href: '/', label: 'Add a database', primary: true }]}>
          Register database instances to evaluate RPO against lag and backup age.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Fleet RPO posture</span>
            <span className="text-[11px] text-foreground-muted">{rows.length} databases</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Instance</th>
                  <th className="num">RPO</th>
                  <th className="num">Lag</th>
                  <th className="num">Backup age</th>
                  <th className="num">Exposure</th>
                  <th>Backup</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.instanceId}>
                    <td>
                      <span className={statusTag(r.status)}>{r.status}</span>
                    </td>
                    <td>
                      <Link
                        href={`/instances/${r.instanceId}`}
                        className="check-score__instance"
                      >
                        {r.alias}
                      </Link>
                      <div className="text-[10px] text-foreground-muted">{r.engine}</div>
                    </td>
                    <td className="num font-mono text-[12px]">{fmtSeconds(r.rpoSeconds)}</td>
                    <td className="num font-mono text-[12px]">{fmtSeconds(r.lagSeconds)}</td>
                    <td className="num font-mono text-[12px]">
                      {fmtSeconds(r.backupAgeSeconds)}
                    </td>
                    <td className="num font-mono text-[12px]">
                      {fmtSeconds(r.exposureSeconds)}
                    </td>
                    <td className="font-mono text-[11px] text-foreground-muted">
                      {r.backupKind
                        ? `${r.backupKind}${r.backupSource ? ` · ${r.backupSource}` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
