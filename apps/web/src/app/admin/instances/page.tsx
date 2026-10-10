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
      `/admin/instances?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
  }
  revalidatePath('/admin/instances');
  revalidatePath('/');
  redirect('/admin/instances?ok=1');
}

async function toggleTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  await setTargetEnabled(Number(formData.get('targetId')), formData.get('enabled') === '1');
  revalidatePath('/admin/instances');
}

async function deleteTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  await removeMonitorTarget(Number(formData.get('targetId')));
  revalidatePath('/admin/instances');
  revalidatePath('/');
}

export default async function AdminInstancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; edit?: string }>;
}) {
  const { error, ok, edit } = await searchParams;

  let targets;
  try {
    await requireAdmin();
    targets = await listMonitorTargets();
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  const editing = edit ? targets.find((t) => t.alias === edit) : undefined;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      {error ? <div className="notice notice--error">{error}</div> : null}
      {ok ? (
        <div className="notice notice--ok">
          Target saved. The collector picks it up within ~30 seconds if it is already running — no restart
          required.
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">
            {editing ? `Edit ${editing.alias}` : 'Add database to monitor'}
          </span>
          {editing ? (
            <Link href="/admin/instances" className="tag tag--muted">
              cancel edit
            </Link>
          ) : null}
        </div>
        <div className="panel-body">
          <p className="mb-3 text-[12px] text-foreground-secondary">
            Saves the connection in the store (editable here). File-based{' '}
            <span className="font-mono">config.json</span> still wins only if the same alias exists
            there — keep DB targets in the store so you can change host/port from the console.
            Same alias + Save updates the existing target.
          </p>
          <AddDatabaseForm
            key={editing ? `edit-${editing.alias}` : 'add'}
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
                  }
                : undefined
            }
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Console targets ({targets.length})</span>
          <Link href="/" className="tag tag--muted">
            back to fleet
          </Link>
        </div>
        {targets.length === 0 ? (
          <div className="empty" style={{ height: 100 }}>
            No targets added from the console yet. File-based instances in config.json are unchanged.
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
                    <td className="py-1.5 pr-3">{t.username}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`tag ${t.enabled ? 'tag--ok' : 'tag--muted'}`}>
                        {t.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        <Link
                          href={`/admin/instances?edit=${encodeURIComponent(t.alias)}`}
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
