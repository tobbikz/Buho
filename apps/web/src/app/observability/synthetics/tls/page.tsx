import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TlsInventory } from '@/components/TlsInventory';
import { listTlsCertificates } from '@/lib/obs-infra';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'TLS · Búho' };

export default async function ObservabilityTlsPage() {
  let certs;
  try {
    certs = await listTlsCertificates();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const critical = certs.filter((c) => c.status === 'critical').length;
  const warn = certs.filter((c) => c.status === 'warn').length;
  const ok = certs.filter((c) => c.status === 'ok').length;
  const noTls = certs.filter((c) => c.status === 'unknown').length;
  const withCert = critical + warn + ok;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="TLS"
        title="TLS"
        sub="Certificate expiry from HTTPS probes · not APM"
        actions={
          <>
            <Link className="btn" href="/observability/synthetics">
              Live probes
            </Link>
            <Link className="btn btn--primary" href="/observability/synthetics">
              Add HTTPS probe
            </Link>
          </>
        }
      />

      <div className="stat-grid">
        <StatCard
          label="With cert"
          value={String(withCert)}
          hint="HTTPS probes with sample"
          tone={withCert > 0 ? 'ok' : 'neutral'}
        />
        <StatCard
          label="Critical"
          value={String(critical)}
          hint="< 7 days"
          tone={critical > 0 ? 'error' : 'neutral'}
        />
        <StatCard
          label="Expiring"
          value={String(warn)}
          hint="< 30 days"
          tone={warn > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="No TLS"
          value={String(noTls)}
          hint="HTTP-only probes"
          tone="neutral"
        />
      </div>

      {certs.length === 0 ? (
        <ObsEmpty
          title="No probes yet"
          actions={[{ href: '/observability/synthetics', label: 'Add probe', primary: true }]}
        >
          Save an <span className="font-mono">https://</span> HTTP probe to track certificate
          expiry. Plain HTTP targets appear as No TLS.
        </ObsEmpty>
      ) : (
        <TlsInventory
          certs={certs.map((c) => ({
            ...c,
            lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
          }))}
        />
      )}

      <p className="text-xs text-foreground-muted mt-3">
        TLS = black-box cert days-left from the same collector that runs Probes. Valid ≥ 30d ·
        Expiring &lt; 30d · Critical &lt; 7d.
        {ok > 0 ? ` · ${ok} valid right now.` : null}
      </p>
    </div>
  );
}
