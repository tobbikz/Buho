import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { ENGINE_LABEL, getNotes, getSettings, type SettingRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

/**
 * Configuración comparada, no listada.
 *
 * Una lista de parámetros por servidor no sirve de nada: nadie audita 28 filas
 * por 14 servidores. Lo que se busca es la **divergencia** — dos servidores que
 * deberían ser gemelos y no lo son — y el default silencioso, que es el
 * parámetro que nadie decidió nunca. Por eso la tabla pone una columna por
 * instancia y resalta la fila donde los valores no coinciden.
 *
 * La comparación es por motor: comparar work_mem de PostgreSQL con
 * innodb_buffer_pool_size de MariaDB no significa nada.
 */
export default async function ConfigurationPage() {
  let rows: SettingRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getSettings(), getNotes('settings')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const byEngine = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const list = byEngine.get(row.engine) ?? [];
    list.push(row);
    byEngine.set(row.engine, list);
  }

  let divergent = 0;
  let defaults = 0;

  const sections = [...byEngine.entries()].map(([engine, engineRows]) => {
    const aliases = [...new Set(engineRows.map((row) => row.alias))].sort();
    const names = [...new Set(engineRows.map((row) => row.name))].sort();
    const lookup = new Map(engineRows.map((row) => [`${row.alias}|${row.name}`, row]));

    const settings = names.map((name) => {
      const values = aliases.map((alias) => lookup.get(`${alias}|${name}`));
      const distinct = new Set(values.map((row) => row?.value ?? '—'));
      const diverges = distinct.size > 1;
      const allDefault = values.every((row) => row?.isDefault === true);
      if (diverges) divergent += 1;
      if (allDefault) defaults += 1;
      return { name, values, diverges, allDefault };
    });

    return { engine, aliases, settings };
  });

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Parámetros divergentes"
          value={String(divergent)}
          hint="difieren entre instancias del mismo motor"
          tone={divergent > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="En su valor por defecto"
          value={String(defaults)}
          hint="nadie los decidió nunca"
        />
        <StatCard label="Parámetros auditados" value={String(new Set(rows.map((r) => r.name)).size)} />
        <StatCard label="Motores comparados" value={String(byEngine.size)} />
      </div>

      <NotesPanel notes={notes} />

      {sections.length === 0 && (
        <section className="panel">
          <div className="empty">Sin configuración inventariada todavía.</div>
        </section>
      )}

      {sections.map((section) => (
        <section key={section.engine} className="panel">
          <div className="panel-header">
            <span className="panel-title">{ENGINE_LABEL[section.engine] ?? section.engine}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {section.aliases.length} instancia(s) · fila resaltada = valores distintos
            </span>
          </div>
          <div className="table-scroll" style={{ maxHeight: '32rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Parámetro</th>
                  {section.aliases.map((alias) => (
                    <th key={alias}>{alias}</th>
                  ))}
                  <th>Reinicio</th>
                </tr>
              </thead>
              <tbody>
                {section.settings.map((setting) => (
                  <tr
                    key={setting.name}
                    style={{ background: setting.diverges ? 'var(--warning-subtle, #fff8e1)' : undefined }}
                  >
                    <td className="font-mono text-[11px]">
                      {setting.name}
                      {setting.allDefault && (
                        <span className="ml-1 tag tag--muted" title="Ninguna instancia lo tiene configurado explícitamente">
                          default
                        </span>
                      )}
                    </td>
                    {setting.values.map((row, index) => (
                      <td key={index} className="font-mono text-[11px]">
                        {row ? (
                          <>
                            {row.value === '' ? '(vacío)' : row.value}
                            {row.unit ? <span className="text-foreground-muted"> {row.unit}</span> : null}
                          </>
                        ) : (
                          <span className="text-foreground-muted">—</span>
                        )}
                      </td>
                    ))}
                    <td>
                      {setting.values.some((row) => row?.requiresRestart) ? (
                        <span className="tag tag--muted">sí</span>
                      ) : (
                        '·'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
