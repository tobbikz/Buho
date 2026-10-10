'use client';

import { useState } from 'react';
import { CheckGroupCard, type CheckGroupView } from '@/components/CheckGroupCard';
import { GROUPS_PER_PAGE, Pager, slicePage } from '@/components/Pager';
import type { Severity } from '@/lib/checks';

const ORDER: Severity[] = ['critical', 'warning', 'info'];

const LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

function SeverityBlock({ severity, groups }: { severity: Severity; groups: CheckGroupView[] }) {
  const [page, setPage] = useState(1);
  const visible = slicePage(groups, page, GROUPS_PER_PAGE);
  const findings = groups.reduce((total, group) => total + group.findings, 0);

  return (
    <section className="finding-section">
      <div className="finding-section__head">
        <span className="finding-section__title">{LABEL[severity]}</span>
        <span className={`tag ${TAG[severity]}`}>
          {findings} finding{findings === 1 ? '' : 's'} · {groups.length} check{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      {visible.map((group) => (
        <CheckGroupCard key={group.checkId} group={group} />
      ))}
      <Pager
        page={page}
        total={groups.length}
        size={GROUPS_PER_PAGE}
        onPage={setPage}
        label={`${LABEL[severity]} checks`}
      />
    </section>
  );
}

export function ChecksBoard({ groups }: { groups: CheckGroupView[] }) {
  const sections = ORDER.map((severity) => ({
    severity,
    groups: groups.filter((group) => group.severity === severity),
  })).filter((section) => section.groups.length > 0);

  if (sections.length === 0) {
    return <div className="empty">No findings at this severity in the latest check run.</div>;
  }

  return (
    <div className="check-list">
      {sections.map((section) => (
        <SeverityBlock key={section.severity} severity={section.severity} groups={section.groups} />
      ))}
    </div>
  );
}
