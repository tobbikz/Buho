import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { countAppLogsByService, listAppLogRecords } from '@/lib/app-logs';
import { formatAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App logs · Observability · Búho' };

function levelTag(level: string): string {
  const l = level.toLowerCase();
  if (l.includes('error') || l.includes('fatal') || l.includes('critical')) return 'tag tag--error';
  if (l.includes('warn')) return 'tag tag--warn';
  return 'tag tag--muted';
}

export default async function AppLogsPage({
  searchParams,
}: {
  searchParams?: Promise<{ service?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const service = sp.service?.trim() || null;

  let events;
  let byService;
  try {
    [events, byService] = await Promise.all([
      listAppLogRecords(24, 200, service),
      countAppLogsByService(24),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const errors = events.filter((e) => /error|fatal|critical/i.test(e.severity)).length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Logs"
        title="App logs"
        sub={
          <>
            OTLP application logs (Discover-shaped stream) · last 24h — not DB engine scrape.{' '}
            <Link href="/observability/logs" className="underline">
              DB logs
            </Link>
            {' · '}
            <Link href="/observability/apm/setup" className="underline">
              Add APM
            </Link>
          </>
        }
        actions={
          <>
            <Link className="btn" href="/observability/apm/traces">
              Traces
            </Link>
            <Link className="btn" href="/api/otlp/v1/logs">
              OTLP /logs
            </Link>
          </>
        }
      />

      <div className="notice">
        Point exporters at <span className="font-mono">/api/otlp/v1/logs</span> (http/json). Same
        token policy as traces. This is <strong>not</strong> Kibana Discover over Elasticsearch —
        rows live in <span className="font-mono">buho.otlp_log_records</span>.
      </div>

      <div className="stat-grid">
        <StatCard label="Lines" value={String(events.length)} hint="recent sample" />
        <StatCard label="Errors" value={String(errors)} hint="severity text match" />
        <StatCard label="Services" value={String(byService.length)} hint="last 24h" />
        <StatCard
          label="Filter"
          value={service ?? 'all'}
          hint={service ? 'clear via nav' : 'optional ?service='}
        />
      </div>

      {byService.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-3">
          <Link className={`btn ${!service ? 'btn--primary' : ''}`} href="/observability/app-logs">
            All
          </Link>
          {byService.slice(0, 12).map((s) => (
            <Link
              key={s.serviceName}
              className={`btn ${service === s.serviceName ? 'btn--primary' : ''}`}
              href={`/observability/app-logs?service=${encodeURIComponent(s.serviceName)}`}
            >
              {s.serviceName} · {s.times}
            </Link>
          ))}
        </div>
      ) : null}

      {events.length === 0 ? (
        <ObsEmpty
          title="No app log lines yet"
          actions={[
            { href: '/observability/apm/setup', label: 'Add APM', primary: true },
            { href: '/observability/logs', label: 'DB logs' },
          ]}
        >
          Emit OTLP logs (http/json) to <span className="font-mono">/api/otlp/v1/logs</span>. Engine
          Postgres/Maria/MSSQL/Oracle scrape stays on DB logs.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Recent app log lines</span>
            <span className="text-[11px] text-foreground-muted">{events.length} shown</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">When</th>
                  <th>Severity</th>
                  <th>Service</th>
                  <th>Message</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
                      {formatAgo(e.at)}
                    </td>
                    <td>
                      <span className={levelTag(e.severity)}>{e.severity || '—'}</span>
                    </td>
                    <td>
                      <Link
                        href={`/observability/app-logs?service=${encodeURIComponent(e.serviceName)}`}
                        className="check-score__instance"
                      >
                        {e.serviceName}
                      </Link>
                    </td>
                    <td>
                      <div className="text-[12px] leading-snug break-all">{e.body || '—'}</div>
                    </td>
                    <td className="font-mono text-[10px]">
                      {e.traceId ? (
                        <Link
                          href={`/observability/apm/traces?trace=${encodeURIComponent(e.traceId)}`}
                          className="underline"
                        >
                          {e.traceId.slice(0, 12)}…
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
