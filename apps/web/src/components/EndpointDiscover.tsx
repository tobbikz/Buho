'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { ServiceDepsGrouped, type DepDbTarget } from '@/components/ServiceDepEdge';
import { Sparkline } from '@/components/Sparkline';
import type {
  EndpointHistogramBucket,
  EndpointMonitorRow,
  EndpointPathSample,
} from '@/lib/endpoints';

const PAGE_SIZE_OPTIONS = [5, 10] as const;

type AnalyzePath = {
  path: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  dnsMs: number | null;
  ttfbMs: number | null;
  error?: string;
};

type AnalyzeResult = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  paths: AnalyzePath[];
  summary: {
    total: number;
    ok: number;
    down: number;
    slow: number;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
  };
};

type Dep = {
  fromAlias: string | null;
  fromService: string | null;
  fromEngine: string | null;
  toAlias: string;
  toEngine: string;
  toHost: string;
  toPort: number;
  toInstanceId: number;
};

function defaultAliasFromUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.replace(/\./g, '-');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `http-${host}-${port}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
  } catch {
    return 'http-monitor';
  }
}

function monitorForBaseUrl(
  monitors: Array<{ alias: string; host: string; port: number }>,
  baseUrl: string,
): string | null {
  try {
    const u = new URL(baseUrl);
    const port =
      u.port !== ''
        ? Number(u.port)
        : u.protocol === 'https:'
          ? 443
          : 80;
    const localHosts = new Set(['127.0.0.1', 'localhost']);
    const matches = monitors.filter((m) => {
      const hostOk =
        m.host === u.hostname ||
        (localHosts.has(u.hostname) && localHosts.has(m.host));
      return hostOk && m.port === port;
    });
    if (matches.length === 0) return null;
    return (
      matches.find((m) => m.alias === 'buho-console')?.alias ??
      matches.find((m) => m.alias.startsWith('smoke-') || m.alias.startsWith('http-'))?.alias ??
      matches[0]?.alias ??
      null
    );
  } catch {
    return null;
  }
}

function statusTone(ok: boolean | null | undefined, ms?: number | null): string {
  if (ok === false) return 'discover-hit--down';
  if (ok === true && ms != null && ms >= 1500) return 'discover-hit--slow';
  if (ok === true) return 'discover-hit--up';
  return 'discover-hit--unknown';
}

function matchQuery(q: string, hay: string): boolean {
  const raw = q.trim().toLowerCase();
  if (!raw) return true;
  // Tiny KQL-ish: status:up|down path:/foo text
  const parts = raw.split(/\s+/);
  return parts.every((part) => {
    if (part.startsWith('status:')) {
      const v = part.slice(7);
      if (v === 'up') return hay.includes('|up|');
      if (v === 'down') return hay.includes('|down|');
      if (v === 'slow') return hay.includes('|slow|');
      return true;
    }
    if (part.startsWith('path:')) {
      return hay.includes(part.slice(5));
    }
    return hay.includes(part);
  });
}

function normalizeSpark(raw: number[], fallbackMs?: number | null): number[] {
  if (raw.length === 1) return [raw[0]!, raw[0]!];
  if (raw.length === 0 && fallbackMs != null) return [fallbackMs, fallbackMs];
  return raw;
}

export function EndpointDiscover({
  monitors,
  documents,
  histogram,
  deps,
  pathSparks = {},
  defaultBaseUrl = 'http://127.0.0.1:3100',
  initialDbAlias = null,
}: {
  monitors: Array<Omit<EndpointMonitorRow, 'lastSeenAt'> & { lastSeenAt: string | null }>;
  documents: Array<Omit<EndpointPathSample, 'ts'> & { ts: string | null }>;
  histogram: EndpointHistogramBucket[];
  deps: Dep[];
  /** Key `${instanceId}:${path}` → latency samples oldest→newest. */
  pathSparks?: Record<string, number[]>;
  defaultBaseUrl?: string;
  /** Deep-link: /observability?db=datalake-local */
  initialDbAlias?: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<'discover' | 'analyze'>(
    initialDbAlias || monitors.length > 0 ? 'discover' : 'analyze',
  );
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [customPaths, setCustomPaths] = useState('');
  const [useBuhoCatalog, setUseBuhoCatalog] = useState(true);
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPendingUi] = useState(false);
  /** Empty until the user types a name — do not auto-fill (they missed it before). */
  const [saveAlias, setSaveAlias] = useState('');
  const [saveOnlyUp, setSaveOnlyUp] = useState(true);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [selectedDb, setSelectedDb] = useState<DepDbTarget | null>(() => {
    if (!initialDbAlias) return null;
    const hit = deps.find((d) => d.toAlias === initialDbAlias);
    if (!hit) return null;
    return {
      toInstanceId: hit.toInstanceId,
      toAlias: hit.toAlias,
      toEngine: hit.toEngine,
      toHost: hit.toHost,
      toPort: hit.toPort,
    };
  });

  const chartData = useMemo(
    () =>
      histogram.map((b) => ({
        t: new Date(b.bucket).toLocaleTimeString('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        up: b.up,
        down: b.down,
        ms: b.avgMs == null ? 0 : Math.round(b.avgMs),
      })),
    [histogram],
  );

  const aliasesOnSelectedDb = useMemo(() => {
    if (!selectedDb) return null;
    return new Set(
      deps
        .filter((d) => d.toInstanceId === selectedDb.toInstanceId)
        .map((d) => d.fromAlias)
        .filter((a): a is string => Boolean(a)),
    );
  }, [deps, selectedDb]);

  const filteredDocs = useMemo(() => {
    return documents.filter((d) => {
      if (aliasesOnSelectedDb && !aliasesOnSelectedDb.has(d.alias)) return false;
      if (selectedAlias && d.alias !== selectedAlias) return false;
      const ok = d.httpOk === 1;
      const slow = ok && (d.httpMs ?? 0) >= 1500;
      const hay = `|${ok ? 'up' : 'down'}|${slow ? 'slow' : ''}|${d.alias}|${d.path}|${d.httpStatus ?? ''}|`.toLowerCase();
      return matchQuery(query, hay);
    });
  }, [documents, query, aliasesOnSelectedDb, selectedAlias]);

  const filteredMonitors = useMemo(() => {
    return monitors.filter((m) => {
      if (aliasesOnSelectedDb && !aliasesOnSelectedDb.has(m.alias)) return false;
      if (selectedAlias && m.alias !== selectedAlias) return false;
      return matchQuery(
        query,
        `|${m.up === 1 ? 'up' : 'down'}|${m.alias}|${m.host}|`.toLowerCase(),
      );
    });
  }, [monitors, query, aliasesOnSelectedDb, selectedAlias]);

  useEffect(() => {
    setPage(0);
  }, [query, pageSize, tab, selectedAlias, selectedDb]);

  const liveTotal = filteredDocs.length > 0 ? filteredDocs.length : filteredMonitors.length;
  const liveStatus = useMemo(() => {
    if (filteredDocs.length === 0) {
      const up = filteredMonitors.filter((m) => m.up === 1).length;
      const down = filteredMonitors.filter((m) => m.up === 0).length;
      return { up, slow: 0, down };
    }
    let up = 0;
    let slow = 0;
    let down = 0;
    for (const d of filteredDocs) {
      if (d.httpOk === 0) down += 1;
      else if ((d.httpMs ?? 0) >= 1500) slow += 1;
      else up += 1;
    }
    return { up, slow, down };
  }, [filteredDocs, filteredMonitors]);
  const livePages = Math.max(1, Math.ceil(liveTotal / pageSize));
  const liveSafePage = Math.min(page, livePages - 1);
  const liveStart = liveTotal === 0 ? 0 : liveSafePage * pageSize;
  const pageDocs = useMemo(
    () => filteredDocs.slice(liveStart, liveStart + pageSize),
    [filteredDocs, liveStart, pageSize],
  );
  const pageMonitors = useMemo(
    () => filteredMonitors.slice(liveStart, liveStart + pageSize),
    [filteredMonitors, liveStart, pageSize],
  );

  const filteredAnalyze = useMemo(() => {
    if (!analyze) return [];
    return analyze.paths.filter((p) => {
      const slow = p.ok && p.ms >= 1500;
      const hay = `|${p.ok ? 'up' : 'down'}|${slow ? 'slow' : ''}|${p.path}|${p.status ?? ''}|${p.error ?? ''}|`.toLowerCase();
      return matchQuery(query, hay);
    });
  }, [analyze, query]);

  const analyzeHist = useMemo(() => {
    if (!analyze) return [];
    const buckets = new Map<string, { label: string; up: number; down: number }>();
    for (const p of analyze.paths) {
      const band =
        p.ms < 100 ? '<100ms' : p.ms < 300 ? '100-300' : p.ms < 800 ? '300-800' : p.ms < 1500 ? '800-1.5s' : '≥1.5s';
      const cur = buckets.get(band) ?? { label: band, up: 0, down: 0 };
      if (p.ok) cur.up += 1;
      else cur.down += 1;
      buckets.set(band, cur);
    }
    const order = ['<100ms', '100-300', '300-800', '800-1.5s', '≥1.5s'];
    return order.map((k) => buckets.get(k) ?? { label: k, up: 0, down: 0 });
  }, [analyze]);

  async function runAnalyze() {
    setError(null);
    setPendingUi(true);
    try {
      const extras = customPaths
        .split(/[\n,]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith('/') ? p : `/${p}`));

      let catalogPaths: string[] = [];
      if (useBuhoCatalog) {
        const meta = await fetch('/api/endpoints/analyze', { credentials: 'same-origin' });
        if (meta.ok) {
          const body = (await meta.json()) as {
            catalogs?: { buho?: { paths?: string[] } };
          };
          catalogPaths = body.catalogs?.buho?.paths ?? [];
        }
      }

      // Catalog + extras merge: previously extras alone forced catalog=custom and
      // dropped the ~30 Búho routes when the textarea had placeholder-looking paths.
      const paths = useBuhoCatalog
        ? Array.from(new Set([...catalogPaths, ...extras]))
        : extras.length > 0
          ? extras
          : ['/'];
      if (paths.length === 0) {
        throw new Error('No paths to probe — enable the Búho catalog or add custom paths.');
      }

      const res = await fetch('/api/endpoints/analyze', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          catalog: 'custom',
          paths,
          expectStatus: [200, 204, 301, 302, 303, 307, 308, 401, 403],
          concurrency: 8,
          warnMs: 1500,
        }),
      });
      const text = await res.text();
      let json: AnalyzeResult & { error?: string };
      try {
        json = JSON.parse(text) as AnalyzeResult & { error?: string };
      } catch {
        if (res.redirected || /sign in/i.test(text)) {
          throw new Error('Session expired — sign in again, then Run analysis.');
        }
        throw new Error(`Unexpected response (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAnalyze(json);
      // Prefill: reuse existing monitor for this URL, else suggest a default alias.
      setSaveAlias(monitorForBaseUrl(monitors, json.baseUrl) ?? defaultAliasFromUrl(json.baseUrl));
      setSaveMsg(null);
      setQuery(''); // clear any KQL so results aren't hidden (0 hits)
      setTab('analyze');
      // Keep fleet deps visible (como antes); click still filters to one monitor.
      setSelectedAlias(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingUi(false);
    }
  }

  async function saveAsMonitor() {
    if (!analyze) return;
    setSaving(true);
    setSaveMsg(null);
    setError(null);
    try {
      const alias = saveAlias.trim();
      if (!alias) {
        throw new Error('Pick a monitor name (alias) before saving — e.g. buho-console-prod.');
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
        throw new Error('Name may only contain letters, digits, dots, underscores and hyphens.');
      }
      const paths = analyze.paths
        .filter((p) => (saveOnlyUp ? p.ok : true))
        .map((p) => p.path);
      if (paths.length === 0) {
        throw new Error('No paths to save — uncheck “only up” or re-run analysis.');
      }
      const res = await fetch('/api/endpoints/save-monitor', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alias,
          baseUrl: analyze.baseUrl,
          paths,
          // dependsOn inferred server-side from peer monitors / service_deps
          expectStatus: [200, 204, 301, 302, 303, 307, 308, 401, 403],
          warnMs: 1500,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        pathCount?: number;
        note?: string;
        instanceId?: number | null;
        alias?: string;
        dependsOnAlias?: string | null;
        dependsInferred?: boolean;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSaveMsg(
        `Saved ${json.pathCount ?? paths.length} paths as «${alias}»` +
          (json.dependsOnAlias
            ? ` · depends on ${json.dependsOnAlias}${json.dependsInferred ? ' (auto)' : ''}`
            : '') +
          `. Opening monitor…`,
      );
      if (json.instanceId) {
        router.push(`/observability/monitors/${json.instanceId}`);
        return;
      }
      setTab('discover');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const hitCount =
    tab === 'analyze'
      ? analyze
        ? filteredAnalyze.length
        : 0
      : filteredDocs.length > 0
        ? filteredDocs.length
        : filteredMonitors.length;

  // Fleet deps, optionally narrowed by selected monitor (not by DB — DB filters docs).
  const visibleDeps = useMemo(
    () => (selectedAlias ? deps.filter((d) => d.fromAlias === selectedAlias) : deps),
    [deps, selectedAlias],
  );

  function selectAlias(alias: string) {
    setSelectedAlias((prev) => (prev === alias ? null : alias));
  }

  function selectDb(db: DepDbTarget) {
    setSelectedAlias(null);
    setTab('discover');
    setQuery('');
    setSelectedDb((prev) => {
      const clearing = prev?.toInstanceId === db.toInstanceId;
      const url = new URL(window.location.href);
      if (clearing) url.searchParams.delete('db');
      else url.searchParams.set('db', db.toAlias);
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
      return clearing ? null : db;
    });
  }

  function clearDbFilter() {
    setSelectedDb(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('db');
    window.history.replaceState(null, '', url.pathname + url.search);
  }

  function selectFromAnalyze() {
    if (!analyze) return;
    const alias = monitorForBaseUrl(monitors, analyze.baseUrl);
    setSelectedAlias(alias);
  }

  return (
    <div className="discover">
      <div className="discover__tabs">
        <button
          type="button"
          className={`discover__tab ${tab === 'analyze' ? 'is-active' : ''}`}
          onClick={() => setTab('analyze')}
          title="One-shot HTTP probe of a base URL"
        >
          Add probe
        </button>
        <button
          type="button"
          className={`discover__tab ${tab === 'discover' ? 'is-active' : ''}`}
          onClick={() => setTab('discover')}
          title="Saved continuous HTTP probes"
        >
          Live probes
        </button>
      </div>

      {selectedDb && (
        <div className="discover__db-banner panel">
          <div className="discover__db-banner-body">
            <div>
              <p className="muted text-[10px] uppercase tracking-wide m-0">Probes on database</p>
              <p className="m-0 font-mono text-[13px] font-semibold">{selectedDb.toAlias}</p>
              <p className="muted text-[11px] m-0 font-mono">
                {selectedDb.toHost}:{selectedDb.toPort}
                {' · '}
                {aliasesOnSelectedDb?.size ?? 0} probes
              </p>
            </div>
            <div className="discover__db-banner-actions">
              <Link
                href={`/instances/${selectedDb.toInstanceId}`}
                className="btn btn--secondary"
              >
                Open database
              </Link>
              <button type="button" className="btn" onClick={clearDbFilter}>
                Clear filter
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'analyze' && (
        <div className="discover__analyze">
          <label className="discover__field">
            <span>Base URL</span>
            <input
              className="input discover__kql"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:3100"
              spellCheck={false}
            />
          </label>
          <label className="discover__check">
            <input
              type="checkbox"
              checked={useBuhoCatalog}
              onChange={(e) => setUseBuhoCatalog(e.target.checked)}
            />
            Búho console path catalog (~30 routes)
          </label>
          <label className="discover__field discover__field--grow">
            <span>Extra / custom paths (optional, one per line)</span>
            <textarea
              className="input discover__paths"
              value={customPaths}
              onChange={(e) => setCustomPaths(e.target.value)}
              placeholder={'optional extras, one per line\ne.g. /api/health'}
              rows={2}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending || !baseUrl.trim()}
            onClick={() => void runAnalyze()}
          >
            {pending ? 'Probing…' : 'Run analysis'}
          </button>
          {error && <div className="discover__error">{error}</div>}
          {saveMsg && <div className="discover__save-ok">{saveMsg}</div>}
          {!analyze && !error && (
            <p className="muted text-[11px] m-0">
              Run analysis to probe the base URL (catalog + extras). Save to keep a continuous
              HTTP probe — this is not APM.
            </p>
          )}
          {analyze && (
            <div className="discover__save panel">
              <div className="panel-header">
                <span className="panel-title">Save probe</span>
                <span className="muted text-xs">continuous HTTP check · not OTLP</span>
              </div>
              <div className="discover__save-body">
                <label className="discover__field">
                  <span>
                    Probe name <span className="text-[var(--error)]">*</span>
                  </span>
                  <input
                    className="input"
                    value={saveAlias}
                    onChange={(e) => setSaveAlias(e.target.value)}
                    placeholder={`required · e.g. ${defaultAliasFromUrl(analyze.baseUrl)}`}
                    spellCheck={false}
                    required
                    autoComplete="off"
                  />
                </label>
                <p className="muted text-[11px] m-0 self-center max-w-[16rem]">
                  Depends-on DB is inferred automatically (same host peers / existing deps).
                </p>
                <label className="discover__check">
                  <input
                    type="checkbox"
                    checked={saveOnlyUp}
                    onChange={(e) => setSaveOnlyUp(e.target.checked)}
                  />
                  Only save up paths ({analyze.paths.filter((p) => p.ok).length}/
                  {analyze.paths.length})
                </label>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={saving || !saveAlias.trim()}
                  onClick={() => void saveAsMonitor()}
                >
                  {saving ? 'Saving…' : 'Save & open'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="discover__toolbar">
        <input
          className="input discover__kql"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            tab === 'discover'
              ? 'Filter · e.g. status:up path:/api orders-api'
              : 'Filter results · e.g. status:up path:/api'
          }
          spellCheck={false}
        />
        <span className="discover__hits">
          <strong>{hitCount}</strong> hits
          {tab === 'analyze' && analyze && (
            <>
              {' '}
              · {analyze.summary.ok} up · {analyze.summary.down} down · p95{' '}
              {analyze.summary.p95Ms ?? '—'} ms · {analyze.totalMs} ms wall
            </>
          )}
          {tab === 'discover' && liveTotal > 0 && (
            <>
              {' '}
              · {liveStatus.up} up · {liveStatus.slow} slow · {liveStatus.down} down
            </>
          )}
        </span>
      </div>

      <div className="discover__chart panel">
        <div className="panel-header">
          <span className="panel-title">
            {tab === 'analyze' ? 'Latency distribution (this run)' : 'Availability (last 60m)'}
          </span>
        </div>
        <div className="discover__chart-body">
          {tab === 'analyze' ? (
            analyzeHist.some((b) => b.up + b.down > 0) ? (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={analyzeHist} barCategoryGap={4}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                  <Tooltip />
                  <Bar dataKey="up" stackId="a" fill="var(--success)" name="up" />
                  <Bar dataKey="down" stackId="a" fill="var(--error)" name="down" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty">Run analysis to fill the histogram.</div>
            )
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={chartData} barCategoryGap={1}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                <Tooltip />
                <Bar dataKey="up" stackId="a" fill="var(--success)" name="up" />
                <Bar dataKey="down" stackId="a" fill="var(--error)" name="down" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty">No probe samples in the last hour yet.</div>
          )}
        </div>
      </div>

      <div className="discover__layout">
        <aside className="discover__filters panel">
          <div className="panel-header">
            <span className="panel-title">Fields</span>
          </div>
          <div className="panel-body discover__fields">
            <button type="button" className="discover__field-chip" onClick={() => setQuery('status:up')}>
              status:up
            </button>
            <button type="button" className="discover__field-chip" onClick={() => setQuery('status:down')}>
              status:down
            </button>
            <button type="button" className="discover__field-chip" onClick={() => setQuery('status:slow')}>
              status:slow
            </button>
            <button type="button" className="discover__field-chip" onClick={() => setQuery('path:/api')}>
              path:/api
            </button>
            <button type="button" className="discover__field-chip" onClick={() => setQuery('path:/admin')}>
              path:/admin
            </button>
            <button type="button" className="discover__field-chip" onClick={() => setQuery('')}>
              clear
            </button>
            <div className="discover__deps">
              <div className="muted text-[10px] uppercase tracking-wide mb-1">
                Depends on
                {selectedAlias ? (
                  <span className="normal-case tracking-normal"> · {selectedAlias}</span>
                ) : null}
              </div>
              {visibleDeps.length === 0 ? (
                <p className="muted text-[10px] m-0 leading-snug">
                  {selectedAlias
                    ? `${selectedAlias} has no declared dependency.`
                    : 'No service dependencies declared yet.'}
                </p>
              ) : (
                <ServiceDepsGrouped
                  deps={visibleDeps}
                  selectedAlias={selectedAlias}
                  selectedDbId={selectedDb?.toInstanceId ?? null}
                  onSelectFrom={(alias) => {
                    setSelectedAlias(alias);
                    setTab('discover');
                  }}
                  onSelectDb={selectDb}
                />
              )}
              {(selectedAlias || selectedDb) && (
                <button
                  type="button"
                  className="discover__field-chip mt-1"
                  onClick={() => {
                    setSelectedAlias(null);
                    clearDbFilter();
                  }}
                >
                  show all deps
                </button>
              )}
            </div>
          </div>
        </aside>

        <section className="discover__docs panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            <span className="panel-title">Documents</span>
            <span className="muted text-xs">
              {tab === 'analyze'
                ? 'Probe results · HTTP only'
                : selectedDb
                  ? `Probes on ${selectedDb.toAlias}`
                  : 'Live probe samples'}
            </span>
            {tab === 'discover' ? (
              <div className="trace-legend" aria-label="Row color legend">
                <span className="trace-legend__item">
                  <i className="trace-legend__swatch trace-legend__swatch--ok" />
                  Up
                </span>
                <span className="trace-legend__item">
                  <i className="trace-legend__swatch" style={{ background: 'var(--warning)' }} />
                  Slow
                </span>
                <span className="trace-legend__item">
                  <i className="trace-legend__swatch trace-legend__swatch--err" />
                  Down
                </span>
              </div>
            ) : null}
          </div>
          <div className="panel-body p-0">
            {tab === 'analyze' && !analyze && (
              <div className="empty">
                Click <strong>Run analysis</strong> to probe the base URL. For APM waterfalls use{' '}
                <Link href="/observability/apm/setup" className="underline">
                  Add APM
                </Link>
                .
              </div>
            )}
            {tab === 'analyze' && analyze && filteredAnalyze.length === 0 && (
              <div className="empty">
                No hits for this filter ({analyze.summary.total} probed · {analyze.summary.ok} up ·{' '}
                {analyze.summary.down} down). Clear the KQL box or tap <strong>clear</strong> in
                Fields.
              </div>
            )}
            {tab === 'analyze' &&
              analyze &&
              filteredAnalyze.map((p) => {
                const selected =
                  selectedAlias != null &&
                  (selectedAlias === monitorForBaseUrl(monitors, analyze.baseUrl) ||
                    selectedAlias === 'buho-console');
                return (
                  <article
                    key={p.path}
                    role="button"
                    tabIndex={0}
                    className={`discover-hit discover-hit--clickable ${statusTone(p.ok, p.ms)}${
                      selected ? ' is-selected' : ''
                    }`}
                    onClick={() => selectFromAnalyze()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectFromAnalyze();
                      }
                    }}
                  >
                    <div className="discover-hit__bar" aria-hidden />
                    <div className="discover-hit__body">
                      <div className="discover-hit__meta discover-hit__meta--path">
                        <span className="tag tag--muted">{p.status ?? '—'}</span>
                        <span className="discover-hit__path font-mono text-[12px] font-medium">
                          {p.path}
                        </span>
                        <span className="discover-hit__ms num text-foreground-muted">
                          {Math.round(p.ms)} ms
                        </span>
                      </div>
                      <div className="discover-hit__url font-mono text-[10px] text-foreground-muted">
                        {p.url}
                        {p.error ? ` · ${p.error}` : ''}
                        {p.ttfbMs != null ? ` · ttfb ${Math.round(p.ttfbMs)}` : ''}
                      </div>
                    </div>
                  </article>
                );
              })}

            {tab === 'discover' &&
              filteredDocs.length === 0 &&
              filteredMonitors.length === 0 &&
              monitors.length === 0 && (
              <div className="empty">
                No live probes yet. Use <strong>Add probe</strong> to analyze a URL and save it.
              </div>
            )}
            {tab === 'discover' &&
              filteredDocs.length === 0 &&
              filteredMonitors.length === 0 &&
              monitors.length > 0 &&
              selectedDb && (
                <div className="empty">
                  No probe samples for{' '}
                  <span className="font-mono">{selectedDb.toAlias}</span> yet.
                </div>
              )}

            {tab === 'discover' && (filteredDocs.length > 0 || filteredMonitors.length > 0) ? (
              <>
                <div className="discover__docs-list">
                  <div className="discover-hit discover-hit--head" aria-hidden>
                    <div className="discover-hit__bar" />
                    <div className="discover-hit__body">
                      <div className="discover-hit__meta discover-hit__meta--probe">
                        <span className="discover-hit__status">Status</span>
                        <span className="discover-hit__svc">Probe</span>
                        <span className="discover-hit__path">Path</span>
                        <span className="discover-hit__spark">Trend</span>
                        <span className="discover-hit__ms">Latency</span>
                      </div>
                    </div>
                  </div>

                  {filteredDocs.length > 0
                    ? pageDocs.map((d) => {
                        const spark = normalizeSpark(
                          pathSparks[`${d.instanceId}:${d.path}`] ?? [],
                          d.httpMs,
                        );
                        return (
                          <article
                            key={`${d.instanceId}-${d.path}`}
                            role="button"
                            tabIndex={0}
                            className={`discover-hit discover-hit--clickable ${statusTone(d.httpOk === 1, d.httpMs)}${
                              selectedAlias === d.alias ? ' is-selected' : ''
                            }`}
                            onClick={() => selectAlias(d.alias)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                selectAlias(d.alias);
                              }
                            }}
                          >
                            <div className="discover-hit__bar" aria-hidden />
                            <div className="discover-hit__body">
                              <div className="discover-hit__meta discover-hit__meta--probe">
                                <span className="discover-hit__status">
                                  <span className="tag tag--muted">{d.httpStatus ?? '—'}</span>
                                </span>
                                <Link
                                  href={`/observability/monitors/${d.instanceId}`}
                                  className="discover-hit__svc font-mono text-[11px] underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {d.alias}
                                </Link>
                                <span className="discover-hit__path font-mono text-[12px] font-medium">
                                  {d.path}
                                </span>
                                <span className="discover-hit__spark" title="Latency trend">
                                  <Sparkline
                                    values={spark}
                                    width={72}
                                    height={20}
                                    color={
                                      d.httpOk === 0
                                        ? '#b01818'
                                        : d.httpMs != null && d.httpMs >= 1500
                                          ? '#a15c00'
                                          : '#005eb8'
                                    }
                                  />
                                </span>
                                <span className="discover-hit__ms num text-foreground-muted">
                                  {d.httpMs == null ? '—' : `${Math.round(d.httpMs)} ms`}
                                </span>
                              </div>
                            </div>
                          </article>
                        );
                      })
                    : pageMonitors.map((m) => (
                        <article
                          key={m.instanceId}
                          role="button"
                          tabIndex={0}
                          className={`discover-hit discover-hit--clickable ${statusTone(m.up === 1, m.httpMs)}${
                            selectedAlias === m.alias ? ' is-selected' : ''
                          }`}
                          onClick={() => selectAlias(m.alias)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              selectAlias(m.alias);
                            }
                          }}
                        >
                          <div className="discover-hit__bar" aria-hidden />
                          <div className="discover-hit__body">
                            <div className="discover-hit__meta discover-hit__meta--probe">
                              <span className="discover-hit__status">
                                <span
                                  className={`tag ${m.up === 1 ? 'tag--ok' : m.up === 0 ? 'tag--error' : 'tag--muted'}`}
                                >
                                  {m.up === 1 ? 'up' : m.up === 0 ? 'down' : '—'}
                                </span>
                              </span>
                              <Link
                                href={`/observability/monitors/${m.instanceId}`}
                                className="discover-hit__svc font-mono text-[11px] underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {m.alias}
                              </Link>
                              <span className="discover-hit__path font-mono text-[11px] text-foreground-muted">
                                {m.host}:{m.port}
                                {m.pathCount ? ` · ${m.pathCount} paths` : ''}
                              </span>
                              <span className="discover-hit__spark" />
                              <span className="discover-hit__ms num text-foreground-muted">
                                {m.httpMs == null ? '—' : `${Math.round(m.httpMs)} ms`}
                              </span>
                            </div>
                          </div>
                        </article>
                      ))}
                </div>
                <div className="discover__pager">
                  <span>
                    Showing <strong>{liveStart + 1}</strong>–
                    <strong>{Math.min(liveTotal, liveStart + pageSize)}</strong> of{' '}
                    <strong>{liveTotal}</strong>
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
                      disabled={liveSafePage <= 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                    >
                      Prev
                    </button>
                    <span className="font-mono text-[11px]">
                      {liveSafePage + 1} / {livePages}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={liveSafePage >= livePages - 1}
                      onClick={() => setPage((p) => Math.min(livePages - 1, p + 1))}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
