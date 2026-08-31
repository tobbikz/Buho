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
        'Cuentas y método de autenticación',
        'Requiere SELECT sobre la tabla mysql.user: grant select on mysql.user to \'buho_monitor\'@\'…\'. Sin esto no se puede detectar cuentas sin contraseña ni hashes débiles.',
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
        name: user || '(anónimo)',
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
        title: 'Cuentas activas sin contraseña',
        detail: `${blank.length} cuenta(s) pueden iniciar sesión sin contraseña: ${blank.join(', ')}.`,
        remediation: "Asignar contraseña con ALTER USER … IDENTIFIED VIA ed25519 USING PASSWORD('…'), o bloquear la cuenta con ACCOUNT LOCK.",
        evidence: { cuentas: blank },
      });
    } else {
      findings.push(ok('maria_blank_password', 'autenticacion', 'Cuentas sin contraseña', 'Ninguna cuenta activa sin contraseña.'));
    }

    if (anonymous.length > 0) {
      findings.push({
        checkId: 'maria_anonymous',
        category: 'acceso_publico',
        severity: 'critica',
        title: 'Usuario anónimo habilitado',
        detail: `Existe la cuenta anónima ${anonymous.join(', ')}: permite conectar sin nombre de usuario.`,
        remediation: "drop user ''@'localhost'; — o ejecutar mariadb-secure-installation.",
        evidence: { cuentas: anonymous },
      });
    }

    if (wideOpen.length > 0) {
      findings.push({
        checkId: 'maria_super_any_host',
        category: 'privilegios',
        severity: 'critica',
        title: 'Cuenta con SUPER alcanzable desde cualquier host',
        detail: `${wideOpen.join(', ')} ${wideOpen.length === 1 ? 'tiene' : 'tienen'} el privilegio SUPER y su host es '%', es decir cualquier origen. Con SUPER se puede apagar el servidor, cambiar cualquier variable y leer todo.`,
        remediation:
          "Limitar el host a las redes que lo necesitan: rename user 'root'@'%' to 'root'@'10.0.0.%'; y dejar el acceso administrativo por socket local.",
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
            ? 'Hash de contraseña previo a MySQL 4.1'
            : `Plugin de autenticación débil: ${plugin || 'sin definir'}`,
        detail:
          plugin === 'mysql_old_password'
            ? `${accounts.length} cuenta(s) usan mysql_old_password, un hash de 16 bytes roto desde hace dos décadas: ${accounts.join(', ')}.`
            : `${accounts.length} cuenta(s) usan ${plugin}, que es SHA1 doble sin sal: dos cuentas con la misma contraseña producen el mismo hash y se atacan con tablas precalculadas. Cuentas: ${accounts.join(', ')}.`,
        remediation: "Migrar a ed25519: alter user … identified via ed25519 using password('…');",
        evidence: { plugin, cuentas: accounts },
      });
    }

    const sslUsers = users.rows.filter((row) => String(row['ssl_type'] ?? '') !== '');
    if (sslUsers.length === 0 && users.rows.length > 0) {
      findings.push({
        checkId: 'maria_user_ssl',
        category: 'cifrado',
        severity: 'media',
        title: 'Ninguna cuenta exige TLS',
        detail:
          'Ninguna cuenta tiene REQUIRE SSL ni REQUIRE X509, así que todas pueden conectarse en claro aunque el servidor soporte TLS.',
        remediation: "alter user … require ssl; para las cuentas que entran por red.",
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
      unverifiable('maria_variables', 'cifrado', 'Variables de seguridad', 'Requiere lectura de variables globales.', vars.error),
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
        title: 'El servidor no tiene TLS disponible',
        detail: 'have_ssl no es YES: no hay certificado configurado, así que ninguna conexión puede cifrarse.',
        remediation: 'Configurar ssl_cert, ssl_key y ssl_ca en el archivo de configuración y reiniciar.',
        evidence: { have_ssl: row['have_ssl'] },
      });
    } else if (!requireSsl) {
      findings.push({
        checkId: 'maria_tls_not_required',
        category: 'cifrado',
        severity: 'alta',
        title: 'TLS disponible pero no obligatorio',
        detail:
          'El servidor soporta TLS pero require_secure_transport = 0: un cliente puede conectarse en claro y las credenciales viajan expuestas. Tener el certificado instalado no protege nada por sí solo.',
        remediation: 'Poner require_secure_transport = ON, tras verificar que todos los clientes soportan TLS.',
        evidence: { require_secure_transport: 0 },
      });
    } else {
      findings.push(ok('maria_tls_not_required', 'cifrado', 'TLS obligatorio', 'require_secure_transport = ON.'));
    }

    // NULL desactiva por completo la importación y exportación de archivos, así
    // que es el valor **seguro**. La cadena vacía es la peligrosa: sin
    // restricción de directorio. Confundir los dos es un error clásico.
    const secureFilePriv = row['secure_file_priv'];
    if (secureFilePriv === null || secureFilePriv === undefined) {
      findings.push(
        ok('maria_secure_file_priv', 'superficie', 'Importación de archivos', 'secure_file_priv es NULL: LOAD DATA INFILE y SELECT … INTO OUTFILE están deshabilitados.'),
      );
    } else if (String(secureFilePriv) === '') {
      findings.push({
        checkId: 'maria_secure_file_priv',
        category: 'superficie',
        severity: 'alta',
        title: 'Lectura y escritura de archivos sin restricción',
        detail:
          'secure_file_priv está vacío: cualquier cuenta con el privilegio FILE puede leer y escribir archivos en cualquier ruta del servidor, incluido /etc/passwd o las claves SSH.',
        remediation: 'Poner secure_file_priv = NULL para deshabilitarlo, o apuntarlo a un directorio dedicado.',
        evidence: { secure_file_priv: '' },
      });
    } else {
      findings.push(
        ok('maria_secure_file_priv', 'superficie', 'Importación de archivos', `Restringida a ${secureFilePriv}.`),
      );
    }

    if (String(row['local_infile'] ?? '0') === '1') {
      findings.push({
        checkId: 'maria_local_infile',
        category: 'superficie',
        severity: 'media',
        title: 'LOAD DATA LOCAL INFILE habilitado',
        detail:
          'local_infile = 1. Un servidor malicioso (o uno suplantado) puede pedirle al cliente que le envíe cualquier archivo local al que ese cliente tenga acceso.',
        remediation: 'Poner local_infile = 0 salvo que algún proceso de carga lo necesite de verdad.',
        evidence: { local_infile: 1 },
      });
    } else {
      findings.push(ok('maria_local_infile', 'superficie', 'LOAD DATA LOCAL INFILE', 'Deshabilitado.'));
    }

    if (String(row['general_log'] ?? '0') === '1') {
      findings.push({
        checkId: 'maria_general_log',
        category: 'auditoria',
        severity: 'media',
        title: 'El registro general está activo',
        detail:
          'general_log = 1 escribe todas las sentencias, incluidas las que contienen contraseñas en texto plano de sentencias como CREATE USER. Además cuesta rendimiento.',
        remediation: 'Apagar general_log y usar el plugin server_audit, que filtra y rota de forma pensada para auditoría.',
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
        title: 'Sin plugin de auditoría',
        detail:
          'server_audit no está activo: no hay registro de quién se conectó ni qué ejecutó. Después de un incidente no habrá nada que revisar.',
        remediation: "install plugin server_audit soname 'server_audit'; y configurar server_audit_events y la rotación.",
        evidence: {},
      });
    } else {
      findings.push(ok('maria_audit_plugin', 'auditoria', 'Plugin de auditoría', 'Activo.'));
    }

    if (!hasValidation) {
      findings.push({
        checkId: 'maria_password_validation',
        category: 'autenticacion',
        severity: 'baja',
        title: 'Sin validación de contraseñas',
        detail:
          'No hay plugin de validación activo: nada impide crear una cuenta con la contraseña "123456".',
        remediation: "install soname 'simple_password_check'; y ajustar su longitud mínima y variedad de caracteres.",
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
      title: 'La base de datos "test" existe',
      detail:
        'La base test viene de las instalaciones antiguas y tradicionalmente es accesible por cualquier cuenta.',
      remediation: 'drop database test;',
      evidence: {},
    });
  }

  const { score, verified, total } = securityScore(findings);
  return { engine: 'mariadb', findings, principals, score, verified, total };
}
