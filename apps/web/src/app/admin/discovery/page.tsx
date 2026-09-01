import { revalidatePath } from 'next/cache';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { ENGINE_LABEL } from '@/lib/grouping';
import { getDiscovered, runDiscovery, setDiscoveredNote, type DiscoveredRow } from '@/lib/discovery';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';

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
  if (engine === 'desconocido') return 'tag tag--muted';
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

  const unmonitored = rows.filter((row) => !row.monitored && !row.ignored && row.engine !== 'desconocido');
  const gone = rows.filter((row) => Date.now() - row.lastSeenAt.getTime() > 7 * 86_400_000);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard label="Encontradas" value={String(rows.length)} hint="host:puerto vistos alguna vez" />
        <StatCard
          label="Not monitored"
          value={String(unmonitored.length)}
          hint="engine identified, not in config"
          tone={unmonitored.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="No response for 7 days"
          value={String(gone.length)}
          hint="apagadas, movidas o cambiadas de puerto"
          tone={gone.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Escanear una red</span>
        </div>
        <form action={scan} className="panel-body flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                Rangos
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
                Puertos
              </span>
              <input
                name="ports"
                defaultValue="5432 3306 1433"
                className="w-[11rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-foreground-secondary">
              <input type="checkbox" name="allowPublic" />
              permitir direcciones públicas
            </label>
            <button type="submit" className="btn btn--primary">
              Scan
            </button>
          </div>

          {error ? <p className="text-[12px] text-error">{decodeURIComponent(error)}</p> : null}
          {ok ? <p className="text-[12px] text-success">{decodeURIComponent(ok)}</p> : null}

          <p className="text-[11.5px] text-foreground-muted">
            No se envían credenciales ni se intenta iniciar sesión: Búho lee el saludo del protocolo y cierra la
            conexión. MariaDB y SQL Server entregan su versión así; PostgreSQL no la dice sin autenticar y queda en
            blank on purpose. Cap is 1024 addresses per scan and public networks must be enabled
            a mano.
          </p>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Bases encontradas</span>
          <span className="text-[11px] text-foreground-muted">those not in config come first</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No scans yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Destino</th>
                <th>Engine</th>
                <th>Version</th>
                <th>State</th>
                <th className="text-right">Latencia</th>
                <th>Visto por primera vez</th>
                <th>Last seen</th>
                <th>Nota</th>
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
                      <span className="tag tag--ok">monitoreada</span>
                    ) : row.ignored ? (
                      <span className="tag tag--muted">ignorada</span>
                    ) : (
                      <span className="tag tag--warn">fuera del config</span>
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
                        placeholder="pruebas de Juan…"
                        className="w-[11rem] border border-border bg-surface px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
                      />
                      <label className="flex items-center gap-1 text-[10.5px] text-foreground-muted">
                        <input type="checkbox" name="ignored" defaultChecked={row.ignored} />
                        ignorar
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

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">What to do with findings</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary">
          El descubrimiento <strong>does not add instances to monitoring</strong>: para eso hacen falta credenciales, y
          pedirlas en un formulario web significaría guardarlas en la base del store. Las instancias se declaran en{' '}
          <span className="font-mono">config.json</span>, que es lo que se respalda y se versiona. Esta pantalla
          responde la otra pregunta, la que nadie puede contestar de memoria: qué bases hay en la red que nadie está
          vigilando.
        </div>
      </section>
    </div>
  );
}
