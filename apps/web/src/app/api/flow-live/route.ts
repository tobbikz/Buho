import { NextResponse } from 'next/server';
import { getFlow, referenceRate } from '@/lib/flow';
import { getFleetFlow } from '@/lib/fleet-flow';
import { query } from '@/lib/db';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';

const VENTANA_MINUTOS = 5;
const CACHE_MS = 3000;
const cache = new Map<string, { at: number; body: unknown }>();

function guardar(clave: string, body: unknown): void {
  cache.set(clave, { at: Date.now(), body });
  if (cache.size > 64) {
    for (const [otra, entrada] of cache) {
      if (Date.now() - entrada.at > CACHE_MS) cache.delete(otra);
    }
  }
}

export async function GET(request: Request) {
  const parametros = new URL(request.url).searchParams;
  const alcance = parametros.get('alcance') === 'flota' ? 'flota' : 'instancia';
  const weight = (['rows', 'time', 'calls'].includes(parametros.get('peso') ?? '')
    ? parametros.get('peso')
    : 'rows') as FlowWeight;
  const minutos = Math.max(1, Math.min(60, Number(parametros.get('min') ?? VENTANA_MINUTOS)));

  const clave = `${alcance}|${parametros.get('instancia') ?? ''}|${weight}|${minutos}`;
  const guardado = cache.get(clave);
  if (guardado && Date.now() - guardado.at < CACHE_MS) {
    return NextResponse.json(guardado.body as Record<string, unknown>);
  }

  try {
    if (alcance === 'flota') {
      const flujo = await getFleetFlow(minutos, weight, 24);
      const cuerpo = {
        nodes: flujo.nodes,
        links: flujo.links.map((enlace) => ({ ...enlace, value: enlace.value / (minutos * 60) })),
        windowMinutes: minutos,
        generatedAt: new Date().toISOString(),
        referenceRate: null,
        activeSessions: null,
        blockedSessions: null,
      };
      guardar(clave, cuerpo);
      return NextResponse.json(cuerpo);
    }

    const instanceId = Number(parametros.get('instancia'));
    if (!Number.isFinite(instanceId)) {
      return NextResponse.json({ error: 'missing instance parameter' }, { status: 400 });
    }

    const engineRows = await query<{ engine: string | null }>(
      'select engine from buho.instances where instance_id = $1',
      [instanceId],
    );
    const engine = engineRows[0]?.engine ?? 'postgres';

    const [flujo, referencia] = await Promise.all([
      getFlow(instanceId, minutos, weight, 'both', engine, 'aplicacion', 18),
      referenceRate(instanceId, weight),
    ]);

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

    const cuerpo = {
      nodes: flujo.nodes,
      links: flujo.links.map((enlace) => ({ ...enlace, value: enlace.value / (minutos * 60) })),
      windowMinutes: minutos,
      generatedAt: new Date().toISOString(),
      referenceRate: referencia,
      activeSessions: ultimo('connections_active'),
      blockedSessions: ultimo('connections_blocked'),
    };
    guardar(clave, cuerpo);
    return NextResponse.json(cuerpo);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
