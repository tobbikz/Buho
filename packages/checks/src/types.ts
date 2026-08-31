import type { Capabilities } from '@buho/core';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Objeto afectado: base, tabla, índice, slot… */
  object?: string;
  message: string;
  remediation: string;
  value?: number;
}

export interface CheckResult extends Finding {
  checkId: string;
  title: string;
}

export interface CheckDefinition {
  id: string;
  title: string;
  /** Qué mira el check, en una línea, para el informe. */
  description: string;
  appliesTo?: (caps: Capabilities) => boolean;
  /** null = el check se resuelve con el capability probe, sin consultar. */
  sql: (caps: Capabilities) => string | null;
  evaluate: (rows: Record<string, unknown>[], caps: Capabilities) => Finding[];
}
