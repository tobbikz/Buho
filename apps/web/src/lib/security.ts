import { query } from './db';
import { ENGINE_LABEL, type EstateInstance } from './estate';

/**
 * Consultas de la **auditoría de seguridad**.
 *
 * A diferencia del parque, acá no se colapsa por (host, puerto). Es tentador
 * hacerlo —dos entradas del config contra el mismo clúster producen los mismos
 * findings— pero el riesgo de esconder un hallazgo real es peor que el de
 * mostrarlo dos veces: si una de las dos entradas usa un usuario con menos
 * permisos, sus resultados no son los mismos y colapsarlas descartaría
 * precisamente la lectura que sí vio el problema.
 */

export type Severity = 'critica' | 'alta' | 'media' | 'baja' | 'ok' | 'no_verificable';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critica: 'Critical',
  alta: 'High',
  media: 'Medium',
  baja: 'Low',
  ok: 'OK',
  no_verificable: 'Not verifiable',
};

export const CATEGORY_LABEL: Record<string, string> = {
  autenticacion: 'Authentication',
  privilegios: 'Privileges',
  cifrado: 'Encryption',
  superficie: 'Attack surface',
  auditoria: 'Audit and logging',
  acceso_publico: 'Public access',
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critica: 0,
  alta: 1,
  media: 2,
  baja: 3,
  no_verificable: 4,
  ok: 5,
};

export interface Finding extends EstateInstance {
  checkId: string;
  category: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation: string | null;
  evidence: Record<string, unknown>;
  capturedAt: Date | null;
}

export interface SecurityGrant {
  scope: string;
  name: string;
  privileges: string[];
}

export interface PrincipalDetail {
  memberOf?: string[];
  members?: string[];
  grants?: SecurityGrant[];
}

export interface Principal extends EstateInstance {
  name: string;
  principalHost: string;
  kind: string;
  canLogin: boolean;
  isSuperuser: boolean;
  disabled: boolean;
  authMethod: string | null;
  passwordSetAt: Date | null;
  expiresAt: Date | null;
  privileges: string[];
  detail: PrincipalDetail;
}

export interface Posture extends EstateInstance {
  score: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  verified: number;
  total: number;
  capturedAt: Date | null;
}

const INSTANCE_COLUMNS = `i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at`;

function base(row: Record<string, unknown>): EstateInstance {
  return {
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine'] ?? 'postgres'),
    host: String(row['host'] ?? ''),
    port: Number(row['port'] ?? 0),
    environment: String(row['environment'] ?? 'prod'),
    lastSeenAt: row['last_seen_at'] ? new Date(row['last_seen_at'] as string) : null,
  };
}

export async function getFindings(): Promise<Finding[]> {
  const rows = await query(
    `select ${INSTANCE_COLUMNS}, f.check_id, f.category, f.severity, f.title, f.detail,
            f.remediation, f.evidence, f.captured_at
       from buho.security_findings f
       join buho.instances i using (instance_id)
      order by case f.severity
                 when 'critica' then 0 when 'alta' then 1 when 'media' then 2
                 when 'baja' then 3 when 'no_verificable' then 4 else 5 end,
               i.alias, f.check_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    checkId: String(row['check_id']),
    category: String(row['category']),
    severity: String(row['severity']) as Severity,
    title: String(row['title']),
    detail: String(row['detail']),
    remediation: row['remediation'] ? String(row['remediation']) : null,
    evidence: (row['evidence'] as Record<string, unknown>) ?? {},
    capturedAt: row['captured_at'] ? new Date(row['captured_at'] as string) : null,
  }));
}

export async function getPosture(): Promise<Posture[]> {
  // Una fila por instancia con su última medición. El histórico de
  // security_posture sirve para la tendencia, pero la pantalla principal
  // pregunta "cómo estamos hoy".
  const rows = await query(
    `select distinct on (i.instance_id) ${INSTANCE_COLUMNS},
            p.score, p.critical, p.high, p.medium, p.low, p.verified, p.total, p.captured_at
       from buho.security_posture p
       join buho.instances i using (instance_id)
      order by i.instance_id, p.captured_at desc`,
  );

  return rows
    .map((row) => ({
      ...base(row),
      score: Number(row['score'] ?? 0),
      critical: Number(row['critical'] ?? 0),
      high: Number(row['high'] ?? 0),
      medium: Number(row['medium'] ?? 0),
      low: Number(row['low'] ?? 0),
      verified: Number(row['verified'] ?? 0),
      total: Number(row['total'] ?? 0),
      capturedAt: row['captured_at'] ? new Date(row['captured_at'] as string) : null,
    }))
    .sort((a, b) => a.score - b.score || a.alias.localeCompare(b.alias));
}

/** Score history per instance for sparklines (oldest → newest). */
export async function getPostureScoreSeries(
  days = 30,
): Promise<Record<number, number[]>> {
  const rows = await query<{ instance_id: string; score: string; captured_at: Date }>(
    `select instance_id, score::text as score, captured_at
       from buho.security_posture
      where captured_at >= now() - ($1 || ' days')::interval
      order by instance_id, captured_at`,
    [days],
  );
  const out: Record<number, number[]> = {};
  for (const row of rows) {
    const id = Number(row.instance_id);
    const list = out[id] ?? [];
    list.push(Number(row.score));
    out[id] = list;
  }
  return out;
}

/** Fleet critical+high findings per calendar day (sum of latest scorecard that day). */
export async function getSecurityFindingHeat(days = 14): Promise<
  Array<{ day: string; critical: number; high: number }>
> {
  const rows = await query<{ day: Date; critical: string; high: string }>(
    `with daily as (
       select date_trunc('day', captured_at) as day,
              instance_id,
              critical,
              high,
              row_number() over (
                partition by instance_id, date_trunc('day', captured_at)
                order by captured_at desc
              ) as rn
         from buho.security_posture
        where captured_at >= now() - ($1 || ' days')::interval
     )
     select day, sum(critical)::text as critical, sum(high)::text as high
       from daily
      where rn = 1
      group by 1
      order by 1`,
    [days],
  );
  return rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    critical: Number(row.critical),
    high: Number(row.high),
  }));
}

export async function getPrincipals(): Promise<Principal[]> {
  const rows = await query(
    `select ${INSTANCE_COLUMNS}, s.name, s.host as principal_host, s.kind, s.can_login,
            s.is_superuser, s.disabled, s.auth_method, s.password_set_at, s.expires_at,
            s.privileges, s.detail
       from buho.security_principals s
       join buho.instances i using (instance_id)
      order by s.is_superuser desc, i.alias, s.name`,
  );

  return rows.map((row) => ({
    ...base(row),
    name: String(row['name']),
    principalHost: String(row['principal_host'] ?? ''),
    kind: String(row['kind'] ?? ''),
    canLogin: row['can_login'] === true,
    isSuperuser: row['is_superuser'] === true,
    disabled: row['disabled'] === true,
    authMethod: row['auth_method'] ? String(row['auth_method']) : null,
    passwordSetAt: row['password_set_at'] ? new Date(row['password_set_at'] as string) : null,
    expiresAt: row['expires_at'] ? new Date(row['expires_at'] as string) : null,
    privileges: (row['privileges'] as string[]) ?? [],
    detail: (row['detail'] as PrincipalDetail) ?? {},
  }));
}

export function engineLabel(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

export function scoreTone(score: number): 'error' | 'warn' | 'ok' {
  if (score < 60) return 'error';
  if (score < 85) return 'warn';
  return 'ok';
}

export function severityTone(severity: Severity): 'error' | 'warn' | 'ok' | 'neutral' {
  if (severity === 'critica' || severity === 'alta') return 'error';
  if (severity === 'media' || severity === 'baja') return 'warn';
  if (severity === 'ok') return 'ok';
  return 'neutral';
}
