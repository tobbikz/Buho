import type { EngineClient } from '../engine';
import {
  ok,
  securityScore,
  unverifiable,
  type SecurityAudit,
  type SecurityFinding,
  type SecurityPrincipal,
} from './types';

async function tryQuery(
  client: EngineClient,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; error?: unknown }> {
  try {
    return { rows: await client.query(sql) };
  } catch (error) {
    return { rows: [], error };
  }
}

/**
 * Diccionario mínimo para la prueba de contraseñas.
 *
 * SQL Server permite comparar una contraseña candidata contra el hash guardado
 * con PWDCOMPARE, sin descifrar nada y sin intentar iniciar sesión: no genera
 * intentos fallidos ni bloquea cuentas. Es la comprobación de seguridad más
 * valiosa que ofrece el motor y ningún otro de los tres tiene equivalente.
 *
 * La lista es corta a propósito. No es un ataque de fuerza bruta: son las
 * contraseñas que de verdad aparecen en instalaciones reales, y cada entrada
 * cuesta una comparación por login. `null` significa "la contraseña es igual al
 * nombre del login", que es el caso más común de todos.
 */
const WEAK_PASSWORDS: (string | null)[] = [
  '',
  null,
  'password',
  'Password1',
  'Password123',
  'sa',
  '123456',
  'admin',
  'sql',
  'test',
  'P@ssw0rd',
  'changeme',
];

const SURFACE_AREA: Record<string, { severity: 'alta' | 'media'; why: string }> = {
  xp_cmdshell: {
    severity: 'alta',
    why: 'runs operating-system commands as the SQL Server service account',
  },
  'Ole Automation Procedures': {
    severity: 'alta',
    why: 'can instantiate COM objects and leave the engine',
  },
  'Ad Hoc Distributed Queries': {
    severity: 'media',
    why: 'can open arbitrary connections with OPENROWSET from a query',
  },
  'clr enabled': { severity: 'media', why: 'runs .NET assemblies inside the engine' },
  'Database Mail XPs': { severity: 'media', why: 'can send mail, and with it exfiltrate data' },
  'cross db ownership chaining': {
    severity: 'media',
    why: 'extends permissions across databases by ownership chain and breaks isolation',
  },
};

export async function auditMssql(client: EngineClient): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];
  const principals: SecurityPrincipal[] = [];

  // -------------------------------------------------- principales y sysadmin
  const logins = await tryQuery(
    client,
    `select p.name, p.type_desc, p.is_disabled, p.create_date, p.modify_date,
            l.is_policy_checked, l.is_expiration_checked,
            cast(LOGINPROPERTY(p.name, 'PasswordLastSetTime') as datetime) as password_last_set,
            cast(LOGINPROPERTY(p.name, 'IsLocked') as int) as is_locked,
            (select count(*) from sys.server_role_members m
               join sys.server_principals r on r.principal_id = m.role_principal_id
              where m.member_principal_id = p.principal_id and r.name = 'sysadmin') as es_sysadmin
       from sys.server_principals p
       left join sys.sql_logins l on l.principal_id = p.principal_id
      where p.type in ('S', 'U', 'G') and p.name not like '##%'
      order by p.name`,
  );

  if (logins.error) {
    findings.push(
      unverifiable(
        'mssql_logins',
        'privilegios',
        'Server logins',
        'Requires VIEW ANY DEFINITION or membership in securityadmin. Without it, logins and their password policy are invisible.',
        logins.error,
      ),
    );
  } else {
    for (const row of logins.rows) {
      const isSysadmin = Number(row['es_sysadmin'] ?? 0) > 0;
      principals.push({
        name: String(row['name']),
        kind: String(row['type_desc'] ?? ''),
        canLogin: row['is_disabled'] !== true,
        isSuperuser: isSysadmin,
        disabled: row['is_disabled'] === true,
        authMethod: String(row['type_desc'] ?? ''),
        passwordSetAt: row['password_last_set'] ? new Date(String(row['password_last_set'])) : null,
        privileges: isSysadmin ? ['sysadmin'] : [],
      });
    }

    const sysadmins = principals.filter((principal) => principal.isSuperuser && !principal.disabled);
    // BUILTIN\Administrators como sysadmin significa que cualquier
    // administrador del sistema operativo es dueño de la base de datos, aunque
    // nadie le haya dado permisos en SQL Server.
    const builtin = sysadmins.filter((principal) => /BUILTIN\\Administrators/i.test(principal.name));

    if (builtin.length > 0) {
      findings.push({
        checkId: 'mssql_builtin_admins',
        category: 'privilegios',
        severity: 'alta',
        title: 'Operating-system administrators are sysadmin',
        detail:
          'The BUILTIN\\Administrators group is in the sysadmin role: any administrator of the operating system has full control of SQL Server without a grant inside the database.',
        remediation:
          'Drop the group from the role and grant sysadmin to named accounts: alter server role sysadmin drop member [BUILTIN\\Administrators];',
        evidence: { miembros: builtin.map((principal) => principal.name) },
      });
    }

    if (sysadmins.length > 3) {
      findings.push({
        checkId: 'mssql_sysadmin_sprawl',
        category: 'privilegios',
        severity: 'media',
        title: 'Too many sysadmins',
        detail: `${sysadmins.length} active logins are sysadmin: ${sysadmins
          .map((principal) => principal.name)
          .join(', ')}.`,
        remediation: 'Review the list and keep only what is required; concrete jobs can use roles such as dbcreator, processadmin, or diskadmin.',
        evidence: { sysadmins: sysadmins.map((principal) => principal.name) },
      });
    } else {
      findings.push(ok('mssql_sysadmin_sprawl', 'privilegios', 'sysadmin members', `${sysadmins.length} login(s).`));
    }

    const sa = logins.rows.find((row) => String(row['name']).toLowerCase() === 'sa');
    if (sa && sa['is_disabled'] !== true) {
      findings.push({
        checkId: 'mssql_sa_enabled',
        category: 'autenticacion',
        severity: 'alta',
        title: 'The sa account is enabled',
        detail:
          'sa is active under its original name. It is the first account every automated attack tries, and the name cannot be guessed wrong because it is the same on every install.',
        remediation:
          'Disable it if it is unused (alter login sa disable) or at least rename it (alter login sa with name = …), and use named accounts for administration.',
        evidence: { create_date: sa['create_date'] },
      });
    } else if (sa) {
      findings.push(ok('mssql_sa_enabled', 'autenticacion', 'sa account', 'Disabled.'));
    }

    const noPolicy = logins.rows.filter((row) => row['is_policy_checked'] === false);
    if (noPolicy.length > 0) {
      findings.push({
        checkId: 'mssql_password_policy',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Logins exempt from the password policy',
        detail: `${noPolicy.length} login(s) have CHECK_POLICY off, so they accept any password no matter how weak: ${noPolicy
          .map((row) => String(row['name']))
          .join(', ')}.`,
        remediation: 'alter login … with check_policy = on;',
        evidence: { logins: noPolicy.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_password_policy', 'autenticacion', 'Password policy', 'Every login enforces it.'));
    }

    const noExpiry = logins.rows.filter(
      (row) => row['is_expiration_checked'] === false && row['is_disabled'] !== true,
    );
    if (noExpiry.length > 0) {
      findings.push({
        checkId: 'mssql_password_expiration',
        category: 'autenticacion',
        severity: 'media',
        title: 'Passwords that never expire',
        detail: `${noExpiry.length} active login(s) have CHECK_EXPIRATION off: ${noExpiry
          .map((row) => String(row['name']))
          .join(', ')}. A leaked credential works forever.`,
        remediation: 'alter login … with check_expiration = on; and agree a rotation.',
        evidence: { logins: noExpiry.map((row) => row['name']) },
      });
    }
  }

  // ------------------------------------------------- contraseñas conocidas
  const comparisons = WEAK_PASSWORDS.map((password) =>
    password === null
      ? 'PWDCOMPARE(name, password_hash) = 1'
      : `PWDCOMPARE('${password.replace(/'/g, "''")}', password_hash) = 1`,
  ).join(' or ');

  const weak = await tryQuery(
    client,
    `select name, is_disabled from sys.sql_logins where ${comparisons}`,
  );

  if (weak.error) {
    findings.push(
      unverifiable(
        'mssql_weak_passwords',
        'autenticacion',
        'Known passwords',
        'Requires CONTROL SERVER or membership in securityadmin to read password_hash from sys.sql_logins.',
        weak.error,
      ),
    );
  } else if (weak.rows.length > 0) {
    const active = weak.rows.filter((row) => row['is_disabled'] !== true);
    findings.push({
      checkId: 'mssql_weak_passwords',
      category: 'autenticacion',
      severity: active.length > 0 ? 'critica' : 'media',
      title: 'Logins with a dictionary password',
      detail: `${weak.rows.length} login(s) use a password from a list of twelve trivial values${
        active.length < weak.rows.length ? ' (some disabled)' : ''
      }: ${weak.rows.map((row) => String(row['name'])).join(', ')}. The check uses PWDCOMPARE, which compares the hash without attempting a login.`,
      remediation: 'Change those passwords now and turn CHECK_POLICY on for the affected logins.',
      evidence: { logins: weak.rows.map((row) => row['name']) },
    });
  } else {
    findings.push(
      ok(
        'mssql_weak_passwords',
        'autenticacion',
        'Known passwords',
        'No login matches the twelve trivial passwords that were tested (blank, the login name, password, Password1, sa, 123456, and similar).',
      ),
    );
  }

  // ------------------------------------------------------- modo y cifrado
  const props = await tryQuery(
    client,
    `select serverproperty('IsIntegratedSecurityOnly') as solo_windows,
            serverproperty('IsHadrEnabled') as hadr`,
  );
  if (!props.error && Number(props.rows[0]?.['solo_windows'] ?? 0) === 0) {
    findings.push({
      checkId: 'mssql_mixed_auth',
      category: 'autenticacion',
      severity: 'baja',
      title: 'Mixed authentication is enabled',
      detail:
        'The server accepts SQL Server logins as well as Windows logins. That is not a failure, but each SQL login is a password that must be rotated and watched on its own, outside directory policy.',
      remediation: 'If every client can use integrated authentication, switch the mode to Windows only.',
      evidence: {},
    });
  }

  const databases = await tryQuery(
    client,
    `select name, database_id, is_encrypted, is_trustworthy_on, is_db_chaining_on, state_desc
       from sys.databases`,
  );

  if (databases.error) {
    findings.push(
      unverifiable('mssql_tde', 'cifrado', 'Encryption at rest', 'Requires read access to sys.databases.', databases.error),
    );
  } else {
    const userDbs = databases.rows.filter((row) => Number(row['database_id']) > 4);
    const unencrypted = userDbs.filter((row) => row['is_encrypted'] !== true);

    if (userDbs.length === 0) {
      findings.push(ok('mssql_tde', 'cifrado', 'Encryption at rest', 'No user databases to evaluate.'));
    } else if (unencrypted.length > 0) {
      findings.push({
        checkId: 'mssql_tde',
        category: 'cifrado',
        severity: 'media',
        title: 'Databases without encryption at rest',
        detail: `${unencrypted.length} of ${userDbs.length} user database(s) do not have TDE: ${unencrypted
          .map((row) => String(row['name']))
          .join(', ')}. Anyone who obtains the .mdf files or a backup can read them in full.`,
        remediation:
          'Enable Transparent Data Encryption, and store the master-key backup somewhere other than the database backups.',
        evidence: { bases: unencrypted.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_tde', 'cifrado', 'Encryption at rest', 'Every user database has TDE.'));
    }

    // TRUSTWORTHY en msdb viene activado de fábrica; en una base de usuario es
    // una vía conocida de escalada a sysadmin.
    const trustworthy = userDbs.filter((row) => row['is_trustworthy_on'] === true);
    if (trustworthy.length > 0) {
      findings.push({
        checkId: 'mssql_trustworthy',
        category: 'privilegios',
        severity: 'alta',
        title: 'User databases with TRUSTWORTHY on',
        detail: `${trustworthy.map((row) => String(row['name'])).join(', ')} have TRUSTWORTHY ON. Combined with a sysadmin owner, this is a known privilege-escalation path: anyone who can create a procedure in that database can reach sysadmin.`,
        remediation: 'alter database … set trustworthy off; and use certificate module signing if cross-database access is required.',
        evidence: { bases: trustworthy.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_trustworthy', 'privilegios', 'TRUSTWORTHY', 'No user database has it enabled.'));
    }
  }

  const connections = await tryQuery(
    client,
    `select encrypt_option, count(*) as total from sys.dm_exec_connections group by encrypt_option`,
  );
  if (!connections.error) {
    const plain = connections.rows.find((row) => String(row['encrypt_option']).toUpperCase() === 'FALSE');
    const total = connections.rows.reduce((sum, row) => sum + Number(row['total'] ?? 0), 0);
    if (plain) {
      findings.push({
        checkId: 'mssql_unencrypted_connections',
        category: 'cifrado',
        severity: 'alta',
        title: 'Connections are unencrypted right now',
        detail: `${plain['total']} of ${total} active connection(s) are not encrypted. This is not a theoretical setting: these are live sessions sending data and credentials in clear text.`,
        remediation:
          'Turn on Force Encryption in the server network configuration and confirm clients use Encrypt=true with certificate validation.',
        evidence: { conexiones: connections.rows },
      });
    } else if (total > 0) {
      findings.push(ok('mssql_unencrypted_connections', 'cifrado', 'Encrypted connections', `All ${total} active connections are encrypted.`));
    }
  }

  // Force Encryption vive en el registro de Windows y sys.dm_server_registry
  // está vacío en Linux: acá no se puede afirmar nada, y por eso no se afirma.
  const registry = await tryQuery(
    client,
    `select value_data from sys.dm_server_registry where value_name like '%ForceEncryption%'`,
  );
  if (registry.error || registry.rows.length === 0) {
    findings.push({
      checkId: 'mssql_force_encryption',
      category: 'cifrado',
      severity: 'no_verificable',
      title: 'Protocol encryption required',
      detail:
        'ForceEncryption could not be read: sys.dm_server_registry only returns data on Windows installs. On Linux this option is set with mssql-conf and is not exposed over T-SQL.',
      remediation: 'On Linux, check by hand: mssql-conf get network.forceencryption',
      evidence: {},
    });
  } else {
    const forced = String(registry.rows[0]?.['value_data'] ?? '0') === '1';
    findings.push(
      forced
        ? ok('mssql_force_encryption', 'cifrado', 'Encryption required', 'ForceEncryption is on.')
        : {
            checkId: 'mssql_force_encryption',
            category: 'cifrado',
            severity: 'alta',
            title: 'Encryption is not required',
            detail: 'ForceEncryption is off: the client decides whether to encrypt, and many do not by default.',
            remediation: 'Turn on Force Encryption in SQL Server Configuration Manager.',
            evidence: {},
          },
    );
  }

  // ------------------------------------------------------------- superficie
  const configurations = await tryQuery(
    client,
    `select name, cast(value_in_use as int) as valor from sys.configurations`,
  );
  if (!configurations.error) {
    const enabled = configurations.rows.filter(
      (row) => SURFACE_AREA[String(row['name'])] && Number(row['valor'] ?? 0) === 1,
    );
    if (enabled.length > 0) {
      const worst = enabled.some((row) => SURFACE_AREA[String(row['name'])]?.severity === 'alta');
      findings.push({
        checkId: 'mssql_surface_area',
        category: 'superficie',
        severity: worst ? 'alta' : 'media',
        title: 'Dangerous options enabled',
        detail: enabled
          .map((row) => `${row['name']} (${SURFACE_AREA[String(row['name'])]?.why})`)
          .join('; '),
        remediation:
          "Disable what is unused: exec sp_configure '<option>', 0; reconfigure with override;",
        evidence: { opciones: enabled.map((row) => row['name']) },
      });
    } else {
      findings.push(
        ok('mssql_surface_area', 'superficie', 'Dangerous options', 'xp_cmdshell, CLR, OLE Automation, and ad hoc distributed queries are disabled.'),
      );
    }
  }

  // -------------------------------------------------------------- auditoría
  const audits = await tryQuery(
    client,
    `select a.name, a.is_state_enabled, a.type_desc from sys.server_audits a`,
  );
  if (audits.error) {
    findings.push(
      unverifiable('mssql_audit', 'auditoria', 'Server audit', 'Requires VIEW ANY DEFINITION.', audits.error),
    );
  } else {
    const active = audits.rows.filter((row) => row['is_state_enabled'] === true);
    if (active.length === 0) {
      findings.push({
        checkId: 'mssql_audit',
        category: 'auditoria',
        severity: 'media',
        title: 'No audit configured',
        detail:
          audits.rows.length === 0
            ? 'No SQL Server Audit specification exists. There is no record of access or permission changes.'
            : `${audits.rows.length} audit(s) are defined but none are enabled.`,
        remediation:
          'Create a server audit with at least the failed-login and permission-change action groups, and enable it.',
        evidence: { definidas: audits.rows.length },
      });
    } else {
      findings.push(ok('mssql_audit', 'auditoria', 'Server audit', `${active.length} audit(s) enabled.`));
    }
  }

  const certificates = await tryQuery(
    client,
    `select name, expiry_date from sys.certificates
      where name not like '##%' and expiry_date < dateadd(day, 90, getdate())`,
  );
  if (!certificates.error && certificates.rows.length > 0) {
    findings.push({
      checkId: 'mssql_cert_expiry',
      category: 'cifrado',
      severity: 'media',
      title: 'Certificates expiring soon',
      detail: certificates.rows
        .map((row) => `${row['name']} expires on ${String(row['expiry_date']).slice(0, 10)}`)
        .join('; '),
      remediation: 'Renew the certificate before it expires; if it backs TDE, plan the key rotation.',
      evidence: { certificados: certificates.rows },
    });
  }

  const serverRoles = await tryQuery(
    client,
    `select r.name as role, m.name as member
       from sys.server_role_members srm
       join sys.server_principals r on r.principal_id = srm.role_principal_id
       join sys.server_principals m on m.principal_id = srm.member_principal_id`,
  );
  if (!serverRoles.error) {
    const byName = new Map<string, SecurityPrincipal>();
    for (const principal of principals) byName.set(principal.name, principal);

    for (const row of serverRoles.rows) {
      const role = String(row['role']);
      const member = String(row['member']);
      const memberPrincipal = byName.get(member);
      if (memberPrincipal) {
        memberPrincipal.detail ??= {};
        memberPrincipal.detail.memberOf ??= [];
        if (!memberPrincipal.detail.memberOf.includes(role)) memberPrincipal.detail.memberOf.push(role);
      }
      const rolePrincipal = byName.get(role);
      if (rolePrincipal) {
        rolePrincipal.detail ??= {};
        rolePrincipal.detail.members ??= [];
        if (!rolePrincipal.detail.members.includes(member)) rolePrincipal.detail.members.push(member);
      }
    }
  }

  const { score, verified, total } = securityScore(findings);
  return { engine: 'mssql', findings, principals, score, verified, total };
}
