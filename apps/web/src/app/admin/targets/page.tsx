import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AddDatabaseForm } from '@/components/AddDatabaseForm';
import { StoreError } from '@/components/StoreError';
import {
  listMonitorTargets,
  parseTargetForm,
  removeMonitorTarget,
  saveMonitorTarget,
  setTargetEnabled,
  type MonitorTarget,
} from '@/lib/targets';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function addTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  try {
    await saveMonitorTarget(parseTargetForm(formData));
  } catch (error) {
    redirect(
      `/admin/targets?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
  }
  revalidatePath('/admin/targets');
  revalidatePath('/platform/airflow');
  revalidatePath('/platform/kafka');
  revalidatePath('/platform/cdc');
  revalidatePath('/');
  redirect('/admin/targets?ok=1');
}

async function toggleTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  await setTargetEnabled(Number(formData.get('targetId')), formData.get('enabled') === '1');
  revalidatePath('/admin/targets');
  revalidatePath('/platform/airflow');
  revalidatePath('/platform/kafka');
  revalidatePath('/platform/cdc');
}

async function deleteTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  await removeMonitorTarget(Number(formData.get('targetId')));
  revalidatePath('/admin/targets');
  revalidatePath('/platform/airflow');
  revalidatePath('/platform/kafka');
  revalidatePath('/platform/cdc');
  revalidatePath('/');
}

function airflowDefaults(t: MonitorTarget) {
  const af =
    t.endpoint['airflow'] && typeof t.endpoint['airflow'] === 'object'
      ? (t.endpoint['airflow'] as Record<string, unknown>)
      : {};
  const meta =
    af['metadata'] && typeof af['metadata'] === 'object'
      ? (af['metadata'] as Record<string, unknown>)
      : {};
  return {
    airflowBaseUrl: typeof af['baseUrl'] === 'string' ? af['baseUrl'] : undefined,
    airflowMetaHost: typeof meta['host'] === 'string' ? meta['host'] : undefined,
    airflowMetaPort: typeof meta['port'] === 'number' ? meta['port'] : undefined,
    airflowMetaDatabase: typeof meta['database'] === 'string' ? meta['database'] : undefined,
    airflowMetaUser: typeof meta['user'] === 'string' ? meta['user'] : undefined,
  };
}

function kafkaDefaults(t: MonitorTarget) {
  const kafka =
    t.endpoint['kafka'] && typeof t.endpoint['kafka'] === 'object'
      ? (t.endpoint['kafka'] as Record<string, unknown>)
      : t.endpoint['cdc'] && typeof t.endpoint['cdc'] === 'object'
        ? ((t.endpoint['cdc'] as Record<string, unknown>)['kafka'] as Record<string, unknown>) || {}
        : {};
  const cdc =
    t.endpoint['cdc'] && typeof t.endpoint['cdc'] === 'object'
      ? (t.endpoint['cdc'] as Record<string, unknown>)
      : {};
  const brokers = Array.isArray(kafka['brokers']) ? (kafka['brokers'] as string[]).join(',') : '';
  const groups = Array.isArray(kafka['consumerGroups'])
    ? (kafka['consumerGroups'] as string[]).join(',')
    : Array.isArray(cdc['applyGroups'])
      ? (cdc['applyGroups'] as string[]).join(',')
      : '';
  const topics = Array.isArray(cdc['topics']) ? (cdc['topics'] as string[]).join(',') : '';
  return { kafkaBrokers: brokers, kafkaGroups: groups, cdcTopics: topics };
}

export default async function AdminInstancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; edit?: string; engine?: string }>;
}) {
  const { error, ok, edit, engine: engineParam } = await searchParams;

  let targets;
  try {
    await requireAdmin();
    targets = await listMonitorTargets();
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  const editing = edit ? targets.find((t) => t.alias === edit) : undefined;
  const presetEngine =
    editing?.engine ??
    (engineParam && ['postgres', 'mssql', 'mariadb', 'oracle', 'airflow', 'kafka', 'cdc'].includes(engineParam)
      ? engineParam
      : 'postgres');

  const title =
    editing
      ? `Edit ${editing.alias}`
      : presetEngine === 'airflow'
        ? 'Add Airflow'
        : presetEngine === 'kafka'
          ? 'Add Kafka'
          : presetEngine === 'cdc'
            ? 'Add CDC'
            : 'Add database to monitor';

  return (
    <div className="flex flex-col gap-[0.875rem]">
      {error ? <div className="notice notice--error">{error}</div> : null}
      {ok ? (
        <div className="notice notice--ok">
          Target saved in the store. The collector picks it up within ~30 seconds if it is already
          running — no restart required.
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">{title}</span>
          {editing ? (
            <Link href="/admin/targets" className="tag tag--muted">
              cancel edit
            </Link>
          ) : null}
        </div>
        <div className="panel-body">
          <p className="mb-3 text-[12px] text-foreground-secondary">
            Connections live in the Búho store (this page). Same alias + Save updates the existing
            target. Platform engines (Airflow / Kafka / CDC) are first-class here — no config file
            required.
          </p>
          <AddDatabaseForm
            key={editing ? `edit-${editing.alias}` : `add-${presetEngine}`}
            action={addTarget}
            submitLabel={editing ? 'Update target' : 'Save target'}
            defaults={
              editing
                ? {
                    alias: editing.alias,
                    engine: editing.engine,
                    host: editing.host,
                    port: editing.port,
                    database: editing.database,
                    username: editing.username,
                    environment: editing.environment,
                    ssl: editing.ssl,
                    hostMetricsSource: 'local',
                    expandAllDatabases: false,
                    ...airflowDefaults(editing),
                    ...kafkaDefaults(editing),
                  }
                : { engine: presetEngine, expandAllDatabases: presetEngine === 'postgres' }
            }
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Monitored targets ({targets.length})</span>
          <div className="flex flex-wrap gap-1">
            <Link href="/admin/targets?engine=airflow" className="tag tag--info">
              + Airflow
            </Link>
            <Link href="/admin/targets?engine=kafka" className="tag tag--info">
              + Kafka
            </Link>
            <Link href="/admin/targets?engine=cdc" className="tag tag--info">
              + CDC
            </Link>
            <Link href="/" className="tag tag--muted">
              back to fleet
            </Link>
          </div>
        </div>
        {targets.length === 0 ? (
          <div className="empty" style={{ height: 100 }}>
            No targets yet. Use the form above to add PostgreSQL, SQL Server, Airflow, and more.
          </div>
        ) : (
          <div className="panel-body overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="font-semibold uppercase tracking-wide text-foreground-muted">
                <tr>
                  <th className="pb-2 pr-3">Alias</th>
                  <th className="pb-2 pr-3">Engine</th>
                  <th className="pb-2 pr-3">Endpoint</th>
                  <th className="pb-2 pr-3">User</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {targets.map((t) => (
                  <tr key={t.targetId} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">{t.alias}</td>
                    <td className="py-1.5 pr-3">{t.engine}</td>
                    <td className="py-1.5 pr-3">
                      {t.host}:{t.port}
                      {t.database ? `/${t.database}` : ''}
                    </td>
                    <td className="py-1.5 pr-3">{t.username || '—'}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`tag ${t.enabled ? 'tag--ok' : 'tag--muted'}`}>
                        {t.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        <Link
                          href={`/admin/targets?edit=${encodeURIComponent(t.alias)}`}
                          className="tag tag--info"
                        >
                          edit
                        </Link>
                        <form action={toggleTarget}>
                          <input type="hidden" name="targetId" value={t.targetId} />
                          <input type="hidden" name="enabled" value={t.enabled ? '0' : '1'} />
                          <button type="submit" className="tag tag--muted">
                            {t.enabled ? 'disable' : 'enable'}
                          </button>
                        </form>
                        <form action={deleteTarget}>
                          <input type="hidden" name="targetId" value={t.targetId} />
                          <button type="submit" className="tag tag--error">
                            remove
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
