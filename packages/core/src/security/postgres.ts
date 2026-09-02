import type { EngineClient } from '../engine';
import { tagged } from '../tag';
import {
  ok,
  securityScore,
  unverifiable,
  type SecurityAudit,
  type SecurityFinding,
  type SecurityGrant,
  type SecurityPrincipal,
  type SecurityPrincipalDetail,
} from './types';

async function tryQuery(
  client: EngineClient,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; error?: unknown }> {
  try {
    return { rows: await client.query(tagged(sql)) };
  } catch (error) {
    return { rows: [], error };
  }
}

function ensureDetail(principal: SecurityPrincipal): SecurityPrincipalDetail {
  principal.detail ??= {};
  return principal.detail;
}

function addGrant(
  byPrincipal: Map<string, SecurityGrant[]>,
  grantee: string,
  scope: SecurityGrant['scope'],
  name: string,
  privilege: string,
): void {
  const list = byPrincipal.get(grantee) ?? [];
  const existing = list.find((grant) => grant.scope === scope && grant.name === name);
  if (existing) {
    if (!existing.privileges.includes(privilege)) existing.privileges.push(privilege);
  } else {
    list.push({ scope, name, privileges: [privilege] });
  }
  byPrincipal.set(grantee, list);
}

async function attachPostgresPrincipalGraph(
  client: EngineClient,
  principals: SecurityPrincipal[],
): Promise<void> {
  const byName = new Map<string, SecurityPrincipal[]>();
  for (const principal of principals) {
    const list = byName.get(principal.name) ?? [];
    list.push(principal);
    byName.set(principal.name, list);
  }

  const memberships = await tryQuery(
    client,
    `select m.rolname as member, r.rolname as role, am.admin_option
       from pg_auth_members am
       join pg_roles m on m.oid = am.member
       join pg_roles r on r.oid = am.roleid
      where m.rolname not like 'pg\\_%'`,
  );

  if (!memberships.error) {
    for (const row of memberships.rows) {
      const member = String(row['member']);
      const role = String(row['role']);
      const label = row['admin_option'] === true ? `${role} (admin)` : role;

      for (const principal of byName.get(member) ?? []) {
        const detail = ensureDetail(principal);
        detail.memberOf ??= [];
        if (!detail.memberOf.includes(label)) detail.memberOf.push(label);
      }

      for (const principal of byName.get(role) ?? []) {
        const detail = ensureDetail(principal);
        detail.members ??= [];
        if (!detail.members.includes(member)) detail.members.push(member);
      }
    }
  }

  const grantRows = await tryQuery(
    client,
    `select grantee, 'database' as scope, object_catalog as name, privilege_type
       from information_schema.usage_privileges
      where object_type = 'DATABASE'
        and object_catalog not in ('template0', 'template1')
     union all
     select grantee, 'schema' as scope, object_schema as name, privilege_type
       from information_schema.usage_privileges
      where object_type = 'SCHEMA'
        and object_schema not like 'pg\\_%'
        and object_schema <> 'information_schema'
     union all
     select grantee, 'table' as scope,
            table_schema || '.' || table_name as name,
            privilege_type
       from information_schema.role_table_grants
      where table_schema not like 'pg\\_%'
        and table_schema <> 'information_schema'`,
  );

  if (!grantRows.error) {
    const grantsByGrantee = new Map<string, SecurityGrant[]>();
    for (const row of grantRows.rows) {
      addGrant(
        grantsByGrantee,
        String(row['grantee']),
        String(row['scope']) as SecurityGrant['scope'],
        String(row['name']),
        String(row['privilege_type']),
      );
    }

    for (const [grantee, grants] of grantsByGrantee) {
      for (const principal of byName.get(grantee) ?? []) {
        ensureDetail(principal).grants = grants.sort((a, b) =>
          a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
        );
      }
    }
  }
}

export async function auditPostgres(client: EngineClient): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];
  const principals: SecurityPrincipal[] = [];

  const hba = await tryQuery(
    client,
    `select line_number, type, database, user_name, address, netmask, auth_method, error
       from pg_hba_file_rules
      where error is null or error is not null
      order by line_number`,
  );

  if (hba.error) {
    findings.push(
      unverifiable(
        'pg_hba',
        'autenticacion',
        'Authentication rules (pg_hba.conf)',
        'Requires superuser or membership in a role with access to pg_hba_file_rules: grant pg_read_all_settings, or grant select on the view.',
        hba.error,
      ),
    );
  } else {
    const rules = hba.rows.map((row) => ({
      line: Number(row['line_number']),
      type: String(row['type'] ?? ''),
      database: (row['database'] as string[] | null)?.join(',') ?? 'all',
      user: (row['user_name'] as string[] | null)?.join(',') ?? 'all',
      address: (row['address'] as string | null) ?? 'local socket',
      method: String(row['auth_method'] ?? ''),
    }));

    const trust = rules.filter((rule) => rule.method === 'trust');
    if (trust.length > 0) {
      findings.push({
        checkId: 'pg_hba_trust',
        category: 'autenticacion',
        severity: 'critica',
        title: 'Trust authentication: login without password',
        detail: `${trust.length} pg_hba.conf rule(s) use trust, which accepts connections without a password: ${trust
          .map((rule) => `line ${rule.line} (${rule.type} ${rule.database} ${rule.user} from ${rule.address})`)
          .join('; ')}. Anyone who can reach that source can log in as the requested user, including a superuser.`,
        remediation:
          'Replace trust with scram-sha-256 in pg_hba.conf and reload configuration with pg_reload_conf(). For local maintenance sockets, peer is a reasonable alternative.',
        evidence: { rules: trust },
      });
    }

    const weak = rules.filter(
      (rule) => rule.type !== 'local' && (rule.method === 'md5' || rule.method === 'password'),
    );
    if (weak.length > 0) {
      const cleartext = weak.some((rule) => rule.method === 'password');
      findings.push({
        checkId: 'pg_hba_weak_auth',
        category: 'autenticacion',
        severity: cleartext ? 'critica' : 'alta',
        title: cleartext
          ? 'Cleartext passwords over the network'
          : 'MD5 authentication over the network',
        detail: `${weak.length} rule(s) accept network connections with ${
          cleartext ? 'password (cleartext)' : 'md5'
        }: ${weak.map((rule) => `line ${rule.line} from ${rule.address}`).join('; ')}.`,
        remediation:
          'Migrate to scram-sha-256: set password_encryption = scram-sha-256, have each user reset their password, then change the method in pg_hba.conf.',
        evidence: { rules: weak },
      });
    }

    const open = rules.filter(
      (rule) => rule.address === '0.0.0.0/0' || rule.address === '::/0' || rule.address === 'all',
    );
    if (open.length > 0) {
      findings.push({
        checkId: 'pg_hba_open',
        category: 'acceso_publico',
        severity: 'alta',
        title: 'Rules open to any source',
        detail: `${open.length} rule(s) accept connections from any address: ${open
          .map((rule) => `line ${rule.line} (${rule.method})`)
          .join('; ')}.`,
        remediation:
          'Restrict the range to networks that actually need access. The database should almost never be reachable from 0.0.0.0/0.',
        evidence: { rules: open },
      });
    }

    if (trust.length === 0 && weak.length === 0 && open.length === 0) {
      findings.push(
        ok('pg_hba', 'autenticacion', 'Authentication rules', `${rules.length} rules reviewed; no trust or exposed md5.`),
      );
    }
  }

  const settings = await tryQuery(
    client,
    `select name, reset_val from pg_settings
      where name in ('ssl', 'password_encryption', 'log_connections', 'log_disconnections',
                     'ssl_min_protocol_version', 'row_security', 'log_statement')`,
  );
  const setting = (name: string): string =>
    String(settings.rows.find((row) => row['name'] === name)?.['reset_val'] ?? '');

  if (settings.error) {
    findings.push(
      unverifiable('pg_settings_security', 'cifrado', 'Security parameters', 'Requires read access to pg_settings.', settings.error),
    );
  } else {
    const ssl = setting('ssl');
    if (ssl !== 'on') {
      findings.push({
        checkId: 'pg_ssl_off',
        category: 'cifrado',
        severity: 'alta',
        title: 'TLS disabled',
        detail:
          'ssl is off: all traffic — including passwords and query data — travels unencrypted. Anyone with network access can read it.',
        remediation:
          'Generate a certificate, set ssl = on, restart, and require encryption in pg_hba.conf using hostssl instead of host.',
        evidence: { ssl },
      });
    } else {
      findings.push(ok('pg_ssl_off', 'cifrado', 'TLS enabled', `ssl = on, minimum version ${setting('ssl_min_protocol_version') || 'not set'}.`));
    }

    const encryption = setting('password_encryption');
    if (encryption !== 'scram-sha-256') {
      findings.push({
        checkId: 'pg_password_encryption',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Weak password encryption',
        detail: `password_encryption = ${encryption}. PostgreSQL md5 hashes are reusable: someone who captures the hash can authenticate without knowing the password.`,
        remediation:
          'Set password_encryption = scram-sha-256 and have each user reset their password; old hashes are not upgraded automatically.',
        evidence: { password_encryption: encryption },
      });
    } else {
      findings.push(ok('pg_password_encryption', 'autenticacion', 'Password encryption', 'scram-sha-256.'));
    }

    const logConnections = setting('log_connections');
    const logsConnections = logConnections !== '' && logConnections !== 'off';
    if (!logsConnections) {
      findings.push({
        checkId: 'pg_connection_logging',
        category: 'auditoria',
        severity: 'media',
        title: 'Connections are not logged',
        detail:
          'log_connections is disabled. Without that log there is no way to know after an incident who connected, from where, and when.',
        remediation:
          "Enable log_connections (in PG18 this accepts a list, e.g. 'authentication,authorization,connect') and log_disconnections = on.",
        evidence: { log_connections: logConnections, log_disconnections: setting('log_disconnections') },
      });
    } else {
      findings.push(ok('pg_connection_logging', 'auditoria', 'Connection logging', `log_connections = ${logConnections}.`));
    }
  }

  const roles = await tryQuery(
    client,
    `select r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
            r.rolreplication, r.rolcanlogin, r.rolvaliduntil,
            r.rolname = current_user as es_buho
       from pg_roles r
      where r.rolname not like 'pg\\_%'
      order by r.rolsuper desc, r.rolname`,
  );

  if (roles.error) {
    findings.push(
      unverifiable('pg_privileges', 'privilegios', 'Privileged roles', 'Requires read access to pg_roles.', roles.error),
    );
  } else {
    for (const row of roles.rows) {
      const privileges: string[] = [];
      if (row['rolsuper'] === true) privileges.push('SUPERUSER');
      if (row['rolcreaterole'] === true) privileges.push('CREATEROLE');
      if (row['rolcreatedb'] === true) privileges.push('CREATEDB');
      if (row['rolbypassrls'] === true) privileges.push('BYPASSRLS');
      if (row['rolreplication'] === true) privileges.push('REPLICATION');

      principals.push({
        name: String(row['rolname']),
        kind: row['rolcanlogin'] === true ? 'login' : 'role',
        canLogin: row['rolcanlogin'] === true,
        isSuperuser: row['rolsuper'] === true,
        disabled: false,
        expiresAt: row['rolvaliduntil'] ? new Date(row['rolvaliduntil'] as string) : null,
        privileges,
      });
    }

    const superusers = principals.filter((principal) => principal.isSuperuser && principal.canLogin);
    if (superusers.length > 2) {
      findings.push({
        checkId: 'pg_superuser_sprawl',
        category: 'privilegios',
        severity: 'media',
        title: 'Too many superusers',
        detail: `${superusers.length} login roles are superusers: ${superusers
          .map((principal) => principal.name)
          .join(', ')}. A superuser can read and delete anything and bypass every row restriction.`,
        remediation:
          'Keep superuser only where it is truly required. For specific tasks use predefined roles: pg_monitor, pg_read_all_data, pg_write_all_data, pg_signal_backend.',
        evidence: { superusers: superusers.map((principal) => principal.name) },
      });
    } else {
      findings.push(
        ok('pg_superuser_sprawl', 'privilegios', 'Superusers', `${superusers.length} superuser(s) with login.`),
      );
    }

    const self = roles.rows.find((row) => row['es_buho'] === true);
    if (self?.['rolsuper'] === true) {
      findings.push({
        checkId: 'pg_monitor_is_superuser',
        category: 'privilegios',
        severity: 'media',
        title: 'Búho connects as superuser',
        detail: `The monitoring user (${self['rolname']}) is a superuser. Búho only needs read access to statistics, so this privilege expands the attack surface without benefit.`,
        remediation:
          'Create a dedicated role and use it in config: create role buho_monitor login password \'…\'; grant pg_monitor to buho_monitor;',
        evidence: { user: self['rolname'] },
      });
    }

    const bypass = principals.filter(
      (principal) => principal.privileges.includes('BYPASSRLS') && !principal.isSuperuser,
    );
    if (bypass.length > 0) {
      findings.push({
        checkId: 'pg_bypassrls',
        category: 'privilegios',
        severity: 'media',
        title: 'Roles bypassing row-level security',
        detail: `${bypass.length} non-superuser role(s) have BYPASSRLS: ${bypass
          .map((principal) => principal.name)
          .join(', ')}. Row-level security policies do not apply to them.`,
        remediation: 'Remove the attribute unless the role exists specifically to bypass RLS: alter role … nobypassrls;',
        evidence: { roles: bypass.map((principal) => principal.name) },
      });
    }
  }

  const authid = await tryQuery(
    client,
    `select rolname,
            case when rolpassword is null then 'no password'
                 when rolpassword like 'SCRAM-SHA-256%' then 'scram-sha-256'
                 when rolpassword like 'md5%' then 'md5'
                 else 'other' end as metodo
       from pg_authid
      where rolcanlogin`,
  );

  if (authid.error) {
    findings.push(
      unverifiable(
        'pg_password_hashes',
        'autenticacion',
        'Stored password encryption',
        'Requires superuser or pg_read_all_stats to read pg_authid. Without this, legacy MD5 passwords cannot be detected even if password_encryption is already scram.',
        authid.error,
      ),
    );
  } else {
    for (const row of authid.rows) {
      const principal = principals.find((candidate) => candidate.name === row['rolname']);
      if (principal) principal.authMethod = String(row['metodo']);
    }

    const md5 = authid.rows.filter((row) => row['metodo'] === 'md5');
    const nopass = authid.rows.filter((row) => row['metodo'] === 'no password');

    if (md5.length > 0) {
      findings.push({
        checkId: 'pg_md5_passwords',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Passwords stored as MD5',
        detail: `${md5.length} role(s) still have md5 password hashes: ${md5
          .map((row) => String(row['rolname']))
          .join(', ')}. Changing password_encryption does not rewrite old hashes.`,
        remediation: 'Have those roles reset their passwords with password_encryption already set to scram-sha-256.',
        evidence: { roles: md5.map((row) => row['rolname']) },
      });
    }

    if (nopass.length > 0) {
      findings.push({
        checkId: 'pg_no_password',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Login roles without a password',
        detail: `${nopass.length} role(s) can log in but have no password set: ${nopass
          .map((row) => String(row['rolname']))
          .join(', ')}. They are only protected by the pg_hba.conf rule that applies; if that rule is trust, they are not protected at all.`,
        remediation: 'Assign a password, or remove the LOGIN attribute if the role only groups permissions.',
        evidence: { roles: nopass.map((row) => row['rolname']) },
      });
    }

    if (md5.length === 0 && nopass.length === 0) {
      findings.push(
        ok('pg_md5_passwords', 'autenticacion', 'Stored passwords', `${authid.rows.length} login role(s), all using scram-sha-256.`),
      );
    }
  }

  const publicAccess = await tryQuery(
    client,
    `select n.nspname as esquema,
            has_schema_privilege('public', n.nspname, 'CREATE') as puede_crear
       from pg_namespace n
      where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'`,
  );

  if (publicAccess.error) {
    findings.push(
      unverifiable('pg_public_schema', 'acceso_publico', 'PUBLIC permissions', 'Requires read access to the schema catalog.', publicAccess.error),
    );
  } else {
    const writable = publicAccess.rows.filter((row) => row['puede_crear'] === true);
    if (writable.length > 0) {
      findings.push({
        checkId: 'pg_public_schema_create',
        category: 'acceso_publico',
        severity: 'media',
        title: 'PUBLIC can create objects',
        detail: `The PUBLIC role — any user — can create objects in ${writable.length} schema(s): ${writable
          .map((row) => String(row['esquema']))
          .join(', ')}. This enables search-path function hijacking attacks.`,
        remediation: 'revoke create on schema … from public; (on PostgreSQL 15+ this is already the default for the public schema)',
        evidence: { schemas: writable.map((row) => row['esquema']) },
      });
    } else {
      findings.push(
        ok('pg_public_schema_create', 'acceso_publico', 'PUBLIC permissions', 'PUBLIC cannot create objects in any schema.'),
      );
    }
  }

  const extensions = await tryQuery(
    client,
    `select extname from pg_extension
      where extname in ('dblink','postgres_fdw','file_fdw','plpythonu','plpython3u',
                        'plperlu','pltclu','adminpack','pgaudit')`,
  );

  if (!extensions.error) {
    const installed = extensions.rows.map((row) => String(row['extname']));
    const risky = installed.filter((name) => name !== 'pgaudit');

    if (risky.length > 0) {
      findings.push({
        checkId: 'pg_risky_extensions',
        category: 'superficie',
        severity: 'media',
        title: 'Extensions that expand the attack surface',
        detail: `Installed: ${risky.join(', ')}. Untrusted languages (plpythonu, plperlu) run arbitrary code on the server; remote access extensions (dblink, postgres_fdw) reach other systems with the server identity.`,
        remediation:
          'Drop unused extensions. For those you need, restrict who can execute them: revoke execute … from public and grant only to roles that require them.',
        evidence: { extensions: risky },
      });
    } else {
      findings.push(ok('pg_risky_extensions', 'superficie', 'Sensitive extensions', 'None installed.'));
    }

    if (!installed.includes('pgaudit')) {
      findings.push({
        checkId: 'pg_pgaudit',
        category: 'auditoria',
        severity: 'baja',
        title: 'No detailed audit extension',
        detail:
          'pgaudit is not installed. Native logging can record which statements ran, but it does not provide the per-object, per-role audit trail many compliance frameworks expect.',
        remediation: 'Install pgaudit and add it to shared_preload_libraries if a compliance requirement calls for it.',
        evidence: {},
      });
    } else {
      findings.push(ok('pg_pgaudit', 'auditoria', 'Detailed audit', 'pgaudit installed.'));
    }
  }

  await attachPostgresPrincipalGraph(client, principals);

  const { score, verified, total } = securityScore(findings);
  return { engine: 'postgres', findings, principals, score, verified, total };
}
