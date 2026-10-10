'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Sparkline } from '@/components/Sparkline';
import { ServiceRowMenu } from '@/components/ServiceRowMenu';
import type { InventoryEntity, InventorySource } from '@/lib/obs-infra';
import { servicePath } from '@/lib/obs-service';
import type { ObsTagEntityKind } from '@/lib/obs-tags-shared';

/**
 * Latency in milliseconds — higher = slower = worse.
 * Columns (left → right): Typical (p50) · Worst (p99) · Best (min).
 */
export const LATENCY_LABELS = {
  typical: {
    short: 'Typical',
    full: 'Typical (p50): half of requests finish faster than this. Lower ms is better.',
  },
  worst: {
    short: 'Worst',
    full: 'Worst (p99): rare spikes — almost the slowest requests. Higher ms = worse, not faster.',
  },
  best: {
    short: 'Best',
    full: 'Best (min): fastest sample in the window. Lower ms is better.',
  },
} as const;

type StatusFilter = 'all' | 'ok' | 'degraded' | 'down';
type SourceFilter = 'all' | InventorySource;

function ms(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 10) return `${v.toFixed(1)}ms`;
  return `${Math.round(v)}ms`;
}

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(v >= 0.999 || v < 0.01 ? 1 : 0)}%`;
}

function latencyColor(worstMs: number | null): string {
  if (worstMs == null) return '#005eb8';
  if (worstMs >= 1000) return '#b01818';
  if (worstMs >= 500) return '#a15c00';
  return '#005eb8';
}

function statusTone(e: InventoryEntity): 'ok' | 'warn' | 'error' | 'muted' {
  if (e.hasUptime && e.up === false) return 'error';
  if (e.errorRate != null && e.errorRate >= 0.05) return 'error';
  // APM is required for a complete service — uptime-only is incomplete.
  if (!e.hasTraces) return 'warn';
  // Align with score thresholds (≥1% warn) — ignore sub-display noise that prints as 0.0%.
  if (e.errorRate != null && e.errorRate >= 0.01) return 'warn';
  if (e.p99Ms != null && e.p99Ms >= 1000) return 'warn';
  if (e.p95Ms != null && e.p95Ms >= 1000) return 'warn';
  if (e.availability != null && e.availability < 0.99) return 'warn';
  if (e.up === true || (e.availability != null && e.availability >= 0.99)) return 'ok';
  return 'muted';
}

function tagTargets(e: InventoryEntity): Array<{ entityKind: ObsTagEntityKind; entityKey: string }> {
  const out: Array<{ entityKind: ObsTagEntityKind; entityKey: string }> = [];
  if (e.hasTraces) out.push({ entityKind: 'apm', entityKey: e.name });
  if (e.hasUptime && e.monitorInstanceId != null) {
    out.push({ entityKind: 'synthetics', entityKey: String(e.monitorInstanceId) });
  }
  if (out.length === 0) out.push({ entityKind: 'apm', entityKey: e.name });
  return out;
}

function matchesSourceFilter(e: InventoryEntity, source: SourceFilter): boolean {
  if (source === 'all') return true;
  if (source === 'both') return e.source === 'both';
  if (source === 'apm') return e.hasTraces;
  if (source === 'synthetics') return e.hasUptime;
  return true;
}

function statusBucket(e: InventoryEntity): Exclude<StatusFilter, 'all'> {
  const tone = statusTone(e);
  if (tone === 'error' || e.up === false) return 'down';
  if (tone === 'warn') return 'degraded';
  return 'ok';
}

export function ObsInventoryTable({
  entities,
  initialSource = 'all',
}: {
  entities: InventoryEntity[];
  initialSource?: SourceFilter;
}) {
  const [q, setQ] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(0);
  const [source, setSource] = useState<SourceFilter>(initialSource);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [tagError, setTagError] = useState<string | null>(null);
  const [rows, setRows] = useState(entities);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    setRows(entities);
  }, [entities]);

  useEffect(() => {
    setSource(initialSource);
  }, [initialSource]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of rows) for (const t of e.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const suggestions = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 1) return [];
    return rows
      .filter((e) => matchesSourceFilter(e, source))
      .filter((e) => {
        const hay = [e.name, e.subtitle, ...e.tags].join(' ').toLowerCase();
        return hay.includes(needle);
      })
      .slice(0, 8);
  }, [rows, q, source]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((e) => {
      if (!matchesSourceFilter(e, source)) return false;
      if (status !== 'all' && statusBucket(e) !== status) return false;
      if (tagFilter !== 'all' && !e.tags.includes(tagFilter)) return false;
      if (!needle) return true;
      const hay = [
        e.name,
        e.subtitle,
        e.source,
        e.hasTraces ? 'traces apm' : '',
        e.hasUptime ? 'probe http' : '',
        ...e.tags,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q, source, status, tagFilter]);

  async function mutateTag(
    entity: InventoryEntity,
    action: 'add' | 'remove',
    tag: string,
  ) {
    setTagError(null);
    const targets = tagTargets(entity);
    let nextTag = tag.toLowerCase();
    for (const target of targets) {
      const res = await fetch('/api/observability/tags', {
        method: action === 'add' ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityKind: target.entityKind,
          entityKey: target.entityKey,
          tag,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tag?: string;
        error?: string;
      };
      if (!res.ok) {
        setTagError(data.error ?? `Could not ${action} tag`);
        return;
      }
      if (data.tag) nextTag = data.tag;
    }
    startTransition(() => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== entity.id) return r;
          const tags =
            action === 'add'
              ? [...new Set([...r.tags, nextTag])].sort((a, b) => a.localeCompare(b))
              : r.tags.filter((t) => t !== nextTag);
          return { ...r, tags };
        }),
      );
      if (action === 'add') {
        setTagDraft((d) => ({ ...d, [entity.id]: '' }));
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <span className="panel-title">Services</span>
        <div
          className="discover__toolbar"
          style={{ flex: 1, margin: 0, minWidth: '12rem', flexWrap: 'wrap', gap: '0.4rem' }}
        >
          <div className="svc-search">
            <input
              className="input discover__kql"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSuggestOpen(true);
                setActiveSuggest(0);
              }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => {
                // Allow click on suggestion before closing.
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
                } else if (e.key === 'Enter') {
                  const pick = suggestions[activeSuggest];
                  if (pick) {
                    e.preventDefault();
                    setQ(pick.name);
                    setSuggestOpen(false);
                    router.push(pick.href);
                  }
                } else if (e.key === 'Escape') {
                  setSuggestOpen(false);
                }
              }}
              placeholder="Search services…"
              spellCheck={false}
              aria-label="Search services"
              aria-autocomplete="list"
              aria-expanded={suggestOpen && suggestions.length > 0}
              autoComplete="off"
            />
            {suggestOpen && suggestions.length > 0 ? (
              <ul className="svc-search__dropdown" role="listbox">
                {suggestions.map((s, idx) => (
                  <li key={s.id} role="option" aria-selected={idx === activeSuggest}>
                    <button
                      type="button"
                      className={`svc-search__option ${idx === activeSuggest ? 'is-active' : ''}`}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        setQ(s.name);
                        setSuggestOpen(false);
                        router.push(s.href);
                      }}
                      onMouseEnter={() => setActiveSuggest(idx)}
                    >
                      <span className="font-mono">{s.name}</span>
                      <span className="svc-search__meta">
                        {s.hasTraces ? 'APM' : null}
                        {s.hasTraces && s.hasUptime ? ' · ' : null}
                        {s.hasUptime ? 'PROBE' : null}
                        {!s.hasTraces ? ' · needs APM' : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {/* Lens comes from page tabs (All / APM / PROBES) — no duplicate dropdown. */}
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            aria-label="Filter by status"
            style={{ width: 'auto', minWidth: '8rem' }}
          >
            <option value="all">Status: All</option>
            <option value="ok">OK</option>
            <option value="degraded">Degraded</option>
            <option value="down">Down / failing</option>
          </select>
          <select
            className="input"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            aria-label="Filter by tag"
            style={{ width: 'auto', minWidth: '8rem' }}
          >
            <option value="all">Tag: All</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tagError ? (
        <div className="px-3 pb-2 text-[12px] text-[var(--color-error,#b01818)]">{tagError}</div>
      ) : null}
      {pending ? (
        <div className="px-3 pb-1 text-[11px] text-foreground-muted">Updating…</div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="panel-body text-[13px] text-foreground-muted">
          No services match the current filters. Clear search or reset dropdowns.
        </div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 'none' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="svc-row-menu-col" aria-label="Actions" />
                <th>Service</th>
                <th>Status</th>
                <th>Tags</th>
                <th title={LATENCY_LABELS.typical.full}>{LATENCY_LABELS.typical.short}</th>
                <th title={LATENCY_LABELS.worst.full}>{LATENCY_LABELS.worst.short}</th>
                <th title={LATENCY_LABELS.best.full}>{LATENCY_LABELS.best.short}</th>
                <th>Latency trend</th>
                <th className="text-right">Health</th>
                <th className="text-right">Volume</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const tone = statusTone(e);
                return (
                  <tr key={e.id} className={`obs-inventory-row obs-inventory-row--${tone}`}>
                    <td className="svc-row-menu-col">
                      <ServiceRowMenu entity={e} />
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={e.href} className="check-score__instance font-mono">
                          {e.name}
                        </Link>
                        {e.hasTraces ? (
                          <Link
                            href={servicePath(e.name, 'traces')}
                            className="tag tag--muted"
                            title={`Open Traces for ${e.name}`}
                            aria-label={`Open Traces for ${e.name}`}
                          >
                            Traces
                          </Link>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {e.hasUptime && e.up != null ? (
                        <span className={`tag ${e.up ? 'tag--ok' : 'tag--error'}`}>
                          {e.up ? 'up' : 'down'}
                        </span>
                      ) : (
                        <span
                          className={`tag ${
                            tone === 'error'
                              ? 'tag--error'
                              : tone === 'warn'
                                ? 'tag--warn'
                                : 'tag--ok'
                          }`}
                        >
                          {tone === 'error' ? 'failing' : tone === 'warn' ? 'degraded' : 'ok'}
                        </span>
                      )}
                    </td>
                    <td style={{ minWidth: '11rem' }}>
                      <div className="flex flex-wrap gap-1 items-center">
                        {e.tags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="tag tag--info"
                            title={`Remove tag ${t}`}
                            onClick={() => void mutateTag(e, 'remove', t)}
                            style={{ cursor: 'pointer' }}
                          >
                            {t} ×
                          </button>
                        ))}
                        <form
                          className="flex gap-1 items-center"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            const raw = (tagDraft[e.id] ?? '').trim();
                            if (!raw) return;
                            void mutateTag(e, 'add', raw);
                          }}
                        >
                          <input
                            className="input"
                            value={tagDraft[e.id] ?? ''}
                            onChange={(ev) =>
                              setTagDraft((d) => ({ ...d, [e.id]: ev.target.value }))
                            }
                            placeholder="add tag"
                            aria-label={`Add tag to ${e.name}`}
                            style={{
                              width: '6.5rem',
                              padding: '0.15rem 0.35rem',
                              fontSize: '11px',
                              height: '1.6rem',
                            }}
                          />
                          <button
                            type="submit"
                            className="btn"
                            style={{ padding: '0.15rem 0.4rem', fontSize: '11px', height: '1.6rem' }}
                            disabled={!(tagDraft[e.id] ?? '').trim()}
                          >
                            +
                          </button>
                        </form>
                      </div>
                    </td>
                    <td className="font-mono text-[12px]" title={LATENCY_LABELS.typical.full}>
                      {ms(e.p50Ms)}
                    </td>
                    <td className="font-mono text-[12px]" title={LATENCY_LABELS.worst.full}>
                      {ms(e.p99Ms)}
                    </td>
                    <td className="font-mono text-[12px]" title={LATENCY_LABELS.best.full}>
                      {ms(e.bestMs)}
                    </td>
                    <td className="svc-spark-cell">
                      <Sparkline
                        values={e.latencySpark}
                        width={110}
                        height={26}
                        color={latencyColor(e.p99Ms ?? e.p95Ms)}
                        title={`${e.name} latency (avg ms / 5m)`}
                      />
                    </td>
                    <td className="text-right font-mono text-[12px]">
                      {e.hasTraces ? (
                        <span
                          className={
                            (e.errorRate ?? 0) >= 0.05
                              ? 'tag tag--error'
                              : (e.errorRate ?? 0) >= 0.01
                                ? 'tag tag--warn'
                                : 'tag tag--ok'
                          }
                        >
                          {pct(e.errorRate)} errors
                        </span>
                      ) : (
                        <span
                          className={
                            (e.availability ?? 1) < 0.99 ? 'tag tag--warn' : 'tag tag--ok'
                          }
                        >
                          {pct(e.availability)} up
                        </span>
                      )}
                    </td>
                    <td className="text-right font-mono text-[12px]">
                      {e.hasTraces ? (
                        <Link
                          href={servicePath(e.name, 'traces')}
                          className="underline"
                          title={`Open Traces for ${e.name}`}
                          aria-label={`${e.throughput || 0} traces for ${e.name}`}
                        >
                          {e.throughput || '—'}
                          <div className="text-[9px] text-foreground-muted no-underline">
                            traces
                          </div>
                        </Link>
                      ) : (
                        <>
                          {e.throughput || '—'}
                          <div className="text-[9px] text-foreground-muted">samples</div>
                        </>
                      )}
                    </td>
                    <td className="num font-mono text-[12px]">{e.score ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
