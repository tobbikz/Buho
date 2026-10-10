'use client';

import { useState } from 'react';
import { GROUPS_PER_PAGE, Pager, ROWS_PER_PAGE, slicePage } from '@/components/Pager';

export interface IndexFindingView {
  checkId: string;
  object: string;
  message: string;
}

interface Row extends IndexFindingView {
  schema: string;
  name: string;
  gigabytes: number | null;
}

interface SchemaGroup {
  schema: string;
  gigabytes: number;
  rows: Row[];
}

function splitObject(object: string): { schema: string; name: string } {
  const dot = object.indexOf('.');
  if (dot <= 0) return { schema: '(no schema)', name: object };
  return { schema: object.slice(0, dot), name: object.slice(dot + 1) };
}

function gigabytesOf(message: string): number | null {
  const match = /([\d.]+)\s*GB/i.exec(message);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function toRows(findings: IndexFindingView[]): Row[] {
  return findings.map((finding) => {
    const parts = splitObject(finding.object);
    return { ...finding, ...parts, gigabytes: gigabytesOf(finding.message) };
  });
}

function bySchema(rows: Row[]): SchemaGroup[] {
  const map = new Map<string, SchemaGroup>();
  for (const row of rows) {
    const existing = map.get(row.schema);
    if (existing) {
      existing.rows.push(row);
      existing.gigabytes += row.gigabytes ?? 0;
      continue;
    }
    map.set(row.schema, { schema: row.schema, gigabytes: row.gigabytes ?? 0, rows: [row] });
  }
  return [...map.values()].sort(
    (a, b) => b.gigabytes - a.gigabytes || b.rows.length - a.rows.length || a.schema.localeCompare(b.schema),
  );
}

function SchemaBlock({ group, unused }: { group: SchemaGroup; unused: boolean }) {
  const [page, setPage] = useState(1);
  const visible = slicePage(
    [...group.rows].sort((a, b) => (b.gigabytes ?? 0) - (a.gigabytes ?? 0) || a.name.localeCompare(b.name)),
    page,
    ROWS_PER_PAGE,
  );

  return (
    <details className={`check-card ${unused ? 'check-card--warning' : 'check-card--info'}`}>
      <summary className="check-card__head">
        <span className={`tag ${unused ? 'tag--warn' : 'tag--info'}`}>{unused ? 'Unused' : 'Redundant'}</span>
        <div className="check-card__main">
          <span className="check-card__title">{group.schema}</span>
          <span className="check-card__id">
            {group.rows.length} index{group.rows.length === 1 ? '' : 'es'}
            {group.gigabytes > 0 ? ` · ${group.gigabytes.toFixed(1)} GB` : ''}
          </span>
        </div>
        <span className="check-card__chevron" aria-hidden />
      </summary>
      <div className="check-card__body">
        {visible.map((row) => (
          <article key={`${row.checkId}-${row.object}`} className={`finding finding--${unused ? 'warning' : 'info'}`}>
            <div>
              <span className={`tag ${unused ? 'tag--warn' : 'tag--info'}`}>{unused ? 'Unused' : 'Redundant'}</span>
            </div>
            <div className="min-w-0">
              <div className="finding__object font-mono">{row.name}</div>
              <p className="finding__message">{row.message}</p>
            </div>
          </article>
        ))}
        <Pager
          page={page}
          total={group.rows.length}
          size={ROWS_PER_PAGE}
          onPage={setPage}
          label={`${group.schema} indexes`}
        />
      </div>
    </details>
  );
}

function KindSection({ title, unused, rows }: { title: string; unused: boolean; rows: Row[] }) {
  const [page, setPage] = useState(1);
  const groups = bySchema(rows);
  const visible = slicePage(groups, page, GROUPS_PER_PAGE);
  const gigabytes = rows.reduce((total, row) => total + (row.gigabytes ?? 0), 0);

  return (
    <section className="finding-section">
      <div className="finding-section__head">
        <span className="finding-section__title">{title}</span>
        <span className={`tag ${unused ? 'tag--warn' : 'tag--info'}`}>
          {rows.length} · {groups.length} schema{groups.length === 1 ? '' : 's'}
          {gigabytes > 0 ? ` · ${gigabytes.toFixed(0)} GB` : ''}
        </span>
      </div>
      {visible.map((group) => (
        <SchemaBlock key={group.schema} group={group} unused={unused} />
      ))}
      <Pager page={page} total={groups.length} size={GROUPS_PER_PAGE} onPage={setPage} label={`${title} schemas`} />
    </section>
  );
}

export function IndexFindingsList({ findings }: { findings: IndexFindingView[] }) {
  const unused = toRows(findings.filter((finding) => finding.checkId.includes('unused')));
  const redundant = toRows(findings.filter((finding) => !finding.checkId.includes('unused')));

  return (
    <>
      {unused.length > 0 ? <KindSection title="Unused" unused rows={unused} /> : null}
      {redundant.length > 0 ? <KindSection title="Redundant" unused={false} rows={redundant} /> : null}
    </>
  );
}
