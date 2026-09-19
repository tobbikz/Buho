import { SecurityAccountsView } from '@/components/SecurityAccountsView';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { getPrincipals } from '@/lib/security';

export const dynamic = 'force-dynamic';

const WEAK_AUTH = new Set(['md5', 'mysql_native_password', 'mysql_old_password', 'no password']);

export default async function AccountsPage() {
  let principals;
  try {
    principals = await getPrincipals();
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const superusers = principals.filter((principal) => principal.isSuperuser && !principal.disabled);
  const weak = principals.filter(
    (principal) => principal.authMethod && WEAK_AUTH.has(principal.authMethod),
  );
  const anyHost = principals.filter((principal) => principal.principalHost === '%');
  const loginCapable = principals.filter((principal) => principal.canLogin);
  const withMembership = principals.filter((principal) => (principal.detail.memberOf?.length ?? 0) > 0);
  const withGrants = principals.filter((principal) => (principal.detail.grants?.length ?? 0) > 0);
  const disabled = principals.filter((principal) => principal.disabled);
  const sprawl = principals.filter((principal) => {
    const roles = principal.detail.memberOf?.length ?? 0;
    const grants = principal.detail.grants?.length ?? 0;
    return roles >= 5 || grants >= 20 || principal.privileges.length >= 8;
  });

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Accounts with full control"
          value={String(superusers.length)}
          hint="superuser or sysadmin, active"
          tone={superusers.length > 3 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Weak authentication"
          value={String(weak.length)}
          hint="md5, native_password, or no password"
          tone={weak.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Reachable from any host"
          value={String(anyHost.length)}
          hint="host '%' in MariaDB"
          tone={anyHost.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Disabled / inactive"
          value={String(disabled.length)}
          hint="account marked disabled"
          tone={disabled.length > 0 ? 'neutral' : 'ok'}
        />
        <StatCard
          label="Role sprawl"
          value={String(sprawl.length)}
          hint="≥5 roles, ≥20 grants, or ≥8 globals"
          tone={sprawl.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Can sign in"
          value={String(loginCapable.length)}
          hint={`of ${principals.length} total`}
        />
        <StatCard
          label="With role membership"
          value={String(withMembership.length)}
          hint="inherits from at least one role"
        />
        <StatCard
          label="With object grants"
          value={String(withGrants.length)}
          hint="database, schema, or table access"
        />
      </div>

      <SecurityAccountsView principals={principals} />
    </div>
  );
}
