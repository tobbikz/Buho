'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { formatAgo } from '@/lib/format';

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle',
};

export interface PrincipalView {
  instanceId: number;
  alias: string;
  engine: string;
  name: string;
  principalHost: string;
  kind: string;
  canLogin: boolean;
  isSuperuser: boolean;
  disabled: boolean;
  authMethod: string | null;
  passwordSetAt: Date | null;
  expiresAt: Date | null;
  privileges: string[];
  detail: {
    memberOf?: string[];
    members?: string[];
    grants?: { scope: string; name: string; privileges: string[] }[];
  };
}

const WEAK_AUTH = new Set(['md5', 'mysql_native_password', 'mysql_old_password', 'no password']);

type KindFilter = 'all' | 'login' | 'role' | 'superuser' | 'disabled' | 'sprawl';

function authTone(method: string | null): string {
  if (!method) return 'tag tag--muted';
  if (WEAK_AUTH.has(method)) return 'tag tag--error';
  if (method === 'scram-sha-256' || method === 'ed25519' || method === 'unix_socket') return 'tag tag--ok';
  return 'tag tag--muted';
}

function accountKind(principal: PrincipalView): 'login' | 'role' | 'group' {
  const kind = principal.kind.toLowerCase();
  if (kind.includes('group') || kind === 'g') return 'group';
  if (kind === 'role' || kind === 'rol' || kind.includes('role') || !principal.canLogin) return 'role';
  return 'login';
}

function accountLabel(principal: PrincipalView): string {
  if (principal.principalHost) {
    return `${principal.name}@${principal.principalHost}`;
  }
  return principal.name;
}

function rowKey(principal: PrincipalView): string {
  return `${principal.instanceId}:${principal.name}:${principal.principalHost}`;
}

function summaryLine(principal: PrincipalView): string {
  const parts: string[] = [];
  const memberOf = principal.detail.memberOf?.length ?? 0;
  const members = principal.detail.members?.length ?? 0;
  const grants = principal.detail.grants?.length ?? 0;
  const globals = principal.privileges.length;

  if (memberOf > 0) parts.push(`${memberOf} role${memberOf === 1 ? '' : 's'}`);
  if (members > 0) parts.push(`${members} member${members === 1 ? '' : 's'}`);
  if (grants > 0) parts.push(`${grants} object${grants === 1 ? '' : 's'}`);
  if (globals > 0) parts.push(`${globals} global`);
  return parts.length > 0 ? parts.join(' · ') : 'no mapped access';
}

export function SecurityAccountsView({ principals }: { principals: PrincipalView[] }) {
  const [instanceId, setInstanceId] = useState<number | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAllGrants, setShowAllGrants] = useState<string | null>(null);

  const instances = useMemo(() => {
    const map = new Map<number, { alias: string; engine: string }>();
    for (const principal of principals) {
      map.set(principal.instanceId, { alias: principal.alias, engine: principal.engine });
    }
    return [...map.entries()].sort((a, b) => a[1].alias.localeCompare(b[1].alias));
  }, [principals]);

  const filtered = useMemo(() => {
    return principals.filter((principal) => {
      if (instanceId !== 'all' && principal.instanceId !== instanceId) return false;
      if (kindFilter === 'superuser') return principal.isSuperuser && !principal.disabled;
      if (kindFilter === 'disabled') return principal.disabled;
      if (kindFilter === 'sprawl') {
        const roles = principal.detail.memberOf?.length ?? 0;
        const grants = principal.detail.grants?.length ?? 0;
        return roles >= 5 || grants >= 20 || principal.privileges.length >= 8;
      }
      if (kindFilter === 'login') return accountKind(principal) === 'login';
      if (kindFilter === 'role') {
        const kind = accountKind(principal);
        return kind === 'role' || kind === 'group';
      }
      return true;
    });
  }, [principals, instanceId, kindFilter]);

  const grouped = useMemo(() => {
    const map = new Map<number, PrincipalView[]>();
    for (const principal of filtered) {
      const list = map.get(principal.instanceId) ?? [];
      list.push(principal);
      map.set(principal.instanceId, list);
    }
    return [...map.entries()].sort((a, b) => {
      const aliasA = a[1][0]?.alias ?? '';
      const aliasB = b[1][0]?.alias ?? '';
      return aliasA.localeCompare(aliasB);
    });
  }, [filtered]);

  const chip = (value: KindFilter, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setKindFilter(value)}
      className={`tag ${kindFilter === value ? 'tag--info' : 'tag--muted'}`}
      style={{ cursor: 'pointer' }}
    >
      {label}
    </button>
  );

  if (principals.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">No inventoried accounts</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary">
          Reading accounts requires privileges the monitoring user may not have: pg_authid and
          information_schema on PostgreSQL, mysql.user on MariaDB, sys.server_principals on SQL Server.
          Blind checks appear on the Findings tab when a permission is missing.
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Principal explorer</span>
          <span className="text-[11px] text-foreground-muted">
            click a row for membership and object access
          </span>
        </div>
        <div className="panel-body flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
          <label className="flex items-center gap-2 text-[11px] text-foreground-secondary">
            Instance
            <select
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px]"
              value={instanceId === 'all' ? 'all' : String(instanceId)}
              onChange={(event) =>
                setInstanceId(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
            >
              <option value="all">All instances</option>
              {instances.map(([id, meta]) => (
                <option key={id} value={id}>
                  {meta.alias}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-1">
            {chip('all', `All ${filtered.length}`)}
            {chip('login', 'Logins')}
            {chip('role', 'Roles & groups')}
            {chip('superuser', 'Superusers')}
            {chip('disabled', 'Disabled')}
            {chip('sprawl', 'Role sprawl')}
          </div>
        </div>

        {grouped.length === 0 ? (
          <div className="empty">No principals match this filter.</div>
        ) : (
          grouped.map(([id, rows]) => (
            <div key={id} className="accounts-instance-block">
              {instanceId === 'all' ? (
                <div className="accounts-instance-block__header">
                  <Link href={`/instances/${id}`} className="font-semibold underline decoration-dotted">
                    {rows[0]?.alias}
                  </Link>
                  <span className="text-[11px] text-foreground-muted">
                    {ENGINE_LABEL[rows[0]?.engine ?? ''] ?? rows[0]?.engine} · {rows.length} principal(s)
                  </span>
                </div>
              ) : null}

              <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Principal</th>
                      <th>Type</th>
                      <th>Summary</th>
                      <th>Authentication</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((principal) => {
                      const key = rowKey(principal);
                      const isOpen = expanded === key;
                      const kind = accountKind(principal);
                      const grants = principal.detail.grants ?? [];
                      const grantLimit = showAllGrants === key ? grants.length : 40;

                      return (
                        <Fragment key={key}>
                          <tr
                            onClick={() => setExpanded(isOpen ? null : key)}
                            style={{
                              cursor: 'pointer',
                              background: isOpen ? 'var(--accent-subtle)' : undefined,
                            }}
                          >
                            <td className="font-mono text-[11px]">
                              <span className="mr-1 text-foreground-muted">{isOpen ? '▾' : '▸'}</span>
                              {accountLabel(principal)}
                              {principal.isSuperuser ? (
                                <span className="ml-1 tag tag--error">superuser</span>
                              ) : null}
                            </td>
                            <td className="text-[11px] capitalize">{kind}</td>
                            <td className="text-[11px] text-foreground-secondary">{summaryLine(principal)}</td>
                            <td>
                              {principal.authMethod ? (
                                <span className={`tag ${authTone(principal.authMethod)}`}>
                                  {principal.authMethod}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>
                              {principal.disabled ? (
                                <span className="tag tag--muted">disabled</span>
                              ) : principal.canLogin ? (
                                <span className="tag tag--ok">active</span>
                              ) : (
                                <span className="tag tag--muted">no login</span>
                              )}
                            </td>
                          </tr>
                          {isOpen ? (
                            <tr>
                              <td colSpan={5} style={{ background: 'var(--surface-raised)', padding: 0 }}>
                                <div className="accounts-detail">
                                  <div className="accounts-detail__grid">
                                    <div>
                                      <div className="config-detail__label">Global attributes</div>
                                      {principal.privileges.length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                          {principal.privileges.map((privilege) => (
                                            <span
                                              key={privilege}
                                              className={`tag ${
                                                privilege === 'SUPERUSER' ||
                                                privilege === 'sysadmin' ||
                                                privilege === 'SUPER'
                                                  ? 'tag--error'
                                                  : 'tag--warn'
                                              }`}
                                            >
                                              {privilege}
                                            </span>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-[11px] text-foreground-muted">none recorded</span>
                                      )}
                                    </div>
                                    <div>
                                      <div className="config-detail__label">Credentials</div>
                                      <dl className="accounts-meta-list">
                                        <div>
                                          <dt>Password set</dt>
                                          <dd>{principal.passwordSetAt ? formatAgo(principal.passwordSetAt) : '—'}</dd>
                                        </div>
                                        <div>
                                          <dt>Expires</dt>
                                          <dd>{principal.expiresAt ? formatAgo(principal.expiresAt) : '—'}</dd>
                                        </div>
                                        <div>
                                          <dt>Engine kind</dt>
                                          <dd>{principal.kind}</dd>
                                        </div>
                                      </dl>
                                    </div>
                                  </div>

                                  <div className="accounts-detail__columns">
                                    <div>
                                      <div className="config-detail__label">Member of</div>
                                      {principal.detail.memberOf && principal.detail.memberOf.length > 0 ? (
                                        <ul className="accounts-list">
                                          {principal.detail.memberOf.map((role) => (
                                            <li key={role} className="font-mono text-[11px]">
                                              {role}
                                            </li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="text-[11px] text-foreground-muted">No role membership mapped</p>
                                      )}
                                    </div>
                                    <div>
                                      <div className="config-detail__label">Direct members</div>
                                      {principal.detail.members && principal.detail.members.length > 0 ? (
                                        <ul className="accounts-list">
                                          {principal.detail.members.map((member) => (
                                            <li key={member} className="font-mono text-[11px]">
                                              {member}
                                            </li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="text-[11px] text-foreground-muted">No direct members</p>
                                      )}
                                    </div>
                                  </div>

                                  <div>
                                    <div className="config-detail__label">Object access</div>
                                    {grants.length > 0 ? (
                                      <>
                                        <table className="data-table accounts-grants-table">
                                          <thead>
                                            <tr>
                                              <th>Scope</th>
                                              <th>Object</th>
                                              <th>Privileges</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {grants.slice(0, grantLimit).map((grant) => (
                                              <tr key={`${grant.scope}:${grant.name}`}>
                                                <td className="capitalize">{grant.scope}</td>
                                                <td className="font-mono text-[11px]">{grant.name}</td>
                                                <td className="text-[11px]">{grant.privileges.join(', ')}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                        {grants.length > 40 ? (
                                          <button
                                            type="button"
                                            className="mt-2 text-[11px] text-accent underline"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              setShowAllGrants(showAllGrants === key ? null : key);
                                            }}
                                          >
                                            {showAllGrants === key
                                              ? 'Show fewer grants'
                                              : `Show all ${grants.length} grants`}
                                          </button>
                                        ) : null}
                                      </>
                                    ) : (
                                      <p className="text-[11px] text-foreground-muted">
                                        No database, schema, or table grants recorded for this principal
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
