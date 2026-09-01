import { formatBytes, formatNumber } from './format';
import { getInterestingMoments, getSessionsAt, getWaitShares, WAIT_TYPE_HELP } from './sessions';

/**
 * Un párrafo en español que dice qué pasó.
 *
 * No es un LLM: es una plantilla alimentada por esperas, bloqueos y la consulta
 * más larga del momento peor. La ventaja es que no alucina y siempre se puede
 * auditar: cada frase apunta a un número que ya está en la pantalla.
 *
 * Se usa en el resumen de instancia y en Sesiones. Si no hay sampling todavía,
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
  if (ms === null) return 'no data';
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
      headline: 'No session samples to explain yet.',
      body:
        'Sampling writes every ten seconds. Once there is activity, a paragraph will ' +
        'appear here describing where time went and which query dominated.',
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
        ` At the worst moment (${momento.ts.toLocaleString('en')}) the longest query ` +
        `had been running for ${duracion(peor.queryMs)}` +
        (peor.application && peor.application !== '(unnamed)'
          ? ` from ${peor.application}`
          : '') +
        (peor.username ? ` as ${peor.username}` : '') +
        `: «${texto}${peor.query.length > 120 ? '…' : ''}».` +
        (peor.blockedBy
          ? ` It was blocked by PID ${peor.blockedBy}.`
          : '');
    } else if (momento.blocked > 0) {
      detalleConsulta =
        ` The worst moment had ${momento.blocked} blocked session(s) ` +
        `and the longest had been running for ${duracion(momento.longestMs)}.`;
    }
  }

  const partes: string[] = [];
  partes.push(
    `In the last ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`} ` +
      `there were ${formatNumber(esperas.samples, 0)} session samples, averaging ` +
      `${esperas.averageBusy.toFixed(1)} busy session(s) at a time.`,
  );

  if (dominante) {
    const ayuda = WAIT_TYPE_HELP[dominante.waitType] ?? '';
    partes.push(
      `The heaviest wait was ${dominante.waitType}` +
        (dominante.waitEvent ? ` (${dominante.waitEvent})` : '') +
        `: ${(dominante.share * 100).toFixed(0)} % of session time. ${ayuda}`,
    );
  }

  if (lock && lock.share >= 0.1) {
    partes.push(
      `Locks took ${(lock.share * 100).toFixed(0)} %: buying more CPU or disk will not fix that.`,
    );
  } else if (io && io.share >= 0.25) {
    partes.push(
      `Disk took ${(io.share * 100).toFixed(0)} %: check cache and storage before adding vCPU.`,
    );
  } else if (cpu && cpu.share >= 0.6) {
    partes.push(
      `${(cpu.share * 100).toFixed(0)} % of time was useful work (CPU): if it hurts, the bottleneck is compute or a missing index, not wait.`,
    );
  } else if (client && client.share >= 0.3) {
    partes.push(
      `${(client.share * 100).toFixed(0)} % waited on the client: the server was ready and the application was not fetching the result.`,
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
      ? 'Serious contention in this window.'
      : tone === 'warn'
        ? 'Something worth a closer look.'
        : 'This window looks manageable.';

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
    `Wait profile: ` +
    top.map((w) => `${w.waitType} ${(w.share * 100).toFixed(0)} %`).join(', ') +
    `.`
  );
}

/** Reexport útil para no inventar bytes en las plantillas. */
export { formatBytes };
