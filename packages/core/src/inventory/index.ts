import type { EngineClient } from '../engine';
import { collectMariadb } from './mariadb';
import { collectMongodb } from './mongodb';
import { collectMssql } from './mssql';
import { collectPostgres } from './postgres';
import type { InventorySnapshot } from './types';

export * from './types';
export { eolFor } from './eol';

/**
 * Lee el inventario completo de una instancia, cualquiera sea su motor.
 *
 * Un fallo en un dominio no debe tumbar el resto: si el usuario de monitoreo no
 * tiene permiso sobre msdb, se quiere el inventario de versiones y disco igual,
 * con una nota que explique el hueco. Por eso cada colector de motor atrapa lo
 * que puede y devuelve notas en vez de tirar excepciones parciales.
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
  }
}
