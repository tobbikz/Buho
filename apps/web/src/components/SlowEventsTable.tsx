'use client';

import Link from 'next/link';
import { formatAgo, formatNumber } from '@/lib/format';
import { ListPager, useListPage } from '@/components/ListPager';

const SOURCE_LABEL: Record<string, string> = {
  digest: 'digest',
  slow_log: 'slow_log',
  processlist: 'processlist',
  slowlog: 'slowlog',
};

export type SlowEventView = {
  ts: string;
  queryid: string;
  database: string | null;
  query: string;
  durationSec: number;
  rowsExamined: number | null;
  source: string;
};

export function SlowEventsTable({
  instanceId,
  events,
}: {
  instanceId: number;
  events: SlowEventView[];
}) {
  const { page, setPage, pageCount, rows, pageSize } = useListPage(events, 10);

  if (events.length === 0) {
    return (
      <div className="panel-body empty">
        No slow events captured. With performance_schema, digests emit when max latency climbs past 1s.
        Without it, PROCESSLIST samples running statements ≥1s. With{' '}
        <span className="font-mono">slow_query_log</span> +{' '}
        <span className="font-mono">log_output=TABLE</span>, rows from{' '}
        <span className="font-mono">mysql.slow_log</span> appear here.
      </div>
    );
  }

  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Source</th>
            <th>Query</th>
            <th>Database</th>
            <th className="text-right">Duration</th>
            <th className="text-right">Rows exam.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.ts}-${row.queryid}-${row.source}-${page * pageSize + index}`}>
              <td className="font-mono text-[11px] text-foreground-muted">
                {formatAgo(new Date(row.ts))}
              </td>
              <td>
                <span className="tag tag--muted">{SOURCE_LABEL[row.source] ?? row.source}</span>
              </td>
              <td className="font-mono text-[11px] max-w-[24rem]">
                <Link
                  href={`/instances/${instanceId}/queries/${row.queryid}`}
                  className="text-accent hover:underline"
                >
                  {row.query.slice(0, 120)}
                  {row.query.length > 120 ? '…' : ''}
                </Link>
              </td>
              <td className="font-mono text-[11px] text-foreground-muted">
                {row.database ?? '—'}
              </td>
              <td className="num">{formatNumber(row.durationSec, 3)} s</td>
              <td className="num">
                {row.rowsExamined == null ? '—' : formatNumber(row.rowsExamined)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListPager
        page={page}
        pageCount={pageCount}
        total={events.length}
        pageSize={pageSize}
        onPageChange={setPage}
      />
    </>
  );
}
