import Link from 'next/link';
import { SecurityFindingRow } from '@/components/SecurityFindingRow';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  CATEGORY_LABEL,
  SEVERITY_LABEL,
  engineLabel,
  getFindings,
  getPosture,
  scoreTone,
  type Finding,
  type Posture,
  type Severity,
} from '@/lib/security';

export const dynamic = 'force-dynamic';

const ORDER: Severity[] = ['critica', 'alta', 'media', 'baja', 'no_verificable', 'ok'];

function findingClass(severity: Severity): string {
  if (severity === 'critica' || severity === 'alta') return 'finding--critical';
  if (severity === 'media' || severity === 'baja') return 'finding--warning';
  return 'finding--info';
}

export default async function SecurityPage() {
  let findings: Finding[];
  let posture: Posture[];
  try {
    [findings, posture] = await Promise.all([getFindings(), getPosture()]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  if (posture.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">No audits yet</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary">
          The collector runs a security audit every 6 hours; the first run happens at startup. If this
          stays empty, check the collector log — the audit must connect to each instance.
        </div>
      </section>
    );
  }

  const critical = findings.filter((finding) => finding.severity === 'critica');
  const high = findings.filter((finding) => finding.severity === 'alta');
  const blind = findings.filter((finding) => finding.severity === 'no_verificable');
  const exposed = new Set(critical.map((finding) => finding.instanceId));
  const worst = posture[0];
  const verified = posture.reduce((sum, row) => sum + row.verified, 0);
  const totalChecks = posture.reduce((sum, row) => sum + row.total, 0);
  const coveragePct = totalChecks > 0 ? Math.round((verified / totalChecks) * 100) : 0;

  const grouped = ORDER.map((severity) => ({
    severity,
    items: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.items.length > 0 && group.severity !== 'ok');

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Critical findings"
          value={String(critical.length)}
          hint="access without a valid credential"
          tone={critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="High findings"
          value={String(high.length)}
          hint="exposed credentials or data"
          tone={high.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Compromisable instances"
          value={`${exposed.size}/${posture.length}`}
          hint="with at least one critical finding"
          tone={exposed.size > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Worst posture"
          value={String(worst.score)}
          unit="/100"
          hint={worst.alias}
          tone={scoreTone(worst.score)}
        />
        <StatCard
          label="Audit coverage"
          value={String(coveragePct)}
          unit="%"
          hint={`${verified} of ${totalChecks} checks verified`}
          tone={coveragePct >= 90 ? 'ok' : coveragePct >= 70 ? 'warn' : 'error'}
        />
        <StatCard
          label="Blind spots"
          value={String(blind.length)}
          hint="checks lacking permissions"
          tone={blind.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Posture by instance</span>
          <span className="text-[11px] text-foreground-muted">
            score is calculated only over checks that could be verified
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Engine</th>
              <th className="text-right">Posture</th>
              <th className="text-right">Critical</th>
              <th className="text-right">High</th>
              <th className="text-right">Medium</th>
              <th className="text-right">Low</th>
              <th className="text-right">Verified</th>
              <th>Last audit</th>
            </tr>
          </thead>
          <tbody>
            {posture.map((row) => (
              <tr key={row.instanceId}>
                <td>
                  <Link href={`/instances/${row.instanceId}`}>{row.alias}</Link>
                </td>
                <td>{engineLabel(row.engine)}</td>
                <td className="text-right">
                  <span className={`score score--${scoreTone(row.score)}`}>{row.score}</span>
                </td>
                <td className="text-right">
                  {row.critical > 0 ? <span className="tag tag--error">{row.critical}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.high > 0 ? <span className="tag tag--error">{row.high}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.medium > 0 ? <span className="tag tag--warn">{row.medium}</span> : '—'}
                </td>
                <td className="text-right">{row.low > 0 ? row.low : '—'}</td>
                <td className="text-right">
                  {row.verified}/{row.total}
                </td>
                <td>{formatAgo(row.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {grouped.map((group) => (
        <section className="panel" key={group.severity}>
          <div className="panel-header">
            <span className="panel-title">{SEVERITY_LABEL[group.severity]}</span>
            <span
              className={`tag ${
                group.severity === 'critica' || group.severity === 'alta'
                  ? 'tag--error'
                  : group.severity === 'no_verificable'
                    ? 'tag--muted'
                    : 'tag--warn'
              }`}
            >
              {group.items.length}
            </span>
            {group.severity === 'no_verificable' && (
              <span className="text-[11px] text-foreground-muted">
                Búho could not run these checks — that does not mean the server is safe
              </span>
            )}
          </div>
          <div className="panel-body p-0">
            {group.items.map((finding) => (
              <SecurityFindingRow
                key={`${finding.instanceId}-${finding.checkId}`}
                instanceId={finding.instanceId}
                alias={finding.alias}
                categoryLabel={CATEGORY_LABEL[finding.category] ?? finding.category}
                title={finding.title}
                detail={finding.detail}
                remediation={finding.remediation}
                severityClass={findingClass(finding.severity)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
