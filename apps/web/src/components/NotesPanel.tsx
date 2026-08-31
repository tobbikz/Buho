import type { NoteRow } from '@/lib/estate';
import { ENGINE_LABEL } from '@/lib/estate';

/**
 * Notas del inventario.
 *
 * Existe porque la respuesta honesta a veces es "este motor no lo sabe". Una
 * pantalla de Backups vacía sin explicación parece un bug y hace dudar de todo
 * lo demás que muestra la herramienta; con la nota, el mismo vacío se convierte
 * en información: PostgreSQL no lleva catálogo de respaldos, y punto.
 */
export function NotesPanel({ notes, title = 'Qué se puede y qué no se puede saber' }: { notes: NoteRow[]; title?: string }) {
  if (notes.length === 0) return null;

  const problems = notes.filter((note) => note.level !== 'info');
  const limits = notes.filter((note) => note.level === 'info');

  return (
    <>
      {problems.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Hallazgos</span>
            <span className="tag tag--error">{problems.length}</span>
          </div>
          <div className="panel-body flex flex-col gap-2">
            {problems.map((note, index) => (
              <div
                key={`${note.instanceId}-${index}`}
                className="flex gap-2 border-l-2 pl-2 text-[12px]"
                style={{ borderColor: note.level === 'error' ? 'var(--error)' : 'var(--warning)' }}
              >
                <span className={`tag ${note.level === 'error' ? 'tag--error' : 'tag--warn'}`}>
                  {note.alias}
                </span>
                <span className="flex-1">{note.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {limits.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">{title}</span>
          </div>
          <div className="panel-body flex flex-col gap-2">
            {limits.map((note, index) => (
              <div key={`${note.instanceId}-${index}`} className="flex gap-2 text-[12px] text-foreground-secondary">
                <span className="tag tag--muted whitespace-nowrap">
                  {note.alias} · {ENGINE_LABEL[note.engine] ?? note.engine}
                </span>
                <span className="flex-1">{note.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
