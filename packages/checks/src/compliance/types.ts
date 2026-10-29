import type { Severity } from '../types';

export type ComplianceVerdict = 'pass' | 'fail' | 'not_verifiable';

export interface ComplianceControl {
  id: string;
  pack: 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
  title: string;
  description: string;
  /** SQL or JSON command document for foreign engines. */
  probeSql: string;
  evaluate: (rows: Record<string, unknown>[]) => {
    verdict: ComplianceVerdict;
    severity?: Severity;
    evidence: string;
    remediation?: string;
  };
}

export interface ComplianceRunResult {
  pack: string;
  controls: Array<{
    id: string;
    title: string;
    verdict: ComplianceVerdict;
    severity?: Severity;
    evidence: string;
    remediation?: string;
  }>;
  score: number;
}
