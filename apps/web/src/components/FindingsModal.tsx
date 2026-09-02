'use client';

import Link from 'next/link';
import type { FleetFinding } from '@/lib/queries';

const SEVERITY_TAG = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
} as const;

const SEVERITY_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
} as const;

export function FindingsModalList({ findings }: { findings: FleetFinding[] }) {
  if (findings.length === 0) {
    return <div className="empty">No findings at this severity.</div>;
  }

  return (
    <div className="modal-findings">
      {findings.map((finding, index) => (
        <article
          key={`${finding.instanceId}-${finding.checkId}-${finding.object ?? index}`}
          className={`finding finding--${finding.severity}`}
        >
          <div>
            <span className={`tag ${SEVERITY_TAG[finding.severity]}`}>
              {SEVERITY_LABEL[finding.severity]}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/instances/${finding.instanceId}`} className="finding__title hover:text-accent">
                {finding.alias}
              </Link>
              <span className="finding__title">{finding.title}</span>
              {finding.object ? <span className="finding__object">{finding.object}</span> : null}
              <span className="font-mono text-[10px] text-foreground-muted">{finding.checkId}</span>
            </div>
            <p className="finding__message">{finding.message}</p>
            <p className="finding__remediation">{finding.remediation}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
