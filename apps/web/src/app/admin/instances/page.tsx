import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { StoreError } from '@/components/StoreError';
import {
  defaultPort,
  listMonitorTargets,
  parseTargetForm,
  removeMonitorTarget,
  saveMonitorTarget,
  setTargetEnabled,
  type TargetEngine,
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

const ENGINE_OPTIONS: { value: TargetEngine; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mariadb', label: 'MariaDB / MySQL' },
  { value: 'mssql', label: 'SQL Server' },
  { value: 'mongodb', label: 'MongoDB' },
];

export default async function AdminInstancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error, ok } = await searchParams;

  let targets;
  try {
    await requireAdmin();
    targets = await listMonitorTargets();
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
          <span className="panel-title">Add database to monitor</span>
        </div>
        <div className="panel-body">
          <p className="mb-3 text-[12px] text-foreground-secondary">
            Saves the connection in the store. Targets here are merged with{' '}
            <span className="font-mono">config.json</span> (the file wins if the same alias already exists
            there). Credentials stay on-prem in the store, same trust model as the config file.
          </p>
          <form action={addTarget} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Alias
              <input name="alias" required className="input font-mono" placeholder="orders-prod" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Engine
              <select name="engine" className="input" defaultValue="postgres">
                {ENGINE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Environment
              <input name="environment" className="input" defaultValue="prod" placeholder="prod" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Host
              <input name="host" required className="input font-mono" placeholder="10.0.0.10" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Port
              <input
                name="port"
                type="number"
                className="input font-mono"
                placeholder={String(defaultPort('postgres'))}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Database
              <input name="database" className="input font-mono" placeholder="postgres / master / admin" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Username
              <input name="username" required className="input font-mono" placeholder="buho_monitor" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Password
              <input
                name="password"
                type="password"
                required
                className="input font-mono"
                autoComplete="new-password"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Tag key (optional)
              <input name="tagKey" className="input font-mono" placeholder="team" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Tag value
              <input name="tagValue" className="input font-mono" placeholder="data" />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-foreground-secondary md:col-span-2">
              <input type="checkbox" name="ssl" className="accent-[var(--accent)]" />
              Use TLS / SSL
            </label>
            <div className="flex items-end md:col-span-2 xl:col-span-3">
              <button type="submit" className="btn btn--primary">
                Add database
              </button>
            </div>
          </form>
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
