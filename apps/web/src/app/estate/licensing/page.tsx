import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes, formatNumber } from '@/lib/format';
import { ENGINE_LABEL, getLicensing, getNotes, type LicensingRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

/**
 * Licenciamiento, con el "si aplica" tomado en serio.
 *
 * PostgreSQL y MariaDB no tienen nothing to audit y decirlo es la respuesta
 * correcta, no un vacío. Donde sí importa es en SQL Server, y ahí hay dos
 * findings que valen dinero de verdad: una edición Developer o Evaluation
 * atendiendo producción (incumplimiento de licencia), y cores que la edición
 * no puede usar (hardware pagado que el motor ignora).
 */
export default async function LicensingPage() {
  let rows: LicensingRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getLicensing(), getNotes('licensing')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const licensed = rows.filter((row) => row.productionOk !== null);
  const violations = rows.filter((row) => row.productionOk === false);
  const wastedCores = rows
    .filter((row) => row.cores && row.coresLimit && row.cores > row.coresLimit)
    .reduce((sum, row) => sum + ((row.cores ?? 0) - (row.coresLimit ?? 0)), 0);
  const free = rows.filter((row) => row.productionOk === null);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="License problems"
          value={String(violations.length)}
          hint="editions without production rights"
          tone={violations.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Unused cores"
          value={String(wastedCores)}
          hint="hardware exists; the edition does not use them"
          tone={wastedCores > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Instances with commercial licenses" value={String(licensed.length)} />
        <StatCard label="Motores libres" value={String(free.length)} hint="nothing to audit" tone="ok" />
      </div>

      <NotesPanel notes={notes} title="What each engine's license means" />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Licensing by instance</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No licensing data yet.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Engine</th>
                  <th>Edition</th>
                  <th>Modelo</th>
                  <th className="text-right">Cores</th>
                  <th className="text-right">Tope de cores</th>
                  <th className="text-right">Memoria</th>
                  <th className="text-right">Tope de memoria</th>
                  <th>Production</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.instanceId}>
                    <td>
                      <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td>{row.edition ?? <span className="text-foreground-muted">not inventoried</span>}</td>
                    <td className="text-[11px]">{row.licenseModel ?? '·'}</td>
                    <td className="num">{formatNumber(row.cores)}</td>
                    <td className="num">
                      {row.coresLimit === null ? (
                        row.productionOk === null ? '·' : 'sin tope'
                      ) : (
                        <span className={(row.cores ?? 0) > row.coresLimit ? 'tag tag--warn' : ''}>
                          {row.coresLimit}
                        </span>
                      )}
                    </td>
                    <td className="num">{row.memoryBytes ? formatBytes(row.memoryBytes) : '·'}</td>
                    <td className="num">{row.memoryLimitBytes ? formatBytes(row.memoryLimitBytes) : row.productionOk === null ? '·' : 'sin tope'}</td>
                    <td>
                      {row.productionOk === null ? (
                        <span className="tag tag--ok">libre</span>
                      ) : row.productionOk ? (
                        <span className="tag tag--ok">apta</span>
                      ) : (
                        <span className="tag tag--error">not eligible</span>
                      )}
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
          <span className="panel-title">What each edition implies</span>
        </div>
        <div className="panel-body flex flex-col gap-2">
          {rows
            .filter((row) => row.note)
            .map((row) => (
              <div key={row.instanceId} className="flex gap-2 text-[12px]">
                <span className="tag tag--muted whitespace-nowrap">{row.alias}</span>
                <span className="flex-1 text-foreground-secondary">{row.note}</span>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
