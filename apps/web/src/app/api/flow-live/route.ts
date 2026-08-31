import { NextResponse } from 'next/server';
import { getFlow, type FlowActor, type FlowDirection } from '@/lib/flow';
import { getFleetFlow } from '@/lib/fleet-flow';
import { query } from '@/lib/db';
import type { FlowWeight } from '@buho/core';

/**
 * Foto reciente del tráfico, para el lienzo animado.
 *
 * El diagrama acumulado contesta "qué pasó en las últimas 24 horas". Este
 * endpoint contesta otra cosa: **qué está pasando ahora**. La diferencia no es
 * cosmética: una tabla que recibió un millón de filas esta mañana y ninguna en
 * los últimos cinco minutos domina el diagrama acumulado y no debería mover una
 * sola partícula en el lienzo vivo.
 *
 * La ventana es corta a propósito (cinco minutos por omisión). Más corta no
 * serviría: el colector escribe los deltas de consultas cada minuto, así que
 * pedir treinta segundos daría un lienzo que se apaga y se enciende al ritmo del
 * colector y no al de la aplicación.
 *
 * Se devuelve el peso **por segundo** y no el acumulado de la ventana, porque es
 * lo que el lienzo necesita para decidir cuántas partículas lanzar: una tasa,
 * no un total.
 */

export const dynamic = 'force-dynamic';

const VENTANA_MINUTOS = 5;

export async function GET(request: Request) {
  const parametros = new URL(request.url).searchParams;
  const alcance = parametros.get('alcance') === 'flota' ? 'flota' : 'instancia';
  const weight = (['rows', 'time', 'calls'].includes(parametros.get('peso') ?? '')
    ? parametros.get('peso')
    : 'rows') as FlowWeight;
  const direction: FlowDirection = parametros.get('dir') === 'lectura' ? 'lectura' : 'escritura';
  const actor: FlowActor = parametros.get('quien') === 'aplicacion' ? 'aplicacion' : 'rol';
  const minutos = Math.max(1, Math.min(60, Number(parametros.get('min') ?? VENTANA_MINUTOS)));

  try {
    if (alcance === 'flota') {
      const flujo = await getFleetFlow(minutos, weight, direction, actor, 24);
      return NextResponse.json({
        nodes: flujo.nodes,
        links: flujo.links.map((enlace) => ({ ...enlace, value: enlace.value / (minutos * 60) })),
        windowMinutes: minutos,
        generatedAt: new Date().toISOString(),
        activeSessions: null,
        blockedSessions: null,
      });
    }

    const instanceId = Number(parametros.get('instancia'));
    if (!Number.isFinite(instanceId)) {
      return NextResponse.json({ error: 'falta el parámetro instancia' }, { status: 400 });
    }

    const engineRows = await query<{ engine: string | null }>(
      'select engine from buho.instances where instance_id = $1',
      [instanceId],
    );
    const engine = engineRows[0]?.engine ?? 'postgres';

    const flujo = await getFlow(instanceId, minutos, weight, direction, engine, actor, 18);

    // Dos números que sí son del instante y no de la ventana: cuántas sesiones
    // están trabajando y cuántas esperando. El lienzo los usa para latir incluso
    // cuando la ventana de consultas todavía no trajo nada, que es lo que pasa
    // en el primer minuto después de que arranca el tráfico.
    const vivas = await query<{ metric: string; value: number }>(
      `select metric, value
         from buho.metric_samples
        where instance_id = $1
          and metric in ('connections_active', 'connections_blocked', 'connections_total')
          and ts > now() - interval '3 minutes'
        order by ts desc
        limit 30`,
      [instanceId],
    );
    const ultimo = (nombre: string): number | null => {
      const fila = vivas.find((entrada) => entrada.metric === nombre);
      return fila ? Number(fila.value) : null;
    };

    return NextResponse.json({
      nodes: flujo.nodes,
      links: flujo.links.map((enlace) => ({ ...enlace, value: enlace.value / (minutos * 60) })),
      windowMinutes: minutos,
      generatedAt: new Date().toISOString(),
      activeSessions: ultimo('connections_active'),
      blockedSessions: ultimo('connections_blocked'),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
