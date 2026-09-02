import type { EngineKind } from '../engine';

/**
 * Auditoría de seguridad.
 *
 * A diferencia del inventario, esto no es "estado del servidor" sino un
 * **juicio**: cada comprobación afirma que algo está bien o mal y dice qué
 * hacer. Por eso el modelo es hallazgo + severidad + evidencia + remediación, y
 * no una tabla de valores.
 *
 * La decisión más importante del módulo está en el estado `no_verificable`.
 * Una comprobación de seguridad que **falla en silencio y se muestra como
 * aprobada** es peor que no tenerla: el DBA cierra la pantalla creyendo que su
 * servidor está bien cuando en realidad Búho nunca pudo mirar. Todas las
 * consultas privilegiadas de acá atrapan el error de permisos y devuelven
 * `no_verificable` con el permiso exacto que falta.
 */

export type SecuritySeverity = 'critica' | 'alta' | 'media' | 'baja' | 'ok' | 'no_verificable';

export type SecurityCategory =
  | 'autenticacion'
  | 'privilegios'
  | 'cifrado'
  | 'superficie'
  | 'auditoria'
  | 'acceso_publico';

export const CATEGORY_LABEL: Record<SecurityCategory, string> = {
  autenticacion: 'Authentication',
  privilegios: 'Privileges',
  cifrado: 'Encryption',
  superficie: 'Attack surface',
  auditoria: 'Audit and logging',
  acceso_publico: 'Public access',
};

export const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  critica: 0,
  alta: 1,
  media: 2,
  baja: 3,
  no_verificable: 4,
  ok: 5,
};

export interface SecurityFinding {
  checkId: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  /** Qué se encontró, en concreto y con números. */
  detail: string;
  /** Qué hacer. Vacío cuando el hallazgo es `ok`. */
  remediation?: string;
  /** Datos crudos que respaldan el hallazgo, para que sea auditable. */
  evidence?: Record<string, unknown>;
}

export interface SecurityGrant {
  scope: 'database' | 'schema' | 'table' | 'server' | 'other';
  name: string;
  privileges: string[];
}

export interface SecurityPrincipalDetail {
  /** Roles or groups this principal belongs to. */
  memberOf?: string[];
  /** Direct members when this principal is a role or group. */
  members?: string[];
  /** Privileges on databases, schemas, tables, etc. */
  grants?: SecurityGrant[];
}

export interface SecurityPrincipal {
  name: string;
  /** 'login', 'rol', 'usuario' — the vocabulary changes by engine. */
  kind: string;
  /** Host from which connections are allowed. MariaDB models this explicitly. */
  host?: string | null;
  canLogin: boolean;
  isSuperuser: boolean;
  disabled: boolean;
  /** scram, md5, mysql_native_password, SQL_LOGIN, WINDOWS_LOGIN, no password… */
  authMethod?: string | null;
  passwordSetAt?: Date | null;
  expiresAt?: Date | null;
  /** Global privileges: SUPER, FILE, sysadmin, BYPASSRLS… */
  privileges: string[];
  detail?: SecurityPrincipalDetail;
}

export interface SecurityAudit {
  engine: EngineKind;
  findings: SecurityFinding[];
  principals: SecurityPrincipal[];
  /** 0–100 sobre lo que **sí** se pudo verificar. */
  score: number;
  /** Cuántas comprobaciones se pudieron ejecutar de verdad. */
  verified: number;
  total: number;
}

/** Peso de cada severidad al calcular la postura. */
const PENALTY: Record<SecuritySeverity, number> = {
  critica: 30,
  alta: 15,
  media: 6,
  baja: 2,
  ok: 0,
  no_verificable: 0,
};

/**
 * Postura de seguridad, 0–100.
 *
 * Se calcula **sólo sobre lo verificado** y las comprobaciones que no se
 * pudieron ejecutar se informan aparte, en la cobertura. La alternativa —
 * penalizar lo desconocido — produce un número que baja cuando faltan permisos
 * y sube cuando se conceden, sin que la seguridad real haya cambiado. Y la
 * alternativa opuesta, contarlas como aprobadas, es justo la mentira que este
 * módulo trata de no decir.
 *
 * Una sola crítica no puede dejar la postura en zona aceptable: el tope es 55
 * mientras exista, porque un `trust` en pg_hba no se compensa con veinte
 * aciertos.
 */
export function securityScore(findings: SecurityFinding[]): {
  score: number;
  verified: number;
  total: number;
} {
  const verifiable = findings.filter((finding) => finding.severity !== 'no_verificable');
  const penalty = verifiable.reduce((sum, finding) => sum + PENALTY[finding.severity], 0);

  let score = Math.max(0, 100 - penalty);
  if (verifiable.some((finding) => finding.severity === 'critica')) score = Math.min(score, 55);
  if (verifiable.some((finding) => finding.severity === 'alta')) score = Math.min(score, 80);

  return { score, verified: verifiable.length, total: findings.length };
}

/**
 * Marca una comprobación como no ejecutable por permisos.
 *
 * Recibe el error real para no inventar la causa: un timeout y un permiso
 * denegado no son lo mismo, y confundirlos manda al DBA a conceder privilegios
 * que no hacían falta.
 */
export function unverifiable(
  checkId: string,
  category: SecurityCategory,
  title: string,
  requirement: string,
  error: unknown,
): SecurityFinding {
  const message = error instanceof Error ? error.message : String(error);
  return {
    checkId,
    category,
    severity: 'no_verificable',
    title,
    detail: `Could not verify: ${message}`,
    remediation: requirement,
    evidence: { error: message },
  };
}

export function ok(
  checkId: string,
  category: SecurityCategory,
  title: string,
  detail: string,
  evidence?: Record<string, unknown>,
): SecurityFinding {
  return { checkId, category, severity: 'ok', title, detail, evidence };
}
