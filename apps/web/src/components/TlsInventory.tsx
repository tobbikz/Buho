'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatAgo } from '@/lib/format';
import type { TlsCertRow } from '@/lib/obs-infra';

type Filter = 'certs' | 'all' | 'critical' | 'warn' | 'ok' | 'unknown';

function statusLabel(status: TlsCertRow['status']): string {
  if (status === 'ok') return 'Valid';
  if (status === 'warn') return 'Expiring';
  if (status === 'critical') return 'Critical';
  return 'No TLS';
}

function statusTag(status: TlsCertRow['status']): string {
  if (status === 'ok') return 'tag tag--ok';
  if (status === 'warn') return 'tag tag--warn';
  if (status === 'critical') return 'tag tag--error';
  return 'tag tag--muted';
}

function schemeHint(c: Pick<TlsCertRow, 'tlsDays' | 'port'>): string {
  if (c.tlsDays != null || c.port === 443) return 'https';
  return 'http';
}

export function TlsInventory({
  certs,
}: {
  certs: Array<
    Omit<TlsCertRow, 'lastSeenAt'> & { lastSeenAt: string | null }
  >;
}) {
  const [filter, setFilter] = useState<Filter>('certs');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    let critical = 0;
    let warn = 0;
    let ok = 0;
    let unknown = 0;
    for (const c of certs) {
      if (c.status === 'critical') critical += 1;
      else if (c.status === 'warn') warn += 1;
      else if (c.status === 'ok') ok += 1;
      else unknown += 1;
    }
    return { critical, warn, ok, unknown, withCert: critical + warn + ok };
  }, [certs]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return certs.filter((c) => {
      if (filter === 'certs' && c.status === 'unknown') return false;
      if (filter === 'critical' && c.status !== 'critical') return false;
      if (filter === 'warn' && c.status !== 'warn') return false;
      if (filter === 'ok' && c.status !== 'ok') return false;
      if (filter === 'unknown' && c.status !== 'unknown') return false;
      if (!needle) return true;
      const hay = `${c.alias} ${c.host} ${c.port} ${statusLabel(c.status)}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [certs, filter, q]);

  const chips: Array<{ id: Filter; label: string }> = [
    { id: 'certs', label: `With cert (${counts.withCert})` },
    { id: 'critical', label: `Critical (${counts.critical})` },
    { id: 'warn', label: `Expiring (${counts.warn})` },
    { id: 'ok', label: `Valid (${counts.ok})` },
    { id: 'unknown', label: `No TLS (${counts.unknown})` },
    { id: 'all', label: `All (${certs.length})` },
  ];

  return (
    <section className="panel">
      <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <span className="panel-title">Certificate inventory</span>
        <span className="muted text-xs">
          {filtered.length} shown · HTTPS probes only get days-left samples
        </span>
      </div>
      <div className="panel-body space-y-3">
        <div className="discover__toolbar" style={{ margin: 0 }}>
          <input
            className="input discover__kql"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter · e.g. httpbin · critical · :443"
            spellCheck={false}
            aria-label="Filter certificates"
          />
          <span className="discover__hits">
            <strong>{filtered.length}</strong> hits
            {filter === 'certs' || filter === 'all' ? (
              <>
                {' '}
                · {counts.critical} critical · {counts.warn} expiring · {counts.ok} valid
                {filter === 'all' ? ` · ${counts.unknown} no TLS` : null}
              </>
            ) : null}
          </span>
        </div>
        <div className="discover__fields-list" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`discover__field-chip${filter === chip.id ? ' discover__field-chip--on' : ''}`}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            {filter === 'certs' && counts.withCert === 0 ? (
              <>
                No HTTPS probes with a certificate sample yet. Add a probe to an{' '}
                <span className="font-mono">https://</span> URL, or show{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setFilter('unknown')}
                >
                  No TLS ({counts.unknown})
                </button>{' '}
                HTTP monitors.
              </>
            ) : (
              <>No certificates match this filter.</>
            )}
          </div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Monitor</th>
                  <th>Target</th>
                  <th className="num">Days left</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.instanceId}>
                    <td>
                      <span className={statusTag(c.status)}>{statusLabel(c.status)}</span>
                    </td>
                    <td>
                      <Link
                        href={`/observability/services/${encodeURIComponent(c.alias)}?tab=uptime`}
                        className="check-score__instance"
                      >
                        {c.alias}
                      </Link>
                    </td>
                    <td className="font-mono text-[11px]">
                      <span className="text-foreground-muted">{schemeHint(c)}://</span>
                      {c.host}:{c.port}
                    </td>
                    <td
                      className={`num font-mono text-[12px]${
                        c.status === 'critical'
                          ? ' text-[var(--error)]'
                          : c.status === 'warn'
                            ? ' text-[var(--warning)]'
                            : ''
                      }`}
                    >
                      {c.tlsDays == null ? '—' : Math.floor(c.tlsDays)}
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted">
                      {c.lastSeenAt ? formatAgo(new Date(c.lastSeenAt)) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
