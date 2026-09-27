import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AddDatabaseForm } from '@/components/AddDatabaseForm';
import { StoreError } from '@/components/StoreError';
import {
  getTargetFormDefaults,
  listMonitorTargets,
  listOtherInstances,
  parseTargetForm,
  removeMonitorTarget,
  retireInstance,
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

async function deleteInstance(formData: FormData) {
  'use server';
  await requireAdmin();
  const alias = String(formData.get('alias') ?? '').trim();
  if (alias) await retireInstance(alias);
  revalidatePath('/admin/instances');
  revalidatePath('/');
}

export default async function AdminInstancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; edit?: string }>;
}) {
  const { error, ok, edit } = await searchParams;
  const editId = Number(edit);

  let targets;
  let others;
  let initial = null;
  try {
    await requireAdmin();
    [targets, others] = await Promise.all([listMonitorTargets(), listOtherInstances()]);
    if (Number.isInteger(editId) && editId > 0) initial = await getTargetFormDefaults(editId);
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

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
          <span className="panel-title">{initial ? `Edit ${initial.alias}` : 'Add database to monitor'}</span>
          {initial ? (
            <Link href="/admin/instances" className="tag tag--muted">
              cancel edit
            </Link>
          ) : null}
        </div>
        <div className="panel-body">
          <p className="mb-3 text-[12px] text-foreground-secondary">
            Saves the connection in the store. Leave the password blank when editing to keep the current one.
            A removed connection stays gone even if the same alias is still listed in{' '}
            <span className="font-mono">config.json</span> — restart the collector so a probe that is already
            running stops.
          </p>
          <AddDatabaseForm key={initial?.alias ?? 'new'} action={addTarget} initial={initial} />
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
                        <Link href={`/admin/instances?edit=${t.targetId}`} className="tag tag--info">
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

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Other monitored instances ({others.length})</span>
        </div>
        {others.length === 0 ? (
          <div className="empty" style={{ height: 80 }}>
            Every instance in the sidebar is a console target.
          </div>
        ) : (
          <div className="panel-body overflow-x-auto">
            <p className="mb-3 text-[12px] text-foreground-secondary">
              These connections show in the fleet but were not added from this form (usually{' '}
              <span className="font-mono">config.json</span>). Remove hides them and stops the collector from
              bringing them back.
            </p>
            <table className="w-full text-left text-[12px]">
              <thead className="font-semibold uppercase tracking-wide text-foreground-muted">
                <tr>
                  <th className="pb-2 pr-3">Alias</th>
                  <th className="pb-2 pr-3">Engine</th>
                  <th className="pb-2 pr-3">Endpoint</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {others.map((instance) => (
                  <tr key={instance.instanceId} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">{instance.alias}</td>
                    <td className="py-1.5 pr-3">{instance.engine}</td>
                    <td className="py-1.5 pr-3">
                      {instance.host}:{instance.port}
                      {instance.database ? `/${instance.database}` : ''}
                    </td>
                    <td className="py-1.5">
                      <form action={deleteInstance}>
                        <input type="hidden" name="alias" value={instance.alias} />
                        <button type="submit" className="tag tag--error">
                          remove
                        </button>
                      </form>
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
