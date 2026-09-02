import { query } from './db';

/**
 * Findings de los 22 chequeos, vistos de toda la flota a la vez.
 *
 * Instancia por instancia la pregunta es "¿cómo está este servidor?". A nivel de
 * flota es otra: "¿qué arreglo primero?". Con veinte instancias, un `warning`
 * que aparece en dieciocho vale más que un `critical` aislado, porque es un
 * problema de configuración de la plataforma y se arregla una sola vez. Por eso
 * la pantalla agrupa por chequeo y no por servidor.
 */

export type Severity = 'critical' | 'warning' | 'info';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface CheckOccurrence {
  instanceId: number;
  alias: string;
  environment: string;
  group: string | null;
  object: string | null;
  message: string;
  value: number | null;
  severity: Severity;
  ts: Date;
}

export interface CheckGroup {
  checkId: string;
  title: string;
  /** La peor severidad con la que aparece: es la que decide el orden. */
  severity: Severity;
  instances: number;
  findings: number;
  remediation: string;
  occurrences: CheckOccurrence[];
}

export interface FleetCheckTotals {
  critical: number;
  warning: number;
  info: number;
  instancesAffected: number;
  instancesClean: number;
  instancesReporting: number;
  /** Instancias que never reportaron un chequeo: un hueco, no un aprobado. */
  instancesSilent: number;
  worstScore: number | null;
  lastRunAt: Date | null;
}

/**
 * Sólo la corrida más reciente de cada instancia.
 *
 * Sin este filtro se sumarían las corridas de los últimos días y un problema ya
 * resuelto seguiría contando. `distinct on` por instancia es la forma más
 * directa de quedarse con la última.
 */
const LATEST = `
  ultima as (
    select instance_id, max(ts) as ts
      from buho.check_results
     group by instance_id
  ),
  vigentes as (
    select r.*
      from buho.check_results r
      join ultima u on u.instance_id = r.instance_id and u.ts = r.ts
  )`;

export async function getFleetChecks(
  severities: Severity[] = ['critical', 'warning', 'info'],
): Promise<CheckGroup[]> {
  const rows = await query<Record<string, unknown>>(
    `with ${LATEST}
     select v.check_id, v.title, v.severity, v.object, v.message, v.remediation,
            v.value, v.ts, v.instance_id, i.alias, i.environment,
            (select value from buho.instance_tags t
              where t.instance_id = i.instance_id and t.key = 'grupo') as grupo
       from vigentes v
       join buho.instances i using (instance_id)
      where v.severity = any($1::text[])
      order by v.check_id, i.alias`,
    [severities],
  );

  const groups = new Map<string, CheckGroup>();

  for (const row of rows) {
    const checkId = String(row['check_id']);
    const severity = String(row['severity']) as Severity;

    const occurrence: CheckOccurrence = {
      instanceId: Number(row['instance_id']),
      alias: String(row['alias']),
      environment: String(row['environment'] ?? ''),
      group: (row['grupo'] as string | null) ?? null,
      object: (row['object'] as string | null) ?? null,
      message: String(row['message'] ?? ''),
      value: row['value'] === null ? null : Number(row['value']),
      severity,
      ts: row['ts'] as Date,
    };

    const existing = groups.get(checkId);
    if (existing) {
      existing.occurrences.push(occurrence);
      existing.findings += 1;
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) existing.severity = severity;
      continue;
    }

    groups.set(checkId, {
      checkId,
      title: String(row['title'] ?? checkId),
      severity,
      instances: 0,
      findings: 1,
      remediation: String(row['remediation'] ?? ''),
      occurrences: [occurrence],
    });
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.instances = new Set(group.occurrences.map((entry) => entry.instanceId)).size;
    group.occurrences.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.alias.localeCompare(b.alias),
    );
  }

  // Severidad primero, y dentro de la misma severidad, cuántas instancias
  // afecta: un problema repetido en la plataforma se arregla una vez y baja
  // veinte findings.
  return result.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.instances - a.instances ||
      b.findings - a.findings ||
      a.checkId.localeCompare(b.checkId),
  );
}

export async function getFleetCheckTotals(): Promise<FleetCheckTotals> {
  const rows = await query<Record<string, unknown>>(
    `with ${LATEST},
     puntajes as (
       select distinct on (instance_id) instance_id, score
         from buho.health_scores
        order by instance_id, ts desc
     )
     select count(*) filter (where v.severity = 'critical')            as critical,
            count(*) filter (where v.severity = 'warning')             as warning,
            count(*) filter (where v.severity = 'info')                as info,
            count(distinct v.instance_id)                              as instances_affected,
            (select count(*) from ultima)                              as instances_reporting,
            (select count(*) from buho.instances i
              where i.engine = 'postgres'
                and not exists (select 1 from ultima u where u.instance_id = i.instance_id))
                                                                        as instances_silent,
            (select min(score) from puntajes)                          as worst_score,
            (select max(ts) from ultima)                               as last_run_at
       from vigentes v`,
  );

  const row = rows[0] ?? {};
  const reporting = Number(row['instances_reporting'] ?? 0);
  const affected = Number(row['instances_affected'] ?? 0);

  return {
    critical: Number(row['critical'] ?? 0),
    warning: Number(row['warning'] ?? 0),
    info: Number(row['info'] ?? 0),
    instancesAffected: affected,
    instancesClean: Math.max(reporting - affected, 0),
    instancesReporting: reporting,
    instancesSilent: Number(row['instances_silent'] ?? 0),
    worstScore: row['worst_score'] === null ? null : Number(row['worst_score']),
    lastRunAt: (row['last_run_at'] as Date | null) ?? null,
  };
}

export interface InstanceScore {
  instanceId: number;
  alias: string;
  environment: string;
  group: string | null;
  score: number | null;
  critical: number;
  warning: number;
  info: number;
  ts: Date | null;
}

export async function getInstanceScores(): Promise<InstanceScore[]> {
  const rows = await query<Record<string, unknown>>(
    `select i.instance_id, i.alias, i.environment,
            (select value from buho.instance_tags t
              where t.instance_id = i.instance_id and t.key = 'grupo') as grupo,
            h.score, h.critical, h.warning, h.info, h.ts
       from buho.instances i
       left join (
         select distinct on (instance_id) instance_id, score, critical, warning, info, ts
           from buho.health_scores
          order by instance_id, ts desc
       ) h using (instance_id)
      order by h.score asc nulls first, i.alias`,
  );

  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    environment: String(row['environment'] ?? ''),
    group: (row['grupo'] as string | null) ?? null,
    score: row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
    critical: Number(row['critical'] ?? 0),
    warning: Number(row['warning'] ?? 0),
    info: Number(row['info'] ?? 0),
    ts: (row['ts'] as Date | null) ?? null,
  }));
}
