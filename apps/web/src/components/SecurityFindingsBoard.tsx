'use client';

import { useState } from 'react';
import { Pager, ROWS_PER_PAGE, slicePage } from '@/components/Pager';
import { SecurityFindingRow } from '@/components/SecurityFindingRow';

const ORDER = ['critica', 'alta', 'media', 'baja', 'no_verificable'] as const;

type Severity = (typeof ORDER)[number];

const SEVERITY_LABEL: Record<Severity, string> = {
  critica: 'Critical',
  alta: 'High',
  media: 'Medium',
  baja: 'Low',
  no_verificable: 'Not verifiable',
};

export interface SecurityFindingItem {
  instanceId: number;
  checkId: string;
  alias: string;
  categoryLabel: string;
  title: string;
  detail: string;
  remediation: string | null;
  severity: Severity;
}

function findingClass(severity: Severity): string {
  if (severity === 'critica' || severity === 'alta') return 'finding--critical';
  if (severity === 'media' || severity === 'baja') return 'finding--warning';
  return 'finding--info';
}

function tagClass(severity: Severity): string {
  if (severity === 'critica' || severity === 'alta') return 'tag--error';
  if (severity === 'no_verificable') return 'tag--muted';
  return 'tag--warn';
}

function CategoryBlock({
  categoryLabel,
  items,
}: {
  categoryLabel: string;
  items: SecurityFindingItem[];
}) {
  const [page, setPage] = useState(1);
  const rows = slicePage(items, page, ROWS_PER_PAGE);

  return (
    <div className="finding-category">
      <div className="finding-category__head">
        <span className="finding-category__title">{categoryLabel}</span>
        <span className="tag tag--muted">{items.length}</span>
      </div>
      {rows.map((finding) => (
        <SecurityFindingRow
          key={`${finding.instanceId}-${finding.checkId}`}
          instanceId={finding.instanceId}
          alias={finding.alias}
          categoryLabel={categoryLabel}
          title={finding.title}
          detail={finding.detail}
          remediation={finding.remediation}
          severityClass={findingClass(finding.severity)}
        />
      ))}
      <Pager
        page={page}
        total={items.length}
        size={ROWS_PER_PAGE}
        onPage={setPage}
        label={`${categoryLabel} findings`}
      />
    </div>
  );
}

function SeverityBlock({ severity, items }: { severity: Severity; items: SecurityFindingItem[] }) {
  const categories = [...new Set(items.map((finding) => finding.categoryLabel))];

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{SEVERITY_LABEL[severity]}</span>
        <span className={`tag ${tagClass(severity)}`}>{items.length}</span>
        {severity === 'no_verificable' ? (
          <span className="text-[11px] text-foreground-muted">
            Búho could not run these checks — that does not mean the server is safe
          </span>
        ) : null}
      </div>
      {categories.map((categoryLabel) => (
        <CategoryBlock
          key={categoryLabel}
          categoryLabel={categoryLabel}
          items={items.filter((finding) => finding.categoryLabel === categoryLabel)}
        />
      ))}
    </section>
  );
}

export function SecurityFindingsBoard({ findings }: { findings: SecurityFindingItem[] }) {
  const sections = ORDER.map((severity) => ({
    severity,
    items: findings.filter((finding) => finding.severity === severity),
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) return null;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      {sections.map((section) => (
        <SeverityBlock key={section.severity} severity={section.severity} items={section.items} />
      ))}
    </div>
  );
}
