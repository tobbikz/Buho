'use client';

import Link from 'next/link';
import { useState } from 'react';
import { GROUPS_PER_PAGE, Pager, ROWS_PER_PAGE, slicePage } from '@/components/Pager';
import type { FleetFinding, Severity } from '@/lib/queries';

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

interface CheckBucket {
  checkId: string;
  title: string;
  severity: Severity;
  remediation: string;
  items: FleetFinding[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function bucketFindings(findings: FleetFinding[]): CheckBucket[] {
  const map = new Map<string, CheckBucket>();
  for (const finding of findings) {
    const existing = map.get(finding.checkId);
    if (existing) {
      existing.items.push(finding);
      if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = finding.severity;
      }
      continue;
    }
    map.set(finding.checkId, {
      checkId: finding.checkId,
      title: finding.title,
      severity: finding.severity,
      remediation: finding.remediation,
      items: [finding],
    });
  }
  return [...map.values()].sort(
    (a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title),
  );
}

function FindingArticle({ finding }: { finding: FleetFinding }) {
  return (
    <article className={`finding finding--${finding.severity}`}>
      <div>
        <span className={`tag ${SEVERITY_TAG[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
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
  );
}

function FindingGroup({ bucket }: { bucket: CheckBucket }) {
  const [page, setPage] = useState(1);
  if (bucket.items.length === 1) return <FindingArticle finding={bucket.items[0]} />;

  const instances = new Set(bucket.items.map((finding) => finding.instanceId)).size;
  const rows = slicePage(bucket.items, page, ROWS_PER_PAGE);

  return (
    <details className={`check-card ${SEVERITY_STRIPE[bucket.severity]}`}>
      <summary className="check-card__head">
        <span className={`tag ${SEVERITY_TAG[bucket.severity]}`}>{SEVERITY_LABEL[bucket.severity]}</span>
        <div className="check-card__main">
          <span className="check-card__title">{bucket.title}</span>
          <span className="check-card__id">{bucket.checkId}</span>
        </div>
        <div className="check-card__meta">
          <span className="check-card__reach">
            {instances} instance{instances === 1 ? '' : 's'}
            {bucket.items.length > instances ? ` · ${bucket.items.length} findings` : ''}
          </span>
        </div>
        <span className="check-card__chevron" aria-hidden />
      </summary>
      <div className="check-card__body">
        {rows.map((finding, index) => (
          <div
            key={`${finding.instanceId}-${finding.object ?? index}`}
            className="finding finding--line"
          >
            <Link href={`/instances/${finding.instanceId}`} className="check-card__instance">
              {finding.alias}
            </Link>
            <div className="min-w-0">
              {finding.object ? <div className="finding__object">{finding.object}</div> : null}
              <p className="finding__message">{finding.message}</p>
            </div>
          </div>
        ))}
        {bucket.remediation ? (
          <div className="check-card__fix">
            <span className="check-card__fix-label">How to fix</span>
            <p>{bucket.remediation}</p>
          </div>
        ) : null}
        <Pager
          page={page}
          total={bucket.items.length}
          size={ROWS_PER_PAGE}
          onPage={setPage}
          label={`${bucket.title} findings`}
        />
      </div>
    </details>
  );
}

export function FindingsModalList({ findings }: { findings: FleetFinding[] }) {
  const [page, setPage] = useState(1);
  if (findings.length === 0) {
    return <div className="empty">No findings at this severity.</div>;
  }

  const buckets = bucketFindings(findings);
  const visible = slicePage(buckets, page, GROUPS_PER_PAGE);

  return (
    <div className="modal-findings">
      {visible.map((bucket) => (
        <FindingGroup key={bucket.checkId} bucket={bucket} />
      ))}
      <Pager page={page} total={buckets.length} size={GROUPS_PER_PAGE} onPage={setPage} label="Finding groups" />
    </div>
  );
}
