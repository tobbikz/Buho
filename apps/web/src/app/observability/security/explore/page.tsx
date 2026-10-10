import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { SecurityAccountsView } from '@/components/SecurityAccountsView';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { getPrincipals } from '@/lib/security';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Explore · Security · Observability · Búho' };

const WEAK_AUTH = new Set(['md5', 'mysql_native_password', 'mysql_old_password', 'no password']);

export default async function SecurityExplorePage() {
  let principals;
  try {
    principals = await getPrincipals();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const superusers = principals.filter((p) => p.isSuperuser && !p.disabled);
  const weak = principals.filter((p) => p.authMethod && WEAK_AUTH.has(p.authMethod));
  const anyHost = principals.filter((p) => p.principalHost === '%');
  const loginCapable = principals.filter((p) => p.canLogin);
  const withMembership = principals.filter((p) => (p.detail.memberOf?.length ?? 0) > 0);
  const withGrants = principals.filter((p) => (p.detail.grants?.length ?? 0) > 0);
  const disabled = principals.filter((p) => p.disabled);
  const sprawl = principals.filter((p) => {
    const roles = p.detail.memberOf?.length ?? 0;
    const grants = p.detail.grants?.length ?? 0;
    return roles >= 5 || grants >= 20 || p.privileges.length >= 8;
  });

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security"
        title="Explore"
        sub={
          principals.length > 0 ? (
            <>
              Principals · roles · grants · {loginCapable.length}/{principals.length} can sign in
              {disabled.length > 0 ? ` · ${disabled.length} disabled` : ''}
            </>
          ) : (
            'Principals · roles · grants across engines'
          )
        }
      />

      {principals.length === 0 ? (
        <ObsEmpty title="No principals yet" actions={[{ href: '/', label: 'Databases fleet' }]}>
          Appears after the collector security audit.
        </ObsEmpty>
      ) : (
        <>
          <div className="stat-grid obs-services-kpis">
            <StatCard
              label="Full control"
              value={String(superusers.length)}
              hint="superuser / sysadmin"
              tone={superusers.length > 3 ? 'warn' : 'neutral'}
            />
            <StatCard
              label="Weak auth"
              value={String(weak.length)}
              hint="md5 / native / none"
              tone={weak.length > 0 ? 'error' : 'ok'}
            />
            <StatCard
              label="Any host"
              value={String(anyHost.length)}
              hint="host '%'"
              tone={anyHost.length > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              label="Role sprawl"
              value={String(sprawl.length)}
              hint="≥5 roles or ≥20 grants"
              tone={sprawl.length > 0 ? 'warn' : 'ok'}
            />
          </div>

          <SecurityAccountsView principals={principals} />
        </>
      )}
    </div>
  );
}
