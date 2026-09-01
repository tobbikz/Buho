import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { engineLabel, getPrincipals, type Principal } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Métodos de autenticación que no deberían seguir en uso.
 *
 * Se marca el método, no la cuenta: una cuenta con scram y otra con md5 tienen
 * el mismo dueño y el mismo nombre, y lo único que cambia —lo único que hay que
 * arreglar— es cómo se guarda su contraseña.
 */
const WEAK_AUTH = new Set(['md5', 'mysql_native_password', 'mysql_old_password', 'no password']);

function authTone(method: string | null): string {
  if (!method) return 'tag tag--muted';
  if (WEAK_AUTH.has(method)) return 'tag tag--error';
  if (method === 'scram-sha-256' || method === 'ed25519' || method === 'unix_socket') return 'tag tag--ok';
  return 'tag tag--muted';
}

export default async function AccountsPage() {
  let principals: Principal[];
  try {
    principals = await getPrincipals();
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  if (principals.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">No inventoried accounts</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary">
          Leer las cuentas exige permisos que el usuario de monitoreo puede no tener: pg_authid en PostgreSQL,
          mysql.user in MariaDB, sys.server_principals in SQL Server. See the Coverage tab to learn what
          falta en cada instancia.
        </div>
      </section>
    );
  }

  const superusers = principals.filter((principal) => principal.isSuperuser && !principal.disabled);
  const weak = principals.filter(
    (principal) => principal.authMethod && WEAK_AUTH.has(principal.authMethod),
  );
  const anyHost = principals.filter((principal) => principal.principalHost === '%');
  const loginCapable = principals.filter((principal) => principal.canLogin);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Accounts with full control"
          value={String(superusers.length)}
          hint="superusuario o sysadmin, activas"
          tone={superusers.length > 3 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Weak authentication"
          value={String(weak.length)}
          hint="md5, native_password o no password"
          tone={weak.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Alcanzables desde cualquier host"
          value={String(anyHost.length)}
          hint="host '%' en MariaDB"
          tone={anyHost.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Can sign in" value={String(loginCapable.length)} hint={`de ${principals.length} en total`} />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Estate accounts</span>
          <span className="text-[11px] text-foreground-muted">
            ordenadas por privilegio: primero las que pueden hacer todo
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Instancia</th>
              <th>Engine</th>
              <th>Cuenta</th>
              <th>Tipo</th>
              <th>Authentication</th>
              <th>Privilegios</th>
              <th>Password set</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {principals.map((principal) => (
              <tr key={`${principal.instanceId}-${principal.name}-${principal.principalHost}`}>
                <td>
                  <Link href={`/instances/${principal.instanceId}`}>{principal.alias}</Link>
                </td>
                <td>{engineLabel(principal.engine)}</td>
                <td className="font-mono text-[11px]">
                  {principal.name}
                  {principal.principalHost ? (
                    <span className={principal.principalHost === '%' ? 'text-error' : 'text-foreground-muted'}>
                      @{principal.principalHost}
                    </span>
                  ) : null}
                </td>
                <td>{principal.kind}</td>
                <td>
                  {principal.authMethod ? (
                    <span className={authTone(principal.authMethod)}>{principal.authMethod}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {principal.privileges.length === 0 ? (
                    <span className="text-foreground-muted">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {principal.privileges.map((privilege) => (
                        <span
                          key={privilege}
                          className={`tag ${
                            privilege === 'SUPERUSER' || privilege === 'sysadmin' || privilege === 'SUPER'
                              ? 'tag--error'
                              : 'tag--warn'
                          }`}
                        >
                          {privilege}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td>{principal.passwordSetAt ? formatAgo(principal.passwordSetAt) : '—'}</td>
                <td>
                  {principal.disabled ? (
                    <span className="tag tag--muted">deshabilitada</span>
                  ) : principal.canLogin ? (
                    <span className="tag tag--ok">activa</span>
                  ) : (
                    <span className="tag tag--muted">no login</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
