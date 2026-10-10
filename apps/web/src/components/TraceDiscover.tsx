'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Sparkline } from '@/components/Sparkline';
import { traceDetailHref } from '@/lib/apm-trace-href';

export type TraceDoc = {
  traceId: string;
  rootService: string | null;
  rootName: string | null;
  startTs: string;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  hasSql: boolean;
  httpStatus: number | null;
  httpMethod?: string | null;
  dbName?: string | null;
  sqlMs?: number | null;
};

type SuggestItem = { value: string; hint: string };

/** Next static / favicons — drown Discover; hide by default (toggle to show). */
function isAssetNoise(route: string | null | undefined): boolean {
  const r = (route ?? '').toLowerCase();
  if (!r) return false;
  return (
    r.includes('/_next/') ||
    r.includes('/static/chunks') ||
    r.includes('/favicon') ||
    r.includes('/icon.svg') ||
    /\.(js|css|map|woff2?|svg|ico)(\?|$)/.test(r)
  );
}

function matchQuery(q: string, hay: string): boolean {
  const raw = q.trim().toLowerCase();
  if (!raw) return true;
  return raw.split(/\s+/).every((part) => {
    if (part.startsWith('service:')) return hay.includes(part.slice(8));
    if (part.startsWith('method:')) return hay.includes(`|${part.slice(7)}|`);
    if (part.startsWith('status:')) return hay.includes(`|${part.slice(7)}|`);
    if (part.startsWith('db:')) return hay.includes(part.slice(3));
    if (part === 'has:sql') return hay.includes('|sql|');
    if (part === 'has:error' || part === 'has:err') return hay.includes('|err|');
    return hay.includes(part);
  });
}

function currentToken(q: string): { prefix: string; token: string } {
  const m = q.match(/^(.*?)(\S*)$/);
  return { prefix: m?.[1] ?? '', token: m?.[2] ?? '' };
}

function buildTraceSuggestions(traces: TraceDoc[], query: string): SuggestItem[] {
  const { token } = currentToken(query);
  const t = token.toLowerCase();
  const out: SuggestItem[] = [];
  const seen = new Set<string>();

  function add(value: string, hint: string) {
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    if (t && !key.startsWith(t) && !key.includes(t)) return;
    seen.add(key);
    out.push({ value, hint });
  }

  const services = [...new Set(traces.map((x) => x.rootService).filter(Boolean) as string[])].sort();
  const routes = [...new Set(traces.map((x) => x.rootName).filter(Boolean) as string[])].sort();
  const methods = [
    ...new Set(
      traces.map((x) => x.httpMethod?.toUpperCase()).filter(Boolean) as string[],
    ),
  ].sort();
  const statuses = [
    ...new Set(
      traces
        .map((x) => (x.httpStatus != null ? String(x.httpStatus) : null))
        .filter(Boolean) as string[],
    ),
  ].sort();
  const dbs = [...new Set(traces.map((x) => x.dbName).filter(Boolean) as string[])].sort();

  if (!t || t.startsWith('has:')) {
    add('has:sql', 'traces with SQL spans');
    add('has:error', 'traces with errors');
  }
  if (!t || t.startsWith('service:') || (!t.includes(':') && t.length > 0)) {
    for (const s of services) add(`service:${s}`, 'service');
  }
  if (!t || t.startsWith('method:')) {
    for (const m of methods) add(`method:${m}`, 'HTTP method');
  }
  if (!t || t.startsWith('status:')) {
    for (const s of statuses) add(`status:${s}`, 'HTTP status');
  }
  if (!t || t.startsWith('db:')) {
    for (const d of dbs) add(`db:${d}`, 'database');
  }
  if (!t.includes(':')) {
    for (const r of routes.slice(0, 12)) add(r, 'route');
    if (!t) {
      add('service:', 'filter by service');
      add('method:', 'filter by method');
      add('status:', 'filter by status');
      add('db:', 'filter by database');
    }
  }

  return out.slice(0, 10);
}

function sqlPct(t: TraceDoc): number | null {
  if (t.sqlMs == null || !Number.isFinite(t.sqlMs) || t.durationMs <= 0) return null;
  return Math.min(100, Math.round((t.sqlMs / t.durationMs) * 100));
}

function rowTone(t: TraceDoc): 'down' | 'slow' | 'up' {
  if (t.errorCount > 0) return 'down';
  if (t.hasSql) return 'slow';
  return 'up';
}

const PAGE_SIZE_OPTIONS = [5, 10] as const;

export function TraceDiscover({
  traces,
  initialQuery = '',
  listContext,
}: {
  traces: TraceDoc[];
  /** Optional filter; cleared automatically when it matches nothing. */
  initialQuery?: string;
  /** Preserved on waterfall links so Back restores Discover state. */
  listContext?: {
    service?: string | null;
    w?: string | null;
    q?: string | null;
    from?: string | null;
    to?: string | null;
  };
}) {
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(0);
  const [hideAssets, setHideAssets] = useState(true);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (hideAssets && isAssetNoise(t.rootName)) return false;
      const hay = `|${t.rootService ?? ''}|${t.rootName ?? ''}|${t.traceId}|${
        t.hasSql ? 'sql' : ''
      }|${t.errorCount > 0 ? 'err' : ''}|${t.dbName ?? ''}|${(
        t.httpMethod ?? ''
      ).toLowerCase()}|${t.httpStatus ?? ''}|`.toLowerCase();
      return matchQuery(query, hay);
    });
  }, [traces, query, hideAssets]);

  const suggestions = useMemo(
    () => buildTraceSuggestions(traces, query),
    [traces, query],
  );

  useEffect(() => {
    setPage(0);
  }, [query, pageSize, hideAssets]);

  useEffect(() => {
    setActiveSuggest(0);
  }, [suggestions]);

  function applySuggestion(value: string) {
    const { prefix } = currentToken(query);
    const next =
      value.endsWith(':') && !value.slice(0, -1).includes(':')
        ? `${prefix}${value}`
        : `${prefix}${value} `;
    setQuery(next);
    setSuggestOpen(value.endsWith(':'));
    setActiveSuggest(0);
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = filtered.length === 0 ? 0 : safePage * pageSize;
  const pageDocs = useMemo(
    () => filtered.slice(pageStart, pageStart + pageSize),
    [filtered, pageStart, pageSize],
  );

  const hist = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const t of filtered) {
      const d = new Date(t.startTs);
      const label = `${d.getHours().toString().padStart(2, '0')}:${String(
        Math.floor(d.getMinutes() / 5) * 5,
      ).padStart(2, '0')}`;
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .map(([t, count]) => ({ t, count }))
      .sort((a, b) => a.t.localeCompare(b.t));
  }, [filtered]);

  function routeSpark(t: TraceDoc): number[] {
    const vals = traces
      .filter(
        (x) =>
          (x.rootService ?? '') === (t.rootService ?? '') &&
          (x.rootName ?? '') === (t.rootName ?? ''),
      )
      .slice()
      .sort((a, b) => +new Date(a.startTs) - +new Date(b.startTs))
      .map((x) => x.durationMs)
      .slice(-24);
    if (vals.length === 1) return [vals[0]!, vals[0]!];
    return vals;
  }

  return (
    <div className="discover">
      <div className="discover__toolbar">
        <div className="svc-search discover__kql-wrap">
          <input
            className="input discover__kql"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSuggestOpen(true);
              setActiveSuggest(0);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => {
              window.setTimeout(() => setSuggestOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (!suggestOpen || suggestions.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveSuggest((i) => Math.min(i + 1, suggestions.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveSuggest((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                const pick = suggestions[activeSuggest];
                if (pick) {
                  e.preventDefault();
                  applySuggestion(pick.value);
                }
              } else if (e.key === 'Escape') {
                setSuggestOpen(false);
              }
            }}
            placeholder="Filter · try has:  service:  method:  status:  db:"
            spellCheck={false}
            aria-label="Filter traces"
            aria-autocomplete="list"
            aria-expanded={suggestOpen && suggestions.length > 0}
            autoComplete="off"
          />
          {suggestOpen && suggestions.length > 0 ? (
            <ul className="svc-search__dropdown" role="listbox">
              {suggestions.map((s, idx) => (
                <li key={s.value} role="option" aria-selected={idx === activeSuggest}>
                  <button
                    type="button"
                    className={`svc-search__option ${idx === activeSuggest ? 'is-active' : ''}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      applySuggestion(s.value);
                    }}
                    onMouseEnter={() => setActiveSuggest(idx)}
                  >
                    <span className="font-mono">{s.value}</span>
                    <span className="svc-search__meta">{s.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {query.trim() ? (
          <button type="button" className="btn" onClick={() => setQuery('')}>
            Clear
          </button>
        ) : null}
        <button
          type="button"
          className={`tag ${hideAssets ? 'tag--info' : 'tag--muted'}`}
          title="Hide /_next, favicon, .js/.css asset noise"
          onClick={() => setHideAssets((v) => !v)}
        >
          {hideAssets ? 'Hide assets' : 'Show assets'}
        </button>
        <span className="discover__hits">
          <strong>{filtered.length}</strong>
          {(query.trim() || hideAssets) && filtered.length !== traces.length
            ? ` / ${traces.length}`
            : null}{' '}
          endpoints
        </span>
      </div>

      <div className="discover__chart panel">
        <div className="panel-header">
          <span className="panel-title">Trace volume</span>
        </div>
        <div className="discover__chart-body">
          {hist.length === 0 ? (
            <div className="empty">
              {traces.length > 0 && query.trim() ? (
                <>
                  No traces match <span className="font-mono">{query}</span>
                  {' · '}
                  <button type="button" className="underline" onClick={() => setQuery('')}>
                    clear filter
                  </button>
                </>
              ) : (
                <>
                  No traces in view —{' '}
                  <a href="/observability/apm/setup" className="underline">
                    Add APM
                  </a>{' '}
                  or <span className="font-mono">npm run otel:emit</span>
                </>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={hist} barCategoryGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--accent)" name="traces" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <section className="discover__docs panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="panel-title">Documents</span>
          <span className="muted text-xs">OTLP traces · click a row for waterfall</span>
          <div className="trace-legend" aria-label="Row color legend">
            <span className="trace-legend__item">
              <i className="trace-legend__swatch trace-legend__swatch--ok" />
              OK
            </span>
            <span className="trace-legend__item">
              <i className="trace-legend__swatch trace-legend__swatch--sql" />
              Has SQL
            </span>
            <span className="trace-legend__item">
              <i className="trace-legend__swatch trace-legend__swatch--err" />
              Errors
            </span>
          </div>
        </div>
        <div className="panel-body p-0">
          {filtered.length === 0 ? (
            <div className="empty">
              {traces.length === 0 ? (
                <>
                  No traces in this window —{' '}
                  <Link href="/observability/apm/setup" className="underline">
                    Add APM
                  </Link>{' '}
                  or widen the time range.
                </>
              ) : query.trim() ? (
                <>
                  No hits for <span className="font-mono">{query}</span>
                  {' · '}
                  <button type="button" className="underline" onClick={() => setQuery('')}>
                    clear filter
                  </button>
                </>
              ) : (
                'No hits in this filter.'
              )}
            </div>
          ) : (
            <>
              <div className="discover__docs-list">
              <div className="discover-hit discover-hit--head" aria-hidden>
                <div className="discover-hit__bar" />
                <div className="discover-hit__body">
                  <div className="discover-hit__meta discover-hit__meta--trace">
                    <span className="discover-hit__time">Time</span>
                    <span className="discover-hit__svc">Service</span>
                    <span className="discover-hit__name">Endpoint</span>
                    <span className="discover-hit__spark">Trend</span>
                    <span className="discover-hit__ms">Duration</span>
                    <span className="discover-hit__method">Method</span>
                    <span className="discover-hit__db">DB</span>
                    <span className="discover-hit__sqlpct">SQL %</span>
                    <span className="discover-hit__tags">Meta</span>
                  </div>
                </div>
              </div>
              {pageDocs.map((t) => {
                const tone = rowTone(t);
                const pct = sqlPct(t);
                return (
                  <Link
                    key={t.traceId}
                    href={traceDetailHref(t.traceId, {
                      service: listContext?.service,
                      w: listContext?.w,
                      from: listContext?.from,
                      to: listContext?.to,
                      q: query.trim() || listContext?.q || null,
                    })}
                    className={`discover-hit discover-hit--${tone}`}
                    style={{ display: 'flex', textDecoration: 'none', color: 'inherit' }}
                  >
                    <div className="discover-hit__bar" aria-hidden />
                    <div className="discover-hit__body">
                      <div className="discover-hit__meta discover-hit__meta--trace">
                        <span className="discover-hit__time font-mono text-[10px] text-foreground-muted">
                          {new Date(t.startTs).toLocaleTimeString('es-MX', { hour12: false })}
                        </span>
                        <span className="discover-hit__svc font-mono text-[11px]">
                          {t.rootService ?? '—'}
                        </span>
                        <span className="discover-hit__name underline font-mono text-[12px] font-medium">
                          {t.rootName ?? t.traceId.slice(0, 16)}
                        </span>
                        <span className="discover-hit__spark" title="Latency trend (same route)">
                          <Sparkline
                            values={routeSpark(t)}
                            width={72}
                            height={20}
                            color={tone === 'down' ? '#b01818' : '#005eb8'}
                          />
                        </span>
                        <span className="discover-hit__ms num text-foreground-muted">
                          {Math.round(t.durationMs)} ms
                        </span>
                        <span className="discover-hit__method font-mono text-[10px] text-foreground-muted">
                          {t.httpMethod ?? '—'}
                        </span>
                        <span
                          className="discover-hit__db font-mono text-[10px] text-foreground-muted"
                          title={t.dbName ?? undefined}
                        >
                          {t.dbName ?? (t.hasSql ? 'SQL' : '—')}
                        </span>
                        <span className="discover-hit__sqlpct num text-[10px] text-foreground-muted">
                          {pct != null ? `${pct}%` : '—'}
                        </span>
                        <span className="discover-hit__tags">
                          <span className="tag tag--muted">{t.spanCount} spans</span>
                          {t.hasSql ? (
                            <span className="tag tag--info">SQL</span>
                          ) : (
                            <span className="discover-hit__tag-slot" aria-hidden />
                          )}
                          {t.httpStatus != null ? (
                            <span className="tag tag--muted">{t.httpStatus}</span>
                          ) : (
                            <span className="discover-hit__tag-slot" aria-hidden />
                          )}
                          {t.errorCount > 0 ? (
                            <span className="tag tag--error">{t.errorCount} err</span>
                          ) : (
                            <span className="discover-hit__tag-slot" aria-hidden />
                          )}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
              </div>
              <div className="discover__pager">
                <span>
                  Showing <strong>{pageStart + 1}</strong>–
                  <strong>{Math.min(filtered.length, pageStart + pageSize)}</strong> of{' '}
                  <strong>{filtered.length}</strong>
                  {query.trim() ? (
                    <span className="text-foreground-muted"> · filter active</span>
                  ) : null}
                  {' · '}
                  <span className="text-foreground-muted">use Prev/Next to browse</span>
                </span>
                <div className="discover__pager-controls">
                  <label className="discover__pager-size">
                    Per page
                    <select
                      className="input py-0.5"
                      value={pageSize}
                      onChange={(e) =>
                        setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])
                      }
                    >
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={safePage <= 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Prev
                  </button>
                  <span className="font-mono text-[11px]">
                    {safePage + 1} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
