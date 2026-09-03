import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard, toneForPct } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatNumber, formatPct } from '@/lib/format';
import { getHostSummary, getInstance, getSeries, seriesSource, type HostSummary } from '@/lib/queries';
import { getInstanceEngine } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '15m', minutes: 15, bucketSeconds: 30 },
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
  { key: '7d', minutes: 10_080, bucketSeconds: 3_600 },
] as const;

const COLOR = { accent: '#005eb8', success: '#0a6e42', warning: '#9a4a00', error: '#b01818' };

/**
 * El estado vacío es parte del producto, no un placeholder: explica por qué el
 * dato no está y qué hay que escribir para tenerlo, incluyendo el permiso
 * min del lado SSH.
 */
function NotConfigured({ alias }: { alias: string }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Host resources not configured</span>
        <span className="tag tag--muted">optional</span>
      </div>
      <div className="panel-body">
        <p className="text-[12.5px]">
          PostgreSQL does not expose host CPU, memory, or disk: no view has them. The data lives
          in <span className="font-mono">/proc</span>, so it must be read there. Búho installs nothing on the watched
          server — it only reads files.
        </p>

        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          If Búho runs on the same server as the database
        </p>
        <pre className="mt-1 border border-border bg-surface-muted p-2 font-mono text-[11px]">
          {`{
  "alias": "${alias}",
  "hostMetrics": { "source": "local", "dataDirectory": "/var/lib/postgresql/16/main" }
}`}
        </pre>

        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          If the database is on another server (no agent, read-only SSH)
        </p>
        <pre className="mt-1 border border-border bg-surface-muted p-2 font-mono text-[11px]">
          {`{
  "alias": "${alias}",
  "hostMetrics": {
    "source": "ssh",
    "target": "buho@db-host",
    "identityFile": "/etc/buho/id_ed25519",
    "dataDirectory": "/var/lib/postgresql/16/main"
  }
}`}
        </pre>
        <p className="mt-2 text-[12px] text-foreground-secondary">
          An unprivileged user with access to <span className="font-mono">/proc</span> and{' '}
          <span className="font-mono">df</span>. The connection uses{' '}
          <span className="font-mono">BatchMode=yes</span>: if the key fails, the cycle errors into
          collector events instead of hanging on a password prompt.
        </p>
        <p className="mt-2 text-[12px] text-foreground-secondary">
          Until this is configured, Overview still shows the PostgreSQL-side approximations: wait
          classes, DB time, cache hit, and temp spills.
        </p>
      </div>
    </section>
  );
}

function Cards({ host }: { host: HostSummary }) {
  return (
    <div className="stat-grid">
      <StatCard
        label="CPU"
        value={formatPct(host.cpuPct, 1)}
        hint={`${formatNumber(host.cores ?? 0)} cores`}
        tone={toneForPct(host.cpuPct, 75, 90)}
      />
      <StatCard
        label="I/O wait"
        value={formatPct(host.iowaitPct, 1)}
        hint="CPU stalled waiting on disk"
        tone={toneForPct(host.iowaitPct, 10, 25)}
      />
      <StatCard
        label="CPU steal"
        value={formatPct(host.stealPct, 1)}
        hint="hypervisor: noisy neighbors"
        tone={toneForPct(host.stealPct, 5, 10)}
      />
      <StatCard
        label="Memory used"
        value={formatPct(host.memUsedPct, 1)}
        hint={`${formatBytes(host.memAvailableBytes ?? 0)} available`}
        tone={toneForPct(host.memUsedPct, 90, 96)}
      />
      <StatCard
        label="Swap used"
        value={formatPct(host.swapUsedPct, 1)}
        hint="a database that is swapping is in trouble"
        tone={toneForPct(host.swapUsedPct, 5, 20)}
      />
      <StatCard
        label="Load per core"
        value={formatNumber(host.loadPerCore, 2)}
        hint="1.00 = saturated"
        tone={toneForPct((host.loadPerCore ?? 0) * 100, 100, 200)}
      />
      <StatCard
        label="Disk used"
        value={formatPct(host.diskUsedPct, 1)}
        hint={host.mount ? `on ${host.mount}` : 'data directory filesystem'}
        tone={toneForPct(host.diskUsedPct, 85, 95)}
      />
      <StatCard
        label="Disk free"
        value={formatBytes(host.diskFreeBytes ?? 0)}
        hint={`measured ${formatAgo(host.at)}`}
        tone="neutral"
      />
    </div>
  );
}

export default async function HostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();
  // Estas pantallas leen vistas de PostgreSQL. Si alguien llega acá con la URL
  // de un MariaDB o un SQL Server, se lo devuelve a su inventario en vez de
  // mostrarle paneles vacíos que parecen un fallo.
  const engineKind = await getInstanceEngine(instanceId);
  if (engineKind && engineKind !== 'postgres') redirect(`/instances/${instanceId}`);


  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1];
  const windowHint = `window ${window.key} · ${seriesSource(window.minutes).label}`;

  let instance;
  try {
    instance = await getInstance(instanceId);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const [host, cpu, memory, load, disk] = await Promise.all([
    getHostSummary(instanceId),
    getSeries(
      instanceId,
      ['host_cpu_pct', 'host_cpu_iowait_pct', 'host_cpu_steal_pct'],
      window.minutes,
      window.bucketSeconds,
      'avg',
    ),
    getSeries(instanceId, ['host_mem_used_pct', 'host_swap_used_pct'], window.minutes, window.bucketSeconds, 'avg'),
    getSeries(instanceId, ['host_load1_per_core'], window.minutes, window.bucketSeconds, 'avg'),
    getSeries(instanceId, ['host_disk_used_pct'], window.minutes, window.bucketSeconds, 'max'),
  ]);

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Host' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Host · {instance.alias}</h1>
            <p className="page-sub">
              Server CPU, memory, and disk from <span className="font-mono">/proc</span> — the only
              host view in this console that does not come from PostgreSQL.
            </p>
          </div>
          {host && (
            <div className="flex items-center gap-1">
              {WINDOWS.map((candidate) => (
                <Link
                  key={candidate.key}
                  href={`/instances/${instanceId}/host?w=${candidate.key}`}
                  className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {candidate.key}
                </Link>
              ))}
            </div>
          )}
        </header>

        <InstanceTabs instanceId={instanceId} blockedCount={instance.blockedSessions ?? 0} />

        {!host ? (
          <NotConfigured alias={instance.alias} />
        ) : (
          <>
            <Cards host={host} />

            <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
              <TimeseriesPanel
                title="CPU"
                hint={windowHint}
                data={cpu}
                unit="pct"
                series={[
                  { metric: 'host_cpu_pct', label: 'Total usage', color: COLOR.accent },
                  { metric: 'host_cpu_iowait_pct', label: 'I/O wait', color: COLOR.warning },
                  { metric: 'host_cpu_steal_pct', label: 'Steal', color: COLOR.error },
                ]}
              />
              <TimeseriesPanel
                title="Memory"
                hint="used = total − available (not 'total − free')"
                data={memory}
                unit="pct"
                series={[
                  { metric: 'host_mem_used_pct', label: 'Memory', color: COLOR.accent },
                  { metric: 'host_swap_used_pct', label: 'Swap', color: COLOR.error },
                ]}
              />
              <TimeseriesPanel
                title="Load per core"
                hint={windowHint}
                data={load}
                unit="count"
                series={[{ metric: 'host_load1_per_core', label: 'Load / core', color: COLOR.success }]}
              />
              <TimeseriesPanel
                title="Disk used"
                hint={host.mount ? `filesystem ${host.mount}` : windowHint}
                data={disk}
                unit="pct"
                series={[{ metric: 'host_disk_used_pct', label: 'Disk', color: COLOR.warning }]}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
