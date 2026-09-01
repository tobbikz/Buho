import { formatBytes, formatNumber } from './format';
import { getInterestingMoments, getSessionsAt, getWaitShares, WAIT_TYPE_HELP } from './sessions';

/**
 * Un párrafo en español que dice qué pasó.
 *
 * No es un LLM: es una plantilla alimentada por esperas, bloqueos y la consulta
 * más larga del momento peor. La ventaja es que no alucina y siempre se puede
 * auditar: cada frase apunta a un número que ya está en la pantalla.
 *
 * Se usa en el resumen de instancia y en Sesiones. Si no hay muestreo todavía,
 * lo dice en vez de inventar calma.
 */

export interface IncidentExplanation {
  /** Una frase de titular. */
  headline: string;
  /** Párrafo completo. */
  body: string;
  /** Severidad sugerida para el tono de la tarjeta. */
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  /** Momento que se está explicando, si se eligió uno. */
  at: Date | null;
}

function duracion(ms: number | null): string {
  if (ms === null) return 'sin dato';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export async function explainIncident(
  instanceId: number,
  minutes = 60,
): Promise<IncidentExplanation> {
  const [esperas, momentos] = await Promise.all([
    getWaitShares(instanceId, minutes),
    getInterestingMoments(instanceId, minutes, 1),
  ]);

  if (esperas.samples === 0) {
    return {
      headline: 'Todavía no hay fotos de sesiones para explicar.',
      body:
        'El muestreo escribe cada diez segundos. Cuando haya actividad, aquí aparecerá ' +
        'un párrafo que diga en qué se fue el tiempo y qué consulta dominaba.',
      tone: 'neutral',
      at: null,
    };
  }

  const lock = esperas.waits.find((w) => w.waitType === 'Lock');
  const io = esperas.waits.find((w) => w.waitType === 'IO');
  const cpu = esperas.waits.find((w) => w.waitType === 'CPU');
  const client = esperas.waits.find((w) => w.waitType === 'Client');
  const dominante = esperas.waits[0];

  const momento = momentos[0] ?? null;
  let detalleConsulta = '';
  let at: Date | null = momento?.ts ?? null;

  if (momento) {
    const foto = await getSessionsAt(instanceId, momento.ts);
    at = foto.at;
    const peor = foto.sessions[0];
    if (peor?.query) {
      const texto = peor.query.replace(/\s+/g, ' ').slice(0, 120);
      detalleConsulta =
        ` En el momento peor (${momento.ts.toLocaleString('es')}) la consulta más larga ` +
        `llevaba ${duracion(peor.queryMs)}` +
        (peor.application && peor.application !== '(sin nombre)'
          ? ` desde ${peor.application}`
          : '') +
        (peor.username ? ` como ${peor.username}` : '') +
        `: «${texto}${peor.query.length > 120 ? '…' : ''}».` +
        (peor.blockedBy
          ? ` Estaba bloqueada por el PID ${peor.blockedBy}.`
          : '');
    } else if (momento.blocked > 0) {
      detalleConsulta =
        ` El momento peor tuvo ${momento.blocked} sesión(es) bloqueada(s) ` +
        `y la más larga llevaba ${duracion(momento.longestMs)}.`;
    }
  }

  const partes: string[] = [];
  partes.push(
    `En la última ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`} ` +
      `hubo ${formatNumber(esperas.samples, 0)} fotos de sesiones, con un promedio de ` +
      `${esperas.averageBusy.toFixed(1)} sesión(es) ocupada(s) a la vez.`,
  );

  if (dominante) {
    const ayuda = WAIT_TYPE_HELP[dominante.waitType] ?? '';
    partes.push(
      `Lo que más pesó fue ${dominante.waitType}` +
        (dominante.waitEvent ? ` (${dominante.waitEvent})` : '') +
        `: el ${(dominante.share * 100).toFixed(0)} % del tiempo de sesión. ${ayuda}`,
    );
  }

  if (lock && lock.share >= 0.1) {
    partes.push(
      `Los bloqueos se llevaron el ${(lock.share * 100).toFixed(0)} %: eso no se arregla comprando CPU ni disco.`,
    );
  } else if (io && io.share >= 0.25) {
    partes.push(
      `El disco se llevó el ${(io.share * 100).toFixed(0)} %: conviene mirar caché y el almacenamiento antes de subir vCPU.`,
    );
  } else if (cpu && cpu.share >= 0.6) {
    partes.push(
      `El ${(cpu.share * 100).toFixed(0)} % del tiempo fue trabajo útil (CPU): si duele, el cuello es cálculo o falta de índice, no espera.`,
    );
  } else if (client && client.share >= 0.3) {
    partes.push(
      `El ${(client.share * 100).toFixed(0)} % esperó al cliente: el servidor estaba listo y la aplicación no recogía el resultado.`,
    );
  }

  partes.push(detalleConsulta);

  const tone: IncidentExplanation['tone'] =
    (lock?.share ?? 0) >= 0.2 || (momento?.blocked ?? 0) >= 3
      ? 'error'
      : (io?.share ?? 0) >= 0.3 || (lock?.share ?? 0) >= 0.1
        ? 'warn'
        : dominante
          ? 'ok'
          : 'neutral';

  const headline =
    tone === 'error'
      ? 'Hubo contención seria en la ventana.'
      : tone === 'warn'
        ? 'Hay una señal que conviene mirar.'
        : 'La ventana se ve manejable.';

  return {
    headline,
    body: partes.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    tone,
    at,
  };
}

/** Variante corta para el informe: sin momento puntual. */
export async function explainFleetWaits(
  instanceId: number,
  minutes: number,
): Promise<string | null> {
  const esperas = await getWaitShares(instanceId, minutes);
  if (esperas.samples === 0) return null;
  const top = esperas.waits.slice(0, 3);
  if (top.length === 0) return null;
  return (
    `Perfil de espera: ` +
    top.map((w) => `${w.waitType} ${(w.share * 100).toFixed(0)} %`).join(', ') +
    `.`
  );
}

/** Reexport útil para no inventar bytes en las plantillas. */
export { formatBytes };
