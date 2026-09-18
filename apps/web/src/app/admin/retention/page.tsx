import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo, formatBytes, formatNumber } from '@/lib/format';
import { requireAdmin } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';
import {
  getRetention,
  getStoreSizes,
  retentionUpdatedBy,
  saveRetention,
  validateRetention,
  RETENTION_DEFAULTS,
  RETENTION_LIMITS,
  type Retention,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

async function save(formData: FormData) {
  'use server';

  const session = await requireAdmin();

  const input = Object.fromEntries(
    (Object.keys(RETENTION_LIMITS) as (keyof Retention)[]).map((field) => [
      field,
      Number(formData.get(field) ?? RETENTION_DEFAULTS[field]),
    ]),
  ) as unknown as Retention;

  const problems = validateRetention(input);
  if (problems.length > 0) {
    redirect('/admin/retention?error=' + encodeURIComponent(problems.join(' ')));
  }

  await saveRetention(input, session.username);
  await logConsoleEvent(
    session.username,
    'retention updated',
    (Object.keys(RETENTION_LIMITS) as (keyof Retention)[])
      .map((field) => `${field}=${input[field]}d`)
      .join(' '),
  );
  revalidatePath('/admin/retention');
  redirect('/admin/retention?ok=1');
}

export default async function RetentionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error, ok } = await searchParams;

  let retention: Retention;
  let sizes: Awaited<ReturnType<typeof getStoreSizes>>;
  let updated: Awaited<ReturnType<typeof retentionUpdatedBy>>;
  try {
    [retention, sizes, updated] = await Promise.all([
      getRetention(),
      getStoreSizes(),
      retentionUpdatedBy(),
    ]);
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  const biggest = sizes.tables[0];

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard label="Store size" value={formatBytes(sizes.total)} hint="all buho tables" />
        <StatCard
          label="Largest table"
          value={biggest ? formatBytes(biggest.bytes) : '—'}
          hint={biggest?.name}
        />
        <StatCard
          label="Retention source"
          value={updated ? 'console' : 'config.json'}
          hint={updated ? `${updated.by ?? '?'} · ${formatAgo(updated.at)}` : 'unchanged from the console'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">How many days each thing is kept</span>
          {ok ? <span className="tag tag--ok">guardado</span> : null}
        </div>
        <form action={save} className="panel-body flex flex-col gap-3">
          <div className="flex flex-wrap gap-4">
            {(Object.keys(RETENTION_LIMITS) as (keyof Retention)[]).map((field) => {
              const limits = RETENTION_LIMITS[field];
              return (
                <label key={field} className="flex w-[13rem] flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                    {limits.label}
                  </span>
                  <div className="flex items-baseline gap-1">
                    <input
                      name={field}
                      type="number"
                      min={limits.min}
                      max={limits.max}
                      defaultValue={retention[field]}
                      className="w-[5rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
                    />
                    <span className="text-[11px] text-foreground-muted">
                      {field === 'unreachableAfterMinutes' ? 'min' : 'days'}
                    </span>
                  </div>
                  <span className="text-[10.5px] text-foreground-muted">{limits.hint}</span>
                </label>
              );
            })}
          </div>

          {error ? <p className="text-[12px] text-error">{decodeURIComponent(error)}</p> : null}

          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn--primary">
              Save
            </button>
            <span className="text-[11.5px] text-foreground-muted">
              The collector rereads it on its maintenance cycle, every 15 minutes: nothing to restart.
            </span>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">How deletion works</span>
        </div>
        <div className="panel-body flex flex-col gap-2 text-[12px] text-foreground-secondary">
          <p>
            Raw samples, 5-minute rollups, and per-query statistics are partitioned by day: they are
            removed with <span className="font-mono">DROP TABLE</span> of the whole partition, which
            leaves no dead rows and does not need vacuum. Lowering those numbers frees space on the
            next maintenance cycle.
          </p>
          <p>
            1-hour rollups and lock episodes use batched <span className="font-mono">DELETE</span>, so
            their space becomes reusable for the store itself but the file does not shrink immediately.
          </p>
          <p>
            Product floor is <strong>90 days</strong> of operable history (5m/1h rollups, statements,
            checks). Raw samples stay short on purpose — they dominate disk. Unreachable instances
            auto-resolve zombie alerts after the configured minutes without samples.
          </p>
          <p>
            Lowering a value <strong>deletes data irreversibly</strong> on the next cycle. Búho does not keep
            copies: to keep long history, raise the 1-hour rollup, which costs a fraction of
            raw storage.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">What is using the space</span>
          <span className="text-[11px] text-foreground-muted">incluye indexes y particiones</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Tabla</th>
              <th className="text-right">Size</th>
              <th className="text-right">Rows aproximadas</th>
              <th className="text-right">Del total</th>
            </tr>
          </thead>
          <tbody>
            {sizes.tables
              .filter((table) => table.bytes > 0)
              .map((table) => (
                <tr key={table.name}>
                  <td className="font-mono text-[11.5px]">{table.name}</td>
                  <td className="num">{formatBytes(table.bytes)}</td>
                  <td className="num">{table.rows === null ? '—' : formatNumber(Math.round(table.rows))}</td>
                  <td className="num">
                    {sizes.total > 0 ? `${((table.bytes / sizes.total) * 100).toFixed(1)} %` : '—'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="panel-body text-[11.5px] text-foreground-muted">
          Row counts come from planner statistics, so they are approximate and may lag
          until the next analyze. Size is exact.
        </div>
      </section>
    </div>
  );
}
