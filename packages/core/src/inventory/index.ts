import type { EngineClient } from '../engine';
import { collectMariadb } from './mariadb';
import { collectMongodb } from './mongodb';
import { collectMssql } from './mssql';
import { collectOracle } from './oracle';
import { collectPostgres } from './postgres';
import { collectRedis } from './redis';
import { collectCassandra } from './cassandra';
import { collectElasticsearch } from './elasticsearch';
import type { InventorySnapshot } from './types';

export * from './types';
export { eolFor } from './eol';

/**
 * Lee el inventario completo de una instancia, cualquiera sea su motor.
 */
export async function collectInventory(client: EngineClient): Promise<InventorySnapshot> {
  switch (client.kind) {
    case 'postgres':
      return collectPostgres(client);
    case 'mariadb':
      return collectMariadb(client);
    case 'mssql':
      return collectMssql(client);
    case 'mongodb':
      return collectMongodb(client);
    case 'redis':
      return collectRedis(client);
    case 'oracle':
      return collectOracle(client);
    case 'cassandra':
      return collectCassandra(client);
    case 'elasticsearch':
      return collectElasticsearch(client);
    case 'endpoint':
      throw new Error(
        'collectInventory() no aplica a engine=endpoint — las sondas sintéticas no tienen inventario de BD.',
      );
    case 'infra':
      throw new Error(
        'collectInventory() no aplica a engine=infra — los dispositivos usan @buho/sensors, no inventario SQL.',
      );
    case 'kafka':
    case 'airflow':
    case 'cdc':
      throw new Error(
        `collectInventory() no aplica a engine=${client.kind} — usa colectores/checks del Deep Platform.`,
      );
    default: {
      const _exhaustive: never = client.kind;
      throw new Error(`collectInventory() motor no soportado: ${String(_exhaustive)}`);
    }
  }
}
