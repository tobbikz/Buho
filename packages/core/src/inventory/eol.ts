import type { EngineKind } from '../engine';

/**
 * Fin de soporte por versión mayor, resuelto con una tabla local.
 *
 * A propósito **no** se consulta ninguna API: un despliegue on-prem puede no
 * tener salida a internet, y una herramienta de monitoreo que llama a un
 * servicio externo es exactamente lo que hace que seguridad la rechace.
 *
 * El costo es que esta tabla se actualiza a mano cuando salen versiones nuevas.
 * Se asume conscientemente: equivocarse por unos meses en una fecha de EOL es
 * mucho menos grave que pedirle salida a internet al servidor de base de datos.
 */
const EOL: Record<EngineKind, Record<string, string>> = {
  // PostgreSQL: cinco años después del lanzamiento, siempre en noviembre.
  postgres: {
    '11': '2023-11-09',
    '12': '2024-11-14',
    '13': '2025-11-13',
    '14': '2026-11-12',
    '15': '2027-11-11',
    '16': '2028-11-09',
    '17': '2029-11-08',
    '18': '2030-11-14',
  },
  // MariaDB: las LTS tienen cinco años; las de corta duración, un año.
  mariadb: {
    '10.4': '2024-06-18',
    '10.5': '2025-06-24',
    '10.6': '2026-07-06',
    '10.11': '2028-02-16',
    '11.4': '2029-05-29',
    '11.8': '2030-06-04',
  },
  // SQL Server: fin del soporte extendido.
  mssql: {
    '11': '2022-07-12',
    '12': '2024-07-09',
    '13': '2026-07-14',
    '14': '2027-10-12',
    '15': '2030-01-08',
    '16': '2033-01-11',
  },
  // MongoDB: Rapid Release ~30 días; Major (x.0) tiene 3 años de soporte.
  mongodb: {
    '6': '2025-07-31',
    '7': '2026-08-15',
    '8': '2027-10-02',
  },
  // Redis OSS: roughly aligned with major support windows (community).
  redis: {
    '6': '2024-09-30',
    '7': '2026-07-31',
    '8': '2027-12-31',
  },
  // Oracle Database: Premier Support end (approximate major releases).
  oracle: {
    '19': '2029-12-31',
    '21': '2027-04-30',
    '23': '2032-12-31',
  },
};

const PRODUCT_NAME: Record<string, string> = {
  '11': 'SQL Server 2012',
  '12': 'SQL Server 2014',
  '13': 'SQL Server 2016',
  '14': 'SQL Server 2017',
  '15': 'SQL Server 2019',
  '16': 'SQL Server 2022',
  '17': 'SQL Server 2025',
};

export function mssqlProductName(major: number): string | null {
  return PRODUCT_NAME[String(major)] ?? null;
}

/**
 * @param version texto de versión ya normalizado: "18.4", "11.4.12", "16.0.4265.3"
 */
export function eolFor(engine: EngineKind, version: string): string | null {
  const table = EOL[engine];
  const parts = version.split('.');

  // MariaDB versiona por mayor.menor (10.11 y 10.6 tienen soporte distinto);
  // PostgreSQL y SQL Server, por mayor.
  const keys =
    engine === 'mariadb'
      ? [`${parts[0]}.${parts[1]}`, parts[0] ?? '']
      : [parts[0] ?? '', `${parts[0]}.${parts[1]}`];

  for (const key of keys) {
    const found = table[key];
    if (found) return found;
  }
  return null;
}
