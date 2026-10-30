'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import type { ReportInstance, ReportMetric, ReportWaitShare } from '@/lib/report';
import { formatBytes, formatNumber } from '@/lib/format';

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

const WAIT_COLORS: Record<string, string> = {
  Lock: '#b01818',
  IO: '#9a4a00',
  CPU: '#0a6e42',
  IPC: '#5c6b7a',
  LWLock: '#005eb8',
  Client: '#8a5a00',
};

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${value.toFixed(1)} s`;
  if (value < 3600) return `${(value / 60).toFixed(1)} min`;
  return `${(value / 3600).toFixed(1)} h`;
}

function Delta({
  metric,
  digits = 1,
  lowerIsBetter = false,
}: {
  metric: ReportMetric | null;
  digits?: number;
  lowerIsBetter?: boolean;
}) {
  if (!metric || metric.avg === null || metric.prevAvg === null) {
    return <span className="report-delta report-delta--flat" title="No prior-week rollup">n/a</span>;
  }
  const diff = metric.avg - metric.prevAvg;
  if (Math.abs(diff) < 0.05) return <span className="report-delta report-delta--flat">flat</span>;
  const up = diff > 0;
  const good = lowerIsBetter ? !up : up;
  return (
    <span className={`report-delta ${good ? 'report-delta--good' : 'report-delta--bad'}`}>
      {up ? '+' : '−'}
      {Math.abs(diff).toFixed(digits)}
    </span>
  );
}

function scoreTone(score: number | null): string {
  if (score === null) return 'report-score--neutral';
  if (score < 60) return 'report-score--error';
  if (score < 85) return 'report-score--warn';
  return 'report-score--ok';
}

function WaitBar({ profile }: { profile: ReportWaitShare[] }) {
  const top = profile.slice(0, 6);
  return (
    <div className="report-wait-bar" role="img" aria-label="Wait profile distribution">
      {top.map((w) => (
        <div
          key={w.waitType}
          className="report-wait-bar__seg"
          style={{
            width: `${Math.max(w.share * 100, 2)}%`,
            background: WAIT_COLORS[w.waitType] ?? '#a8b0ba',
          }}
          title={`${w.waitType}: ${(w.share * 100).toFixed(1)}% · avg ${w.averageSessions.toFixed(1)} sessions`}
        />
      ))}
    </div>
  );
}

function MetricTable({
  title,
  rows,
}: {
  title: string;
  rows: {
    label: string;
    metric: ReportMetric | null;
    fmt: (v: number | null) => string;
    lowerIsBetter?: boolean;
  }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="report-panel">
      <div className="report-panel__title">{title}</div>
      <div className="table-scroll">
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="text-right">Avg</th>
              <th className="text-right">Peak</th>
              <th className="text-right">Low</th>
              <th className="text-right">Prior wk</th>
              <th className="text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((fila) => (
              <tr key={fila.label}>
                <td>{fila.label}</td>
                <td className="num font-mono">{fila.fmt(fila.metric!.avg)}</td>
                <td className="num font-mono">{fila.fmt(fila.metric!.max)}</td>
                <td className="num font-mono text-foreground-secondary">{fila.fmt(fila.metric!.min)}</td>
                <td className="num font-mono text-foreground-secondary">{fila.fmt(fila.metric!.prevAvg)}</td>
                <td className="num">
                  <Delta metric={fila.metric} lowerIsBetter={fila.lowerIsBetter} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReportInstanceCard({
  row,
}: {
  row: ReportInstance;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const growth =
    row.sizeStartBytes !== null && row.sizeEndBytes !== null
      ? row.sizeEndBytes - row.sizeStartBytes
      : null;
  const scoreDelta =
    row.scoreStart !== null && row.scoreEnd !== null ? row.scoreEnd - row.scoreStart : null;

  const dbMetrics = [
    { label: 'Connections used', metric: row.connectionsPct, fmt: pct, lowerIsBetter: true },
    { label: 'Cache hit ratio', metric: row.cacheHitPct, fmt: pct },
    { label: 'Commits / sec', metric: row.commitsPerSec, fmt: (v: number | null) => formatNumber(v, 1) },
    { label: 'XID age', metric: row.xidAgePct, fmt: pct, lowerIsBetter: true },
    { label: 'Replication lag', metric: row.replicationLag, fmt: seconds, lowerIsBetter: true },
  ].filter((f) => f.metric && f.metric.avg !== null);

  const hostMetrics = [
    { label: 'Host CPU', metric: row.cpuPct, fmt: pct, lowerIsBetter: true },
    { label: 'Host memory', metric: row.memPct, fmt: pct, lowerIsBetter: true },
    { label: 'Disk used', metric: row.diskPct, fmt: pct, lowerIsBetter: true },
  ].filter((f) => f.metric && f.metric.avg !== null);

  const chips: { label: string; tone: string }[] = [];
  if (row.critical > 0) chips.push({ label: `${row.critical} critical`, tone: 'tag--error' });
  if (row.warning > 0) chips.push({ label: `${row.warning} warning`, tone: 'tag--warn' });
  if (row.info > 0) chips.push({ label: `${row.info} info`, tone: 'tag--muted' });
  if (row.lockEpisodes > 0) chips.push({ label: `${row.lockEpisodes} locks`, tone: 'tag--warn' });
  if (growth !== null && growth !== 0) {
    chips.push({
      label: `${growth >= 0 ? '+' : '−'}${formatBytes(Math.abs(growth))}`,
      tone: growth > 0 ? 'tag--warn' : 'tag--ok',
    });
  }

  return (
    <>
      <button type="button" className="report-instance report-instance--button" onClick={() => setOpen(true)}>
        <div className="report-instance__head">
          <span className="report-instance__open-hint">Details</span>
          <div className="report-instance__title">
            <Link
              href={`/instances/${row.instanceId}`}
              className="report-instance__link"
              onClick={(e) => e.stopPropagation()}
            >
              {row.alias}
            </Link>
            <span className="report-instance__meta">
              {row.environment} · {row.engine}
              {row.coveragePct !== null ? ` · ${pct(row.coveragePct, 0)} coverage` : ''}
            </span>
          </div>
          <div className="report-instance__badges">
            {row.scoreEnd !== null ? (
              <span className={`report-score ${scoreTone(row.scoreEnd)}`}>{row.scoreEnd}</span>
            ) : null}
            {chips.map((chip) => (
              <span key={chip.label} className={`tag ${chip.tone}`}>
                {chip.label}
              </span>
            ))}
          </div>
        </div>
      </button>

      <Modal
        open={open}
        title={row.alias}
        subtitle={`${row.environment} · ${row.engine}`}
        onClose={() => setOpen(false)}
      >
      <div className="report-instance__body">
        <div className="report-instance__nav">
          <Link href={`/instances/${row.instanceId}`} className="link">
            Overview
          </Link>
          <Link href={`/instances/${row.instanceId}/checks`} className="link">
            Checks
          </Link>
          <Link href={`/instances/${row.instanceId}/flow`} className="link">
            Flow
          </Link>
          <Link href={`/instances/${row.instanceId}/queries`} className="link">
            Queries
          </Link>
          {row.engine === 'postgres' ? (
            <Link href={`/instances/${row.instanceId}/vacuum`} className="link">
              Vacuum
            </Link>
          ) : null}
        </div>

        <div className="report-snapshot-grid">
          <div className="report-snapshot">
            <span className="report-snapshot__label">Health</span>
            <span className="report-snapshot__value">
              {row.scoreStart !== null && row.scoreEnd !== null
                ? `${row.scoreStart} → ${row.scoreEnd}`
                : row.scoreEnd ?? '—'}
            </span>
            {scoreDelta !== null && scoreDelta !== 0 ? (
              <span className={`report-snapshot__hint ${scoreDelta >= 0 ? 'is-up' : 'is-down'}`}>
                {scoreDelta >= 0 ? '+' : '−'}
                {Math.abs(scoreDelta)} in period
              </span>
            ) : null}
          </div>
          <div className="report-snapshot">
            <span className="report-snapshot__label">Findings at close</span>
            <span className="report-snapshot__value">
              {row.critical}/{row.warning}/{row.info}
            </span>
            <span className="report-snapshot__hint">critical / warning / info</span>
          </div>
          <div className="report-snapshot">
            <span className="report-snapshot__label">Database size</span>
            <span className="report-snapshot__value">
              {row.sizeEndBytes !== null ? formatBytes(row.sizeEndBytes) : '—'}
            </span>
            {growth !== null ? (
              <span className={`report-snapshot__hint ${growth > 0 ? 'is-down' : growth < 0 ? 'is-up' : ''}`}>
                {growth >= 0 ? '+' : '−'}
                {formatBytes(Math.abs(growth))} in week
              </span>
            ) : null}
          </div>
          <div className="report-snapshot">
            <span className="report-snapshot__label">Lock episodes</span>
            <span className="report-snapshot__value">{row.lockEpisodes || '—'}</span>
            <span className="report-snapshot__hint">
              {row.lockWorstSeconds !== null ? `worst wait ${seconds(row.lockWorstSeconds)}` : 'no waits recorded'}
            </span>
          </div>
        </div>

        {row.coveragePct !== null && row.coveragePct < 95 ? (
          <p className="report-note report-note--warn">
            Monitoring covered {pct(row.coveragePct, 0)} of the week ({Math.round((row.coveragePct / 100) * 168)} h of
            168). Averages exclude gaps without samples.
          </p>
        ) : null}

        {dbMetrics.length === 0 && hostMetrics.length === 0 ? (
          <p className="empty">No metric rollups for this instance in the period.</p>
        ) : (
          <div className="report-metrics-grid">
            <MetricTable title="Database" rows={dbMetrics} />
            <MetricTable title="Host" rows={hostMetrics} />
          </div>
        )}

        <div className="report-panel-row">
          <div className="report-panel">
            <div className="report-panel__title">Incidents &amp; logs</div>
            <dl className="report-dl">
              <div>
                <dt>Lock waits</dt>
                <dd>
                  {row.lockEpisodes > 0
                    ? `${row.lockEpisodes} episode${row.lockEpisodes === 1 ? '' : 's'}${
                        row.lockWorstSeconds !== null ? ` · longest ${seconds(row.lockWorstSeconds)}` : ''
                      }`
                    : 'None recorded'}
                </dd>
              </div>
              <div>
                <dt>Log deadlocks</dt>
                <dd>{row.logAvailable ? (row.logDeadlocks > 0 ? row.logDeadlocks : 'None') : 'Log not ingested'}</dd>
              </div>
              <div>
                <dt>Log errors</dt>
                <dd>{row.logAvailable ? (row.logErrors > 0 ? row.logErrors : 'None') : 'Log not ingested'}</dd>
              </div>
            </dl>
          </div>

          {row.waitProfile && row.waitProfile.length > 0 ? (
            <div className="report-panel">
              <div className="report-panel__title">Wait profile · {row.waitSamples.toLocaleString()} samples</div>
              <WaitBar profile={row.waitProfile} />
              <div className="report-wait-legend">
                {row.waitProfile.slice(0, 6).map((w) => (
                  <span key={w.waitType} className="report-wait-legend__item">
                    <span
                      className="report-wait-legend__swatch"
                      style={{ background: WAIT_COLORS[w.waitType] ?? '#a8b0ba' }}
                    />
                    {w.waitType} {(w.share * 100).toFixed(0)}%
                    <span className="text-foreground-muted"> · {w.averageSessions.toFixed(1)} sess</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {row.worstTables.length > 0 ? (
          <div className="report-panel">
            <div className="report-panel__title">Maintenance backlog · top tables by bloat</div>
            <div className="table-scroll">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="text-right">Dead tuples</th>
                    <th className="text-right">Bloat</th>
                    <th className="text-right">Last vacuum</th>
                  </tr>
                </thead>
                <tbody>
                  {row.worstTables.map((table) => (
                    <tr key={`${table.schema}.${table.table}`}>
                      <td className="font-mono text-[11px]">
                        {table.schema}.{table.table}
                      </td>
                      <td className="num font-mono">{pct(table.deadPct)}</td>
                      <td className="num font-mono">
                        {pct(table.bloatPct)}
                        {table.bloatBytes !== null ? (
                          <span className="text-foreground-muted"> ({formatBytes(table.bloatBytes)})</span>
                        ) : null}
                      </td>
                      <td className="num font-mono">{table.lastVacuum ? DATE.format(table.lastVacuum) : 'never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {row.topQueries.length > 0 ? (
          <div className="report-panel">
            <div className="report-panel__title">Top queries by execution time</div>
            <div className="table-scroll">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th className="w-8">#</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Calls</th>
                    <th className="text-right">Mean</th>
                    <th>Query</th>
                  </tr>
                </thead>
                <tbody>
                  {row.topQueries.map((q, index) => (
                    <tr key={q.queryid}>
                      <td className="font-mono text-foreground-muted">{index + 1}</td>
                      <td className="num font-mono">{formatNumber(q.execMs / 1000, 1)} s</td>
                      <td className="num font-mono">{formatNumber(q.calls, 0)}</td>
                      <td className="num font-mono">{q.meanMs.toFixed(1)} ms</td>
                      <td>
                        <Link
                          href={`/instances/${row.instanceId}/queries/${q.queryid}`}
                          className="report-query-link report-query-link--inline"
                        >
                          {(q.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 140)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
      </Modal>
    </>
  );
}
