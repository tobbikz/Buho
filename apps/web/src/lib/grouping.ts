import type { FleetInstance } from './queries';

/**
 * Agrupación del parque.
 *
 * "Grupo" no es un campo de la instancia sino **la dimensión que se está
 * mirando**. La misma instancia pertenece al equipo de datos, al cliente ACME y
 * al sitio de San José a la vez; con un campo `grupo` habría que elegir una de
 * esas tres para siempre, y la cuarta obligaría a migrar el modelo.
 *
 * Así que las claves de agrupación son las claves de etiqueta que existan, más
 * tres dimensiones que Búho ya conoce: ambiente, motor y servidor.
 */

export const BUILTIN_KEYS = {
  environment: 'Environment',
  engine: 'Engine',
  host: 'Host',
} as const;

export const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  mariadb: 'MariaDB',
  oracle: 'Oracle',
  mongodb: 'MongoDB',
  redis: 'Redis',
  cassandra: 'Cassandra',
  elasticsearch: 'Elasticsearch',
  kafka: 'Kafka',
  cdc: 'CDC',
  airflow: 'Airflow',
  endpoint: 'Endpoint',
};

/** URL/query value for “No grouping” (legacy `sin-agrupar` still accepted). */
export const NO_GROUP = 'ungrouped';
const NO_GROUP_LEGACY = 'sin-agrupar';

/** Etiqueta preferida para agrupar cuando nadie eligió: la más usada del parque. */
export function defaultGroupKey(instances: FleetInstance[]): string {
  const counts = new Map<string, number>();
  for (const instance of instances) {
    for (const key of Object.keys(instance.tags)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.has('grupo')) return 'grupo';

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? 'environment';
}

/** Claves disponibles para el selector, en orden de utilidad. */
export function availableKeys(instances: FleetInstance[]): { key: string; label: string }[] {
  const tagKeys = new Set<string>();
  for (const instance of instances) {
    for (const key of Object.keys(instance.tags)) tagKeys.add(key);
  }

  return [
    ...[...tagKeys].sort().map((key) => ({ key, label: capitalize(key) })),
    ...Object.entries(BUILTIN_KEYS).map(([key, label]) => ({ key, label })),
    { key: NO_GROUP, label: 'No grouping' },
  ];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function groupValue(instance: FleetInstance, key: string): string {
  if (key === 'environment') return instance.environment;
  if (key === 'engine') return ENGINE_LABEL[instance.engine] ?? instance.engine;
  if (key === 'host') return `${instance.host}:${instance.port}`;
  return instance.tags[key] ?? 'untagged';
}

export interface Group<T> {
  value: string;
  instances: T[];
}

/**
 * Agrupa y ordena. Los grupos con problemas critical van primero: cuando algo
 * está roto, esa es la razón por la que alguien abrió la pantalla.
 */
export function groupInstances<T extends FleetInstance>(instances: T[], key: string): Group<T>[] {
  if (key === NO_GROUP || key === NO_GROUP_LEGACY) return [{ value: '', instances }];

  const groups = new Map<string, T[]>();
  for (const instance of instances) {
    const value = groupValue(instance, key);
    const bucket = groups.get(value) ?? [];
    bucket.push(instance);
    groups.set(value, bucket);
  }

  return [...groups.entries()]
    .map(([value, members]) => ({ value, instances: members }))
    .sort((a, b) => {
      const criticalA = a.instances.reduce((sum, instance) => sum + instance.critical, 0);
      const criticalB = b.instances.reduce((sum, instance) => sum + instance.critical, 0);
      if (criticalA !== criticalB) return criticalB - criticalA;
      // "sin etiqueta" al final: es la ausencia de dato, no un grupo real.
      if (a.value === 'untagged') return 1;
      if (b.value === 'untagged') return -1;
      return a.value.localeCompare(b.value, 'en');
    });
}

/** Filtro `clave:valor` de la URL, tolerante con lo que escriba la gente. */
export function parseFilter(raw: string | undefined): { key: string; value: string } | null {
  if (!raw) return null;
  const index = raw.indexOf(':');
  if (index <= 0) return null;
  const key = raw.slice(0, index).trim();
  const value = raw.slice(index + 1).trim();
  return key && value ? { key, value } : null;
}

export function matchesFilter(instance: FleetInstance, filter: { key: string; value: string }): boolean {
  return groupValue(instance, filter.key) === filter.value;
}
