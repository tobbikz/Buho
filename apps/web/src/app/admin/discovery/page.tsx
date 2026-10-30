import { revalidatePath } from 'next/cache';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { ENGINE_LABEL } from '@/lib/grouping';
import { getDiscovered, runDiscovery, setDiscoveredNote, type DiscoveredRow } from '@/lib/discovery';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Discovery · Admin · Búho' };

async function scan(formData: FormData) {
  'use server';

  const session = await requireAdmin();
  const ranges = String(formData.get('ranges') ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  const ports = String(formData.get('ports') ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
  const allowPublic = formData.get('allowPublic') === 'on';

  await runDiscovery(ranges, ports, allowPublic, session.username);
  revalidatePath('/admin/discovery');
}

async function annotate(formData: FormData) {
  'use server';

  const session = await requireAdmin();
  await setDiscoveredNote(
    String(formData.get('host') ?? ''),
    Number(formData.get('port') ?? 0),
    String(formData.get('note') ?? ''),
    formData.get('ignored') === 'on',
    session.username,
  );
  revalidatePath('/admin/discovery');
}

function engineTag(engine: string): string {
  if (engine === 'desconocido' || engine === 'unknown') return 'tag tag--muted';
  return 'tag tag--info';
}

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error, ok } = await searchParams;

  let rows: DiscoveredRow[];
  try {
    rows = await getDiscovered();
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  const unmonitored = rows.filter(
    (row) => !row.monitored && !row.ignored && row.engine !== 'desconocido' && row.engine !== 'unknown',
  );
  const gone = rows.filter((row) => Date.now() - row.lastSeenAt.getTime() > 7 * 86_400_000);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard label="Found" value={String(rows.length)} hint="host:port seen at least once" />
        <StatCard
          label="Not monitored"
          value={String(unmonitored.length)}
          hint="engine identified, not in config"
          tone={unmonitored.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="No response for 7 days"
          value={String(gone.length)}
          hint="powered off, moved, or port changed"
          tone={gone.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Scan a network</span>
        </div>
        <form action={scan} className="panel-body flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                Ranges
              </span>
              <input
                name="ranges"
                defaultValue="127.0.0.1"
                placeholder="192.168.1.0/24  10.0.0.5-10.0.0.40"
                className="w-[26rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                Ports
              </span>
              <input
                name="ports"
                defaultValue="5432 3306 1433"
                className="w-[11rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-foreground-secondary">
              <input type="checkbox" name="allowPublic" />
              allow public addresses
            </label>
            <button type="submit" className="btn btn--primary">
              Scan
            </button>
          </div>

          {error ? <p className="text-[12px] text-error">{decodeURIComponent(error)}</p> : null}
          {ok ? <p className="text-[12px] text-success">{decodeURIComponent(ok)}</p> : null}

          <p className="text-[11.5px] text-foreground-muted">
            No credentials are sent and no login is attempted: Búho reads the protocol greeting and closes
            the connection. MariaDB and SQL Server reveal their version that way; PostgreSQL does not
            without auth, so version stays blank on purpose. Cap is 1024 addresses per scan; public
            networks must be enabled explicitly.
          </p>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Discovered databases</span>
          <span className="text-[11px] text-foreground-muted">those not in config come first</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No scans yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Engine</th>
                <th>Version</th>
                <th>State</th>
                <th className="text-right">Latency</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.host}:${row.port}`}>
                  <td className="font-mono text-[11.5px]">
                    {row.host}:{row.port}
                  </td>
                  <td>
                    <span className={engineTag(row.engine)}>
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </span>
                  </td>
                  <td className="font-mono text-[11px]">
                    {row.versionText ?? <span className="text-foreground-muted">requires credentials</span>}
                  </td>
                  <td>
                    {row.monitored ? (
                      <span className="tag tag--ok">monitored</span>
                    ) : row.ignored ? (
                      <span className="tag tag--muted">ignored</span>
                    ) : (
                      <span className="tag tag--warn">not in config</span>
                    )}
                  </td>
                  <td className="num">{row.latencyMs === null ? '—' : `${row.latencyMs} ms`}</td>
                  <td>{formatAgo(row.firstSeenAt)}</td>
                  <td>{formatAgo(row.lastSeenAt)}</td>
                  <td>
                    <form action={annotate} className="flex items-center gap-1">
                      <input type="hidden" name="host" value={row.host} />
                      <input type="hidden" name="port" value={row.port} />
                      <input
                        name="note"
                        defaultValue={row.note ?? ''}
                        placeholder="lab note…"
                        className="w-[11rem] border border-border bg-surface px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
                      />
                      <label className="flex items-center gap-1 text-[10.5px] text-foreground-muted">
                        <input type="checkbox" name="ignored" defaultChecked={row.ignored} />
                        ignore
                      </label>
                      <button type="submit" className="btn">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
