import { notFound } from 'next/navigation';
import { ExtensionsList } from '@/components/ExtensionsList';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { RelativeTime } from '@/components/RelativeTime';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

const STALE_MS = 60 * 60 * 1000;

interface ExtensionRow {
  name: string;
  version: string;
}

async function listExtensions(instanceId: number): Promise<{
  extensions: ExtensionRow[];
  probedAt: Date | null;
}> {
  const rows = await query<{ extensions: Record<string, string> | null; probed_at: Date | null }>(
    `select extensions, probed_at
       from buho.instance_capabilities
      where instance_id = $1`,
    [instanceId],
  );
  const row = rows[0];
  if (!row?.extensions) return { extensions: [], probedAt: null };
  const extensions = Object.entries(row.extensions)
    .map(([name, version]) => ({ name, version: String(version) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { extensions, probedAt: row.probed_at };
}

export default async function ExtensionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  if (engine !== 'postgres') notFound();

  let instance;
  let extensions: ExtensionRow[];
  let probedAt: Date | null;
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();
    ({ extensions, probedAt } = await listExtensions(instanceId));
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

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Extensions' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Extensions · {instance.alias}</h1>
            <p className="page-sub">
              Installed PostgreSQL extensions from <code>pg_extension</code>
              {probedAt ? (
                <>
                  {' '}
                  · probed <RelativeTime at={probedAt} />
                </>
              ) : null}
              . Click a row for what it does.
            </p>
          </div>
          <span className="tag tag--info">{extensions.length} installed</span>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        {probedAt && Date.now() - probedAt.getTime() > STALE_MS ? (
          <div className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
            <div className="panel-body text-[12px]">
              Capability probe is stale (<RelativeTime at={probedAt} />). The list may lag installs or drops
              until the next collector capability scan.
            </div>
          </div>
        ) : null}

        {extensions.length === 0 ? (
          <section className="panel">
            <div className="empty">
              No extensions inventoried yet. The collector writes them on the next capability probe.
            </div>
          </section>
        ) : (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Installed</span>
              <span className="font-mono text-[10px] text-foreground-muted">pg_extension</span>
            </div>
            <div className="panel-body" style={{ padding: 0 }}>
              <ExtensionsList extensions={extensions} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
