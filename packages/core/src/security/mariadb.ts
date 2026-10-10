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
 * Plugins de autenticación, de peor a mejor.
 *
 * `mysql_old_password` es el hash previo a MySQL 4.1: 16 bytes y roto desde
 * hace dos décadas. `mysql_native_password` es SHA1 doble sin sal, así que dos
 * cuentas con la misma contraseña tienen el mismo hash y se ataca con tablas
 * precalculadas. `ed25519` es el bueno en MariaDB; `unix_socket` no usa
 * contraseña porque delega en el sistema operativo, y para cuentas locales de
 * mantenimiento es una opción sólida.
 */
const AUTH_RISK: Record<string, 'critica' | 'alta' | 'ok'> = {
  mysql_old_password: 'critica',
  mysql_native_password: 'alta',
  ed25519: 'ok',
  unix_socket: 'ok',
  gssapi: 'ok',
  '': 'alta',
};

export async function auditMariadb(client: EngineClient): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];
  const principals: SecurityPrincipal[] = [];

  // ------------------------------------------------------------- cuentas
  // `mysql.user` es una vista sobre `mysql.global_priv` desde MariaDB 10.4 y no
  // expone ni el bloqueo de la cuenta ni la fecha de la contraseña: esos dos
  // datos viven dentro del JSON de global_priv. Se piden aparte para que la
  // consulta principal siga funcionando en versiones donde global_priv no
  // existe.
  const users = await tryQuery(
    client,
    // Los alias en minúscula no son cosmética: MariaDB devuelve los nombres de
    // columna con la capitalización de la definición (User, Super_priv), y sin
    // alias toda lectura por clave en minúscula sale undefined. Eso hacía que
    // cada cuenta pareciera anónima y sin privilegios.
    `select u.user as user_name, u.host as host_name, u.plugin as plugin,
            u.authentication_string as auth_string, u.password_expired as expired,
            u.is_role as is_role, u.ssl_type as ssl_type,
            u.super_priv as super_priv, u.file_priv as file_priv,
            u.process_priv as process_priv, u.shutdown_priv as shutdown_priv,
            u.create_user_priv as create_user_priv, u.grant_priv as grant_priv
       from mysql.user u
      order by u.super_priv desc, u.user`,
  );

  const extra = await tryQuery(
    client,
    `select user as user_name, host as host_name,
            json_value(priv, '$.account_locked') as account_locked,
            json_value(priv, '$.password_last_changed') as password_last_changed
       from mysql.global_priv`,
  );
  const detailOf = (user: string, host: string): { locked: boolean; changed: Date | null } => {
    const row = extra.rows.find(
      (candidate) =>
        String(candidate['user_name'] ?? '') === user && String(candidate['host_name'] ?? '') === host,
    );
    const epoch = Number(row?.['password_last_changed'] ?? 0);
    return {
      locked: String(row?.['account_locked'] ?? '0') === '1',
      changed: epoch > 0 ? new Date(epoch * 1000) : null,
    };
  };

  if (users.error) {
    findings.push(
      unverifiable(
        'maria_accounts',
        'autenticacion',
        'Accounts and authentication method',
        "Requires SELECT on mysql.user: grant select on mysql.user to 'buho_monitor'@'…'. Without it, blank passwords and weak hashes cannot be detected.",
        users.error,
      ),
    );
  } else {
    const blank: string[] = [];
    const anonymous: string[] = [];
    const wideOpen: string[] = [];
    const weakPlugins = new Map<string, string[]>();

    for (const row of users.rows) {
      const user = String(row['user_name'] ?? '');
      const host = String(row['host_name'] ?? '');
      const plugin = String(row['plugin'] ?? '');
      const label = `'${user}'@'${host}'`;
      const { locked, changed } = detailOf(user, host);
      const expired = String(row['expired'] ?? 'N') === 'Y';
      const isRole = String(row['is_role'] ?? 'N') === 'Y';
      const noPassword = String(row['auth_string'] ?? '') === '';
      const isSuper = String(row['super_priv'] ?? 'N') === 'Y';

      const privileges: string[] = [];
      for (const [column, name] of [
        ['super_priv', 'SUPER'],
        ['file_priv', 'FILE'],
        ['process_priv', 'PROCESS'],
        ['shutdown_priv', 'SHUTDOWN'],
        ['create_user_priv', 'CREATE USER'],
        ['grant_priv', 'GRANT OPTION'],
      ] as const) {
        if (String(row[column] ?? 'N') === 'Y') privileges.push(name);
      }

      principals.push({
        name: user || '(anonymous)',
        kind: isRole ? 'rol' : 'login',
        host,
        canLogin: !isRole && !locked,
        isSuperuser: isSuper,
        disabled: locked,
        authMethod: plugin || null,
        passwordSetAt: changed,
        privileges,
      });

      if (isRole) continue;

      // Una cuenta sin contraseña pero bloqueada o con la contraseña expirada
      // no puede iniciar sesión: es el caso de mariadb.sys, que viene así de
      // fábrica. Marcarla sería una falsa alarma que enseña a ignorar la
      // pantalla.
      if (noPassword && plugin !== 'unix_socket' && !locked && !expired) blank.push(label);
      if (user === '') anonymous.push(label);
      if (host === '%' && isSuper) wideOpen.push(label);

      const risk = AUTH_RISK[plugin] ?? 'alta';
      if (risk !== 'ok') {
        const list = weakPlugins.get(plugin) ?? [];
        list.push(label);
        weakPlugins.set(plugin, list);
      }
    }

    if (blank.length > 0) {
      findings.push({
        checkId: 'maria_blank_password',
        category: 'autenticacion',
        severity: 'critica',
        title: 'Active accounts with no password',
        detail: `${blank.length} account(s) can sign in with no password: ${blank.join(', ')}.`,
        remediation: "Set a password with ALTER USER … IDENTIFIED VIA ed25519 USING PASSWORD('…'), or lock the account with ACCOUNT LOCK.",
        evidence: { cuentas: blank },
      });
    } else {
      findings.push(ok('maria_blank_password', 'autenticacion', 'Accounts with no password', 'No active account has an empty password.'));
    }

    if (anonymous.length > 0) {
      findings.push({
        checkId: 'maria_anonymous',
        category: 'acceso_publico',
        severity: 'critica',
        title: 'Anonymous account enabled',
        detail: `Anonymous account ${anonymous.join(', ')} exists: it allows a connection with no user name.`,
        remediation: "drop user ''@'localhost'; — o ejecutar mariadb-secure-installation.",
        evidence: { cuentas: anonymous },
      });
    }

    if (wideOpen.length > 0) {
      findings.push({
        checkId: 'maria_super_any_host',
        category: 'privilegios',
        severity: 'critica',
        title: 'SUPER account reachable from any host',
        detail: `${wideOpen.join(', ')} ${wideOpen.length === 1 ? 'has' : 'have'} the SUPER privilege and host '%', so any origin can connect. SUPER can shut the server down, change any variable, and read everything.`,
        remediation:
          "Limit the host to the networks that need it: rename user 'root'@'%' to 'root'@'10.0.0.%'; and keep administrative access on the local socket.",
        evidence: { cuentas: wideOpen },
      });
    }

    for (const [plugin, accounts] of weakPlugins) {
      findings.push({
        checkId: `maria_auth_plugin_${plugin || 'vacio'}`,
        category: 'autenticacion',
        severity: AUTH_RISK[plugin] === 'critica' ? 'critica' : 'alta',
        title:
          plugin === 'mysql_old_password'
            ? 'Password hash from before MySQL 4.1'
            : `Weak authentication plugin: ${plugin || 'unset'}`,
        detail:
          plugin === 'mysql_old_password'
            ? `${accounts.length} account(s) use mysql_old_password, a 16-byte hash broken for two decades: ${accounts.join(', ')}.`
            : `${accounts.length} account(s) use ${plugin}, which is unsalted double SHA1: two accounts with the same password share a hash and can be attacked with precomputed tables. Accounts: ${accounts.join(', ')}.`,
        remediation: "Move to ed25519: alter user … identified via ed25519 using password('…');",
        evidence: { plugin, cuentas: accounts },
      });
    }

    const sslUsers = users.rows.filter((row) => String(row['ssl_type'] ?? '') !== '');
    if (sslUsers.length === 0 && users.rows.length > 0) {
      findings.push({
        checkId: 'maria_user_ssl',
        category: 'cifrado',
        severity: 'media',
        title: 'No account requires TLS',
        detail:
          'No account has REQUIRE SSL or REQUIRE X509, so every account can connect in clear text even when the server supports TLS.',
        remediation: 'alter user … require ssl; for accounts that connect over the network.',
        evidence: {},
      });
    }
  }

  // -------------------------------------------------- cifrado y superficie
  const vars = await tryQuery(
    client,
    `select @@require_secure_transport as require_ssl, @@have_ssl as have_ssl,
            @@local_infile as local_infile, @@secure_file_priv as secure_file_priv,
            @@general_log as general_log, @@log_warnings as log_warnings,
            @@default_password_lifetime as password_lifetime`,
  );

  if (vars.error) {
    findings.push(
      unverifiable('maria_variables', 'cifrado', 'Security variables', 'Requires permission to read global variables.', vars.error),
    );
  } else {
    const row = vars.rows[0] ?? {};
    const requireSsl = String(row['require_ssl'] ?? '0') === '1';
    const haveSsl = String(row['have_ssl'] ?? '').toUpperCase() === 'YES';

    if (!haveSsl) {
      findings.push({
        checkId: 'maria_no_tls',
        category: 'cifrado',
        severity: 'alta',
        title: 'TLS is not available on the server',
        detail: 'have_ssl is not YES: no certificate is configured, so no connection can be encrypted.',
        remediation: 'Set ssl_cert, ssl_key, and ssl_ca in the configuration file and restart.',
        evidence: { have_ssl: row['have_ssl'] },
      });
    } else if (!requireSsl) {
      findings.push({
        checkId: 'maria_tls_not_required',
        category: 'cifrado',
        severity: 'alta',
        title: 'TLS is available but not required',
        detail:
          'The server supports TLS but require_secure_transport = 0: a client can connect in clear text and credentials travel exposed. Installing a certificate does not protect anything by itself.',
        remediation: 'Set require_secure_transport = ON after confirming every client supports TLS.',
        evidence: { require_secure_transport: 0 },
      });
    } else {
      findings.push(ok('maria_tls_not_required', 'cifrado', 'TLS required', 'require_secure_transport = ON.'));
    }

    // NULL desactiva por completo la importación y exportación de archivos, así
    // que es el valor **seguro**. La cadena vacía es la peligrosa: sin
    // restricción de directorio. Confundir los dos es un error clásico.
    const secureFilePriv = row['secure_file_priv'];
    if (secureFilePriv === null || secureFilePriv === undefined) {
      findings.push(
        ok('maria_secure_file_priv', 'superficie', 'File import', 'secure_file_priv is NULL: LOAD DATA INFILE and SELECT … INTO OUTFILE are disabled.'),
      );
    } else if (String(secureFilePriv) === '') {
      findings.push({
        checkId: 'maria_secure_file_priv',
        category: 'superficie',
        severity: 'alta',
        title: 'Unrestricted file read and write',
        detail:
          'secure_file_priv is empty: any account with the FILE privilege can read and write files anywhere on the server, including /etc/passwd or SSH keys.',
        remediation: 'Set secure_file_priv = NULL to disable it, or point it at a dedicated directory.',
        evidence: { secure_file_priv: '' },
      });
    } else {
      findings.push(
        ok('maria_secure_file_priv', 'superficie', 'File import', `Restricted to ${secureFilePriv}.`),
      );
    }

    if (String(row['local_infile'] ?? '0') === '1') {
      findings.push({
        checkId: 'maria_local_infile',
        category: 'superficie',
        severity: 'media',
        title: 'LOAD DATA LOCAL INFILE enabled',
        detail:
          'local_infile = 1. A malicious or impersonated server can ask the client to send any local file that client can read.',
        remediation: 'Set local_infile = 0 unless a load job truly needs it.',
        evidence: { local_infile: 1 },
      });
    } else {
      findings.push(ok('maria_local_infile', 'superficie', 'LOAD DATA LOCAL INFILE', 'Disabled.'));
    }

    if (String(row['general_log'] ?? '0') === '1') {
      findings.push({
        checkId: 'maria_general_log',
        category: 'auditoria',
        severity: 'media',
        title: 'The general log is on',
        detail:
          'general_log = 1 writes every statement, including passwords in clear text from statements such as CREATE USER. It also costs performance.',
        remediation: 'Turn general_log off and use the server_audit plugin, which filters and rotates for audit.',
        evidence: { general_log: 1 },
      });
    }
  }

  // ------------------------------------------------------------- auditoría
  const plugins = await tryQuery(
    client,
    `select plugin_name, plugin_status, plugin_type from information_schema.plugins
      where plugin_type in ('AUDIT', 'PASSWORD VALIDATION')
         or plugin_name like '%audit%' or plugin_name like '%password_check%'`,
  );

  if (!plugins.error) {
    const active = plugins.rows.filter((row) => String(row['plugin_status']).toUpperCase() === 'ACTIVE');
    const hasAudit = active.some((row) => String(row['plugin_name']).toLowerCase().includes('audit'));
    const hasValidation = active.some(
      (row) =>
        String(row['plugin_type']).toUpperCase() === 'PASSWORD VALIDATION' ||
        String(row['plugin_name']).toLowerCase().includes('password_check'),
    );

    if (!hasAudit) {
      findings.push({
        checkId: 'maria_audit_plugin',
        category: 'auditoria',
        severity: 'media',
        title: 'No audit plugin',
        detail:
          'server_audit is not active: there is no record of who connected or what they ran. After an incident there will be nothing to review.',
        remediation: "install plugin server_audit soname 'server_audit'; and set server_audit_events and rotation.",
        evidence: {},
      });
    } else {
      findings.push(ok('maria_audit_plugin', 'auditoria', 'Audit plugin', 'Active.'));
    }

    if (!hasValidation) {
      findings.push({
        checkId: 'maria_password_validation',
        category: 'autenticacion',
        severity: 'baja',
        title: 'No password validation',
        detail: 'No validation plugin is active: nothing stops an account from being created with the password "123456".',
        remediation: "install soname 'simple_password_check'; and set its minimum length and character variety.",
        evidence: {},
      });
    }
  }

  const schemas = await tryQuery(
    client,
    `select schema_name from information_schema.schemata where schema_name = 'test'`,
  );
  if (!schemas.error && schemas.rows.length > 0) {
    findings.push({
      checkId: 'maria_test_schema',
      category: 'acceso_publico',
      severity: 'baja',
      title: 'The "test" database exists',
      detail: 'The test database comes from old installs and has traditionally been reachable by any account.',
      remediation: 'drop database test;',
      evidence: {},
    });
  }

  const roleMap = await tryQuery(
    client,
    `select user as member, host as member_host, role as role_name, role_host
       from mysql.roles_mapping`,
  );
  if (!roleMap.error) {
    const byLabel = new Map(principals.map((principal) => [`'${principal.name}'@'${principal.host ?? ''}'`, principal]));
    for (const row of roleMap.rows) {
      const memberLabel = `'${String(row['member'])}'@'${String(row['member_host'] ?? '')}'`;
      const roleLabel = `'${String(row['role_name'])}'@'${String(row['role_host'] ?? '')}'`;
      const member = byLabel.get(memberLabel);
      if (member) {
        member.detail ??= {};
        member.detail.memberOf ??= [];
        if (!member.detail.memberOf.includes(roleLabel)) member.detail.memberOf.push(roleLabel);
      }
      const role = byLabel.get(roleLabel);
      if (role) {
        role.detail ??= {};
        role.detail.members ??= [];
        if (!role.detail.members.includes(memberLabel)) role.detail.members.push(memberLabel);
      }
    }
  }

  const { score, verified, total } = securityScore(findings);
  return { engine: 'mariadb', findings, principals, score, verified, total };
}
