import Link from 'next/link';

/** Shared cheat-sheet: three alert planes ≠ Kibana one Alerts app. */
export function AlertPlanesNotice({ active }: { active: 'databases' | 'app' | 'security' }) {
  const item = (key: typeof active, href: string, label: string, silence: string) => {
    const on = active === key;
    return (
      <span className={on ? 'font-medium text-foreground' : undefined}>
        <Link href={href} className="underline">
          {label}
        </Link>
        <span className="text-foreground-muted"> · {silence}</span>
      </span>
    );
  };

  return (
    <div className="notice">
      <strong>Three alert planes</strong> (not Kibana’s one Alerts app):{' '}
      {item('databases', '/alerts', 'Databases', 'silence on row / Admin → Alerts')}
      {' · '}
      {item('app', '/observability/alerts', 'App (probe/APM/SLO)', 'silence on row → Admin')}
      {' · '}
      {item(
        'security',
        '/observability/security/alerts',
        'Security',
        'ack / open case · lab not SIEM',
      )}
    </div>
  );
}
