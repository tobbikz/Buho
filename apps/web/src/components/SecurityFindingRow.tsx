import Link from 'next/link';

export interface SecurityFindingRowProps {
  instanceId: number;
  alias: string;
  engine?: string;
  categoryLabel: string;
  title: string;
  detail: string;
  remediation?: string | null;
  severityClass: string;
}

export function SecurityFindingRow({
  instanceId,
  alias,
  engine,
  categoryLabel,
  title,
  detail,
  remediation,
  severityClass,
}: SecurityFindingRowProps) {
  return (
    <article className={`finding finding--stack ${severityClass}`}>
      <div className="finding__meta">
        <Link href={`/instances/${instanceId}`} className="finding__instance">
          {alias}
        </Link>
        {engine ? <span className="tag tag--muted">{engine}</span> : null}
        <span className="tag tag--muted">{categoryLabel}</span>
      </div>
      <h3 className="finding__title">{title}</h3>
      <p className="finding__message">{detail}</p>
      {remediation ? (
        <div className="finding__remediation">
          <span className="finding__remediation-label">Remediation</span>
          {remediation}
        </div>
      ) : null}
    </article>
  );
}
