'use client';

import { useState } from 'react';
import { GROUPS_PER_PAGE, Pager, ROWS_PER_PAGE, slicePage } from '@/components/Pager';
import type { Severity } from '@/lib/queries';

export interface FindingView {
  checkId: string;
  title: string;
  severity: Severity;
  object: string | null;
  message: string;
  remediation: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info'];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

const SEVERITY_STRIPE: Record<Severity, string> = {
  critical: 'check-card--critical',
  warning: 'check-card--warning',
  info: 'check-card--info',
};

type Filter = Severity | 'all';

interface CheckBucket {
  checkId: string;
  title: string;
  severity: Severity;
  remediation: string;
  items: FindingView[];
}

function bucketFindings(findings: FindingView[]): CheckBucket[] {
  const map = new Map<string, CheckBucket>();
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.checkId}`;
    const existing = map.get(key);
    if (existing) {
      existing.items.push(finding);
      continue;
    }
    map.set(key, {
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

function FindingArticle({ finding }: { finding: FindingView }) {
  return (
    <article className={`finding finding--${finding.severity}`}>
      <div>
        <span className={`tag ${SEVERITY_TAG[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
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
  if (bucket.items.length === 1) {
    return <FindingArticle finding={bucket.items[0]} />;
  }

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
            {bucket.items.length} finding{bucket.items.length === 1 ? '' : 's'}
          </span>
        </div>
        <span className="check-card__chevron" aria-hidden />
      </summary>
      <div className="check-card__body">
        {rows.map((finding, index) => (
          <div key={`${finding.object ?? index}`} className="finding finding--line">
            <span className="finding__object">{finding.object ?? '—'}</span>
            <p className="finding__message">{finding.message}</p>
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

function SeveritySection({ severity, buckets }: { severity: Severity; buckets: CheckBucket[] }) {
  const [page, setPage] = useState(1);
  const visible = slicePage(buckets, page, GROUPS_PER_PAGE);
  const findingCount = buckets.reduce((total, bucket) => total + bucket.items.length, 0);

  return (
    <section className="finding-section">
      <div className="finding-section__head">
        <span className="finding-section__title">{SEVERITY_LABEL[severity]}</span>
        <span className={`tag ${SEVERITY_TAG[severity]}`}>
          {findingCount} · {buckets.length} check{buckets.length === 1 ? '' : 's'}
        </span>
      </div>
      {visible.map((bucket) => (
        <FindingGroup key={bucket.checkId} bucket={bucket} />
      ))}
      <Pager
        page={page}
        total={buckets.length}
        size={GROUPS_PER_PAGE}
        onPage={setPage}
        label={`${SEVERITY_LABEL[severity]} checks`}
      />
    </section>
  );
}

export function FindingsPanel({ findings, checkedAt }: { findings: FindingView[]; checkedAt: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  const visible = filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter);
  const buckets = bucketFindings(visible);
  const sections = SEVERITY_ORDER.map((severity) => ({
    severity,
    buckets: buckets.filter((bucket) => bucket.severity === severity),
  })).filter((section) => section.buckets.length > 0);

  const chip = (value: Filter, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setFilter(value)}
      className={`tag ${filter === value ? 'tag--info' : 'tag--muted'}`}
      style={{ cursor: 'pointer' }}
    >
      {label}
    </button>
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Findings</span>
        <div className="flex items-center gap-2">
          {checkedAt ? <span className="font-mono text-[10px] text-foreground-muted">run {checkedAt}</span> : null}
          <div className="flex items-center gap-1">
            {chip('all', `All ${findings.length}`)}
            {chip('critical', `Critical ${counts.critical}`)}
            {chip('warning', `Warnings ${counts.warning}`)}
            {chip('info', `Info ${counts.info}`)}
          </div>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="empty">
          {findings.length === 0 ? 'No findings in the last check run.' : 'No findings at that severity.'}
        </div>
      ) : (
        sections.map((section) => (
          <SeveritySection key={`${filter}-${section.severity}`} severity={section.severity} buckets={section.buckets} />
        ))
      )}
    </section>
  );
}
