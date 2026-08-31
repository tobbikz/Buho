import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * La UI sólo lee el store de Búho: nunca se conecta a las instancias
 * monitoreadas. Esa frontera es deliberada — un render de la web no puede
 * abrir conexiones contra la base de un cliente.
 */
function storeUrl(): string {
  const fromEnv = process.env['BUHO_STORE_URL'];
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Falta BUHO_STORE_URL. En producción la UI no lee config.json.');
  }

  // Sólo en dev: reutilizar el config del colector evita duplicar credenciales
  // mientras se trabaja en local. turbopackIgnore corta el rastreo del árbol
  // completo del proyecto que provoca una ruta dinámica en el build.
  const configPath = resolve(/* turbopackIgnore: true */ process.env['BUHO_CONFIG'] ?? '../../config.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { store?: { url?: string } };
    if (parsed.store?.url) return parsed.store.url;
  } catch {
    // Se cae al error de abajo con un mensaje accionable.
  }
  throw new Error(`Falta la URL del store: definir BUHO_STORE_URL o store.url en ${configPath}.`);
}

/**
 * Misma zona que el colector. `BUHO_TZ` vacío no cuenta: en un compose es fácil
 * que la variable exista con valor vacío, y eso dejaría la sesión sin zona.
 */
function timeZone(): string {
  const declarada = process.env['BUHO_TZ']?.trim();
  return declarada || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// El pool vive en globalThis para que el hot reload de dev no deje pools huérfanos.
const globalForPool = globalThis as unknown as { buhoPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.buhoPool) {
    globalForPool.buhoPool = new Pool({
      connectionString: storeUrl(),
      max: 4,
      application_name: 'buho_web',
      statement_timeout: 5_000,
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      // Misma zona horaria que el colector: las líneas base se agrupan por hora
      // y tienen que coincidir con la hora que se dibuja en el gráfico.
      options: `-c timezone=${timeZone()}`,
    });
    globalForPool.buhoPool.on('error', (error) => {
      console.error('[buho/web] error de pool del store:', error.message);
    });
  }
  return globalForPool.buhoPool;
}

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool().query(sql, params);
  return result.rows as T[];
}
