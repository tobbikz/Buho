import { redirect } from 'next/navigation';
import { discover } from '@buho/core';
import { query } from './db';
import { logConsoleEvent } from './users';

/**
 * Descubrimiento desde la consola.
 *
 * El escaneo corre en el proceso web y no en el colector porque es una acción a
 * demanda con resultado inmediato: mandarlo al colector exigiría una cola y un
 * canal de vuelta para algo que tarda un segundo en una /24.
 */

export interface DiscoveredRow {
  host: string;
  port: number;
  engine: string;
  versionText: string | null;
  banner: string | null;
  latencyMs: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  note: string | null;
  ignored: boolean;
  /** Coincide con una instancia del config: ya está siendo vigilada. */
  monitored: boolean;
}

export async function getDiscovered(): Promise<DiscoveredRow[]> {
  const rows = await query(
    `select d.host, d.port, d.engine, d.version_text, d.banner, d.latency_ms,
            d.first_seen_at, d.last_seen_at, d.note, d.ignored,
            exists (
              select 1 from buho.instances i
               where i.host = d.host and i.port = d.port
            ) as monitored
       from buho.discovered d
      order by monitored, d.ignored, d.host, d.port`,
  );

  return rows.map((row) => ({
    host: String(row['host']),
    port: Number(row['port']),
    engine: String(row['engine']),
    versionText: row['version_text'] ? String(row['version_text']) : null,
    banner: row['banner'] ? String(row['banner']) : null,
    latencyMs: row['latency_ms'] === null ? null : Number(row['latency_ms']),
    firstSeenAt: new Date(row['first_seen_at'] as string),
    lastSeenAt: new Date(row['last_seen_at'] as string),
    note: row['note'] ? String(row['note']) : null,
    ignored: row['ignored'] === true,
    monitored: row['monitored'] === true,
  }));
}

/**
 * Lanza un escaneo y guarda lo encontrado.
 *
 * Todo escaneo queda en la bitácora con el usuario, los rangos y el resultado.
 * Un escáner de puertos sin registro de quién lo disparó es exactamente lo que
 * un equipo de seguridad no puede aceptar dentro de su red.
 */
export async function runDiscovery(
  ranges: string[],
  ports: number[],
  allowPublic: boolean,
  username: string,
): Promise<void> {
  if (ranges.length === 0) {
    redirect('/admin/discovery?error=' + encodeURIComponent('Hay que indicar al menos un rango.'));
  }

  let found: Awaited<ReturnType<typeof discover>>;
  try {
    found = await discover(ranges, { ports: ports.length > 0 ? ports : undefined, allowPublic });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logConsoleEvent(username, 'descubrimiento rechazado', `${ranges.join(' ')} — ${message}`);
    redirect('/admin/discovery?error=' + encodeURIComponent(message));
  }

  if (found.found.length > 0) {
    for (const row of found.found) {
      await query(
        `insert into buho.discovered (host, port, engine, version_text, banner, latency_ms,
                                     first_seen_at, last_seen_at)
              values ($1,$2,$3,$4,$5,$6, now(), now())
         on conflict (host, port) do update
                set engine = excluded.engine,
                    -- Una versión conocida no se pierde porque un escaneo
                    -- posterior no la haya podido leer.
                    version_text = coalesce(excluded.version_text, buho.discovered.version_text),
                    banner = excluded.banner,
                    latency_ms = excluded.latency_ms,
                    last_seen_at = now()`,
        [row.host, row.port, row.engine, row.versionText, row.banner, row.latencyMs],
      );
    }
  }

  await logConsoleEvent(
    username,
    'descubrimiento',
    `${ranges.join(' ')} · ${found.scanned} sondas · ${found.found.length} respuesta(s)` +
      (allowPublic ? ' · incluyó direcciones públicas' : ''),
  );

  redirect(
    '/admin/discovery?ok=' +
      encodeURIComponent(
        `${found.scanned} sondas, ${found.found.length} respuesta(s) en ${ranges.join(' ')}.`,
      ),
  );
}

export async function setDiscoveredNote(
  host: string,
  port: number,
  note: string,
  ignored: boolean,
  username: string,
): Promise<void> {
  await query('update buho.discovered set note = $3, ignored = $4 where host = $1 and port = $2', [
    host,
    port,
    note.trim() || null,
    ignored,
  ]);
  await logConsoleEvent(
    username,
    ignored ? 'descubrimiento ignorado' : 'nota de descubrimiento',
    `${host}:${port}${note.trim() ? ` — ${note.trim()}` : ''}`,
  );
}
