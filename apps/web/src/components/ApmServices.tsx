'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Sparkline } from '@/components/Sparkline';
import type { ApmServiceRow } from '@/lib/traces';

function pct(n: number): string {
  return `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`;
}

function ms(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Math.round(v));
}

export function ApmServices({
  services,
  windowLabel,
  expandHref = null,
  olderCount = 0,
}: {
  services: Array<
    Omit<ApmServiceRow, 'lastSeenAt'> & { lastSeenAt: string | null }
  >;
  windowLabel: string;
  expandHref?: string | null;
  olderCount?: number;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return services;
    return services.filter(
      (s) =>
        s.serviceName.toLowerCase().includes(needle) ||
        s.dependsOn.some((d) => d.alias.toLowerCase().includes(needle)),
    );
  }, [services, q]);

  if (services.length === 0) {
    return (
      <div className="empty">
        No OTLP traces in the last {windowLabel}.
        {olderCount > 0 && expandHref ? (
          <>
            {' '}
            Found <strong>{olderCount}</strong> older trace(s) —{' '}
            <Link href={expandHref} className="underline">
              show all
            </Link>
            .
          </>
        ) : (
          <>
            {' '}
            Point an OpenTelemetry exporter at{' '}
            <span className="font-mono">POST /api/otlp/v1/traces</span>.
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="discover__toolbar">
        <input
          className="input discover__kql"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter services or DB…"
          spellCheck={false}
        />
        <span className="discover__hits">
          <strong>{filtered.length}</strong> services · {windowLabel}
        </span>
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Depends on</th>
                <th className="text-right">Traces</th>
                <th className="text-right" title="Typical (p50) — half of requests are faster">
                  Typical
                  <div className="text-[9px] font-normal text-foreground-muted">p50</div>
                </th>
                <th
                  className="text-right"
                  title="Worst (p99) — rare slow spikes. Higher ms = worse, not faster"
                >
                  Worst
                  <div className="text-[9px] font-normal text-foreground-muted">p99</div>
                </th>
                <th
                  className="text-right"
                  title="Best (min) — fastest sample in the window. Lower ms is better"
                >
                  Best
                  <div className="text-[9px] font-normal text-foreground-muted">min</div>
                </th>
                <th>Latency trend</th>
                <th className="text-right">Error %</th>
                <th className="text-right">SQL</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.serviceName}>
                  <td>
                    <Link
                      href={`/observability/services/${encodeURIComponent(s.serviceName)}`}
                      className="font-mono underline"
                    >
                      {s.serviceName}
                    </Link>
                  </td>
                  <td>
                    {s.dependsOn.length === 0 ? (
                      <span className="text-[11px] text-foreground-muted">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {s.dependsOn.map((d) => (
                          <Link
                            key={d.instanceId}
                            href={`/instances/${d.instanceId}`}
                            className="tag tag--muted"
                            title={
                              d.source === 'dep'
                                ? 'From service_deps'
                                : 'Inferred from OTLP db.name'
                            }
                          >
                            {d.alias}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="num">{s.traceCount}</td>
                  <td className="num font-mono text-[12px]">{ms(s.p50DurationMs)}</td>
                  <td className="num font-mono text-[12px]">{ms(s.p99DurationMs)}</td>
                  <td className="num font-mono text-[12px]">{ms(s.bestDurationMs)}</td>
                  <td className="text-accent">
                    <Sparkline
                      values={s.latencySpark}
                      width={96}
                      height={22}
                      color={
                        (s.p99DurationMs ?? s.p95DurationMs ?? 0) >= 1000
                          ? '#b01818'
                          : (s.p99DurationMs ?? s.p95DurationMs ?? 0) >= 500
                            ? '#a15c00'
                            : '#005eb8'
                      }
                      title={`${s.serviceName} latency`}
                    />
                  </td>
                  <td className="num">
                    <span
                      className={`tag ${
                        s.errorRate >= 0.05
                          ? 'tag--error'
                          : s.errorRate > 0
                            ? 'tag--warn'
                            : 'tag--ok'
                      }`}
                    >
                      {pct(s.errorRate)}
                    </span>
                  </td>
                  <td className="num">{s.sqlTraces || '—'}</td>
                  <td className="text-[11px] text-foreground-muted">
                    {s.lastSeenAt
                      ? new Date(s.lastSeenAt).toLocaleTimeString('es-MX', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          hour12: false,
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
