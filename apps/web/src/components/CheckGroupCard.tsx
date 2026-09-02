import Link from 'next/link';
import { formatNumber } from '@/lib/format';
import type { CheckGroup, Severity } from '@/lib/checks';

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const SEVERITY_STRIPE: Record<Severity, string> = {
  critical: 'check-card--critical',
  warning: 'check-card--warning',
  info: 'check-card--info',
};

export function CheckGroupCard({ group }: { group: CheckGroup }) {
  return (
    <details className={`check-card ${SEVERITY_STRIPE[group.severity]}`}>
      <summary className="check-card__head">
        <span className={`tag ${SEVERITY_TAG[group.severity]}`}>{SEVERITY_LABEL[group.severity]}</span>
        <div className="check-card__main">
          <span className="check-card__title">{group.title}</span>
          <span className="check-card__id">{group.checkId}</span>
        </div>
        <div className="check-card__meta">
          <span className="check-card__reach">
            {group.instances} instance{group.instances === 1 ? '' : 's'}
            {group.findings > group.instances ? ` · ${group.findings} findings` : ''}
          </span>
          {group.instances > 1 ? <span className="check-card__platform">platform-wide</span> : null}
        </div>
        <span className="check-card__chevron" aria-hidden />
      </summary>

      <div className="check-card__body">
        <div className="table-scroll">
          <table className="data-table data-table--checks">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Object</th>
                <th>Finding</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {group.occurrences.map((entry, index) => (
                <tr key={`${entry.instanceId}:${entry.object ?? ''}:${index}`}>
                  <td>
                    <Link href={`/instances/${entry.instanceId}`} className="check-card__instance">
                      {entry.alias}
                    </Link>
                    <span className="check-card__context">{entry.group ?? entry.environment}</span>
                  </td>
                  <td className="font-mono text-[11px] text-foreground-secondary">{entry.object ?? '—'}</td>
                  <td className="text-[11.5px] leading-snug text-foreground-secondary">{entry.message}</td>
                  <td className="num font-mono text-[11px]">
                    {entry.value === null ? '—' : formatNumber(Math.round(entry.value * 100) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {group.remediation ? (
          <div className="check-card__fix">
            <span className="check-card__fix-label">How to fix</span>
            <p>{group.remediation}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}
