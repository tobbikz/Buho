import { getFlow, type FlowActor, type FlowDirection, type FlowLink, type FlowNode } from './flow';
import { query } from './db';
import type { FlowWeight } from '@buho/core';

/**
 * El mismo flujo, pero de todo el parque.
 *
 * La pregunta que la vista por instancia no puede contestar: "de todos los
 * servidores, qué tabla recibe más escritura". Hoy había que entrar servidor por
 * servidor y comparar de memoria.
 *
 * Las columnas cambian a **instancia → esquema → tabla**, porque a nivel de
 * parque lo primero que se quiere saber es en qué servidor está el volumen. El
 * actor (rol o aplicación) sigue disponible, pero como filtro de la tabla de
 * abajo y no como columna: con cinco instancias y diez roles el diagrama de
 * cuatro columnas se vuelve ilegible, y la lectura útil es la del servidor.
 *
 * Se calcula por instancia y se suma, no con una consulta única, porque el
 * esquema por omisión y el motor son distintos en cada una: `public` en
 * PostgreSQL, `dbo` en SQL Server, el nombre de la base en MariaDB. Una consulta
 * global tendría que elegir uno y se equivocaría en los otros.
 */

export interface FleetFlowTable {
  instanceId: number;
  alias: string;
  engine: string;
  relation: string;
  schema: string;
  weight: number;
  rows: number;
  calls: number;
  execMs: number;
  byOperation: Record<string, number | undefined>;
  actors: string[];
}

export interface FleetFlowResult {
  nodes: FlowNode[];
  links: FlowLink[];
  tables: FleetFlowTable[];
  /** Instancias consultadas y cuántas aportaron algo. */
  instances: number;
  withTraffic: number;
  /** Instancias que no pudieron atribuir nada, con el motivo probable. */
  silent: { alias: string; engine: string; statements: number }[];
  weightAttributed: number;
  weightTotal: number;
}

/**
 * Instancias del parque.
 *
 * Se toman todas las registradas y no sólo las que tienen muestras recientes:
 * una instancia caída debe aparecer como silenciosa y explicada, no desaparecer
 * del informe como si never hubiera existido.
 */
async function fleetInstances(): Promise<{ instanceId: number; alias: string; engine: string }[]> {
  const rows = await query<{ instance_id: number; alias: string; engine: string }>(
    `select instance_id, alias, coalesce(engine, 'postgres') as engine
       from buho.instances
      order by alias`,
  );
  return rows.map((fila) => ({
    instanceId: Number(fila.instance_id),
    alias: fila.alias,
    engine: fila.engine,
  }));
}

export async function getFleetFlow(
  minutes: number,
  weight: FlowWeight,
  direction: FlowDirection,
  actor: FlowActor = 'rol',
  topTables = 20,
): Promise<FleetFlowResult> {
  const instancias = await fleetInstances();

  // En paralelo: son consultas independientes contra el store y esperar en
  // serie multiplicaría el tiempo de carga por el número de instancias.
  const flujos = await Promise.all(
    instancias.map(async (instancia) => ({
      instancia,
      flujo: await getFlow(
        instancia.instanceId,
        minutes,
        weight,
        direction,
        instancia.engine,
        actor,
        // Se piden más tablas por instancia de las que se van a mostrar: el
        // recorte final es del parque, y quedarse con las 14 de cada una podría
        // dejar fuera la número 15 de un servidor que es la primera del parque.
        60,
      ),
    })),
  );

  const tablas: FleetFlowTable[] = [];
  const silent: FleetFlowResult['silent'] = [];
  let pesoAtribuido = 0;
  let pesoTotal = 0;
  let conTrafico = 0;

  for (const { instancia, flujo } of flujos) {
    pesoAtribuido += flujo.weightAttributed;
    pesoTotal += flujo.weightTotal;

    if (flujo.tables.length === 0) {
      silent.push({
        alias: instancia.alias,
        engine: instancia.engine,
        statements: flujo.statements,
      });
      continue;
    }
    conTrafico += 1;

    for (const tabla of flujo.tables) {
      const peso = weight === 'calls' ? tabla.calls : weight === 'time' ? tabla.execMs : tabla.rows;
      if (peso <= 0) continue;
      tablas.push({
        instanceId: instancia.instanceId,
        alias: instancia.alias,
        engine: instancia.engine,
        relation: tabla.relation,
        schema: tabla.schema,
        weight: peso,
        rows: tabla.rows,
        calls: tabla.calls,
        execMs: tabla.execMs,
        byOperation: tabla.byOperation as Record<string, number | undefined>,
        actors: tabla.roles,
      });
    }
  }

  tablas.sort((a, b) => b.weight - a.weight);
  const visibles = tablas.slice(0, topTables);

  // ------------------------------------------------------------ nodos y cintas
  const nodos: FlowNode[] = [];
  const indice = new Map<string, number>();
  const nodo = (clave: string, depth: 0 | 1 | 2, label: string): number => {
    const existente = indice.get(clave);
    if (existente !== undefined) return existente;
    const nuevo = nodos.length;
    nodos.push({ name: clave, depth, label });
    indice.set(clave, nuevo);
    return nuevo;
  };

  // El esquema se cualifica con la instancia: dos servidores pueden tener un
  // `public` cada uno, y unirlos en un solo nodo fundiría tráfico de máquinas
  // distintas en la misma cinta.
  const instanciaEsquema = new Map<string, number>();
  const esquemaTabla = new Map<string, number>();
  for (const tabla of visibles) {
    const esquema = `${tabla.alias}\u0000${tabla.schema}`;
    instanciaEsquema.set(esquema, (instanciaEsquema.get(esquema) ?? 0) + tabla.weight);
    const relacion = `${tabla.alias}\u0000${tabla.relation}`;
    esquemaTabla.set(`${esquema}\u0001${relacion}`, (esquemaTabla.get(`${esquema}\u0001${relacion}`) ?? 0) + tabla.weight);
  }

  const links: FlowLink[] = [];
  for (const [clave, peso] of instanciaEsquema) {
    const [alias = '', esquema = ''] = clave.split('\u0000');
    links.push({
      source: nodo(`instancia:${alias}`, 0, alias),
      target: nodo(`esquema:${alias}.${esquema}`, 1, esquema),
      value: peso,
    });
  }
  for (const [clave, peso] of esquemaTabla) {
    const [esquemaClave = '', relacionClave = ''] = clave.split('\u0001');
    const [alias = '', esquema = ''] = esquemaClave.split('\u0000');
    const [, relacion = ''] = relacionClave.split('\u0000');
    links.push({
      source: nodo(`esquema:${alias}.${esquema}`, 1, esquema),
      target: nodo(
        `tabla:${alias}.${relacion}`,
        2,
        relacion.split('.').slice(1).join('.') || relacion,
      ),
      value: peso,
    });
  }

  return {
    nodes: nodos,
    links,
    tables: visibles,
    instances: instancias.length,
    withTraffic: conTrafico,
    silent,
    weightAttributed: pesoAtribuido,
    weightTotal: pesoTotal,
  };
}
