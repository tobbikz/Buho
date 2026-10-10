import Link from 'next/link';

/** Honest Kibana Security-shaped rail — DB audit posture, not Elastic SIEM. */
export function SecurityLabBanner() {
  return (
    <div className="notice">
      <span className="tag tag--muted" style={{ marginRight: '0.5rem' }}>
        lab
      </span>
      <strong>Not a SIEM.</strong> DB security posture from the collector audit (principals,
      findings, cases) — not Elastic Security / detection-engine rules.{' '}
      <Link href="/observability/alerts" className="underline">
        App alerts
      </Link>{' '}
      ·{' '}
      <Link href="/alerts" className="underline">
        Databases alerts
      </Link>
      .
    </div>
  );
}
