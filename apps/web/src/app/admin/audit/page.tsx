import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { listConsoleEvents, type ConsoleEvent } from '@/lib/users';

export const dynamic = 'force-dynamic';

/**
 * Bitácora de la consola: quién cambió qué.
 *
 * Separada de los eventos del colector, que son del proceso de recolección.
 * Estos son de personas, y sin ellos "¿quién bajó la retención a 2 días?" no
 * tiene respuesta.
 */
export default async function AuditPage() {
  let events: ConsoleEvent[];
  try {
    events = await listConsoleEvents(200);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Bitácora de la consola</span>
        <span className="text-[11px] text-foreground-muted">últimos {events.length} registros</span>
      </div>
      {events.length === 0 ? (
        <div className="empty">
          Sin registros. Se anotan los inicios de sesión con cuenta, los escaneos de red y todo cambio de cuentas o
          retención.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '8rem' }}>Cuándo</th>
              <th style={{ width: '11rem' }}>Usuario</th>
              <th style={{ width: '13rem' }}>Acción</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => (
              <tr key={`${event.at.toISOString()}-${index}`}>
                <td className="text-[11px] text-foreground-muted">{formatAgo(event.at)}</td>
                <td className="font-mono text-[11.5px]">{event.username}</td>
                <td>
                  <span
                    className={`tag ${
                      event.action.includes('borrada') || event.action.includes('rechazado')
                        ? 'tag--error'
                        : event.action.includes('descubrimiento') || event.action.includes('retención')
                          ? 'tag--warn'
                          : 'tag--muted'
                    }`}
                  >
                    {event.action}
                  </span>
                </td>
                <td className="text-[11.5px] text-foreground-secondary">{event.detail || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
