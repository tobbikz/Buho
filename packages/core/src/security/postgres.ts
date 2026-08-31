import type { EngineClient } from '../engine';
import { tagged } from '../tag';
import {
  ok,
  securityScore,
  unverifiable,
  type SecurityAudit,
  type SecurityFinding,
  type SecurityPrincipal,
} from './types';

/**
 * Cada bloque privilegiado se envuelve para distinguir "está bien" de "no pude
 * mirar". Ver el comentario de `unverifiable` en types.ts: es la decisión
 * central del módulo.
 */
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

export async function auditPostgres(client: EngineClient): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];
  const principals: SecurityPrincipal[] = [];

  // ------------------------------------------------------- reglas de acceso
  // pg_hba_file_rules es lo primero porque manda sobre todo lo demás: da igual
  // qué tan fuerte sea el cifrado de contraseñas si una línea dice `trust`.
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
        'Reglas de autenticación (pg_hba.conf)',
        'Requiere superusuario o pertenencia a un rol con acceso a pg_hba_file_rules: grant pg_read_all_settings, o conceder select sobre la vista.',
        hba.error,
      ),
    );
  } else {
    const rules = hba.rows.map((row) => ({
      line: Number(row['line_number']),
      type: String(row['type'] ?? ''),
      database: (row['database'] as string[] | null)?.join(',') ?? 'all',
      user: (row['user_name'] as string[] | null)?.join(',') ?? 'all',
      address: (row['address'] as string | null) ?? 'socket local',
      method: String(row['auth_method'] ?? ''),
    }));

    const trust = rules.filter((rule) => rule.method === 'trust');
    if (trust.length > 0) {
      findings.push({
        checkId: 'pg_hba_trust',
        category: 'autenticacion',
        severity: 'critica',
        title: 'Autenticación trust: se entra sin contraseña',
        detail: `${trust.length} regla(s) de pg_hba.conf usan el método trust, que acepta la conexión sin pedir contraseña: ${trust
          .map((rule) => `línea ${rule.line} (${rule.type} ${rule.database} ${rule.user} desde ${rule.address})`)
          .join('; ')}. Cualquiera que alcance ese origen entra como el usuario que pida, incluido un superusuario.`,
        remediation:
          'Cambiar trust por scram-sha-256 en pg_hba.conf y recargar la configuración con pg_reload_conf(). Para el socket local de mantenimiento, peer es una alternativa razonable.',
        evidence: { rules: trust },
      });
    }

    // md5 sobre la red: el hash es interceptable y reutilizable. password es
    // texto plano y ya casi no se ve, pero cuando aparece es lo más grave.
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
          ? 'Contraseñas en texto plano sobre la red'
          : 'Autenticación md5 sobre la red',
        detail: `${weak.length} regla(s) aceptan conexiones de red con ${
          cleartext ? 'password (texto plano)' : 'md5'
        }: ${weak.map((rule) => `línea ${rule.line} desde ${rule.address}`).join('; ')}.`,
        remediation:
          'Migrar a scram-sha-256: poner password_encryption = scram-sha-256, hacer que cada usuario vuelva a establecer su contraseña y luego cambiar el método en pg_hba.conf.',
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
        title: 'Reglas abiertas a cualquier origen',
        detail: `${open.length} regla(s) aceptan conexiones desde cualquier dirección: ${open
          .map((rule) => `línea ${rule.line} (${rule.method})`)
          .join('; ')}.`,
        remediation:
          'Restringir el rango a las redes que realmente necesitan conectarse. La base de datos casi nunca debería ser alcanzable desde 0.0.0.0/0.',
        evidence: { rules: open },
      });
    }

    if (trust.length === 0 && weak.length === 0 && open.length === 0) {
      findings.push(
        ok('pg_hba', 'autenticacion', 'Reglas de autenticación', `${rules.length} reglas revisadas, sin trust ni md5 expuesto.`),
      );
    }
  }

  // --------------------------------------------------------- cifrado de red
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
      unverifiable('pg_settings_security', 'cifrado', 'Parámetros de seguridad', 'Requiere lectura de pg_settings.', settings.error),
    );
  } else {
    const ssl = setting('ssl');
    if (ssl !== 'on') {
      findings.push({
        checkId: 'pg_ssl_off',
        category: 'cifrado',
        severity: 'alta',
        title: 'TLS deshabilitado',
        detail:
          'ssl está en off: todo el tráfico —incluidas las contraseñas y los datos de las consultas— viaja sin cifrar. Cualquiera con acceso a la red puede leerlo.',
        remediation:
          'Generar certificado, poner ssl = on, reiniciar, y exigir cifrado en pg_hba.conf usando hostssl en lugar de host.',
        evidence: { ssl },
      });
    } else {
      findings.push(ok('pg_ssl_off', 'cifrado', 'TLS habilitado', `ssl = on, versión mínima ${setting('ssl_min_protocol_version') || 'no definida'}.`));
    }

    const encryption = setting('password_encryption');
    if (encryption !== 'scram-sha-256') {
      findings.push({
        checkId: 'pg_password_encryption',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Cifrado de contraseñas débil',
        detail: `password_encryption = ${encryption}. El hash md5 de PostgreSQL es reutilizable: quien lo obtiene puede autenticarse sin conocer la contraseña.`,
        remediation:
          'Poner password_encryption = scram-sha-256 y pedir a cada usuario que vuelva a establecer su contraseña; el hash viejo no se convierte solo.',
        evidence: { password_encryption: encryption },
      });
    } else {
      findings.push(ok('pg_password_encryption', 'autenticacion', 'Cifrado de contraseñas', 'scram-sha-256.'));
    }

    // En PG18 log_connections pasó de booleano a lista de aspectos; vacío
    // significa que no se registra nada.
    const logConnections = setting('log_connections');
    const logsConnections = logConnections !== '' && logConnections !== 'off';
    if (!logsConnections) {
      findings.push({
        checkId: 'pg_connection_logging',
        category: 'auditoria',
        severity: 'media',
        title: 'Las conexiones no se registran',
        detail:
          'log_connections está desactivado. Sin ese registro no hay forma de saber después de un incidente quién se conectó, desde dónde y cuándo.',
        remediation:
          "Activar log_connections (en PG18 acepta una lista, por ejemplo 'authentication,authorization,connect') y log_disconnections = on.",
        evidence: { log_connections: logConnections, log_disconnections: setting('log_disconnections') },
      });
    } else {
      findings.push(ok('pg_connection_logging', 'auditoria', 'Registro de conexiones', `log_connections = ${logConnections}.`));
    }
  }

  // ------------------------------------------------------------ privilegios
  const roles = await tryQuery(
    client,
    // Se excluyen los roles predefinidos (pg_monitor, pg_read_all_data y
    // compañía): son idénticos en toda instalación, no pueden iniciar sesión y
    // llenarían la tabla de cuentas con quince filas sin información. Lo que
    // importaría de ellos es quién los tiene concedidos, que es otra pregunta.
    `select r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
            r.rolreplication, r.rolcanlogin, r.rolvaliduntil,
            r.rolname = current_user as es_buho
       from pg_roles r
      where r.rolname not like 'pg\\_%'
      order by r.rolsuper desc, r.rolname`,
  );

  if (roles.error) {
    findings.push(
      unverifiable('pg_privileges', 'privilegios', 'Roles privilegiados', 'Requiere lectura de pg_roles.', roles.error),
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
        kind: row['rolcanlogin'] === true ? 'login' : 'rol',
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
        title: 'Demasiados superusuarios',
        detail: `${superusers.length} roles con login son superusuarios: ${superusers
          .map((principal) => principal.name)
          .join(', ')}. Un superusuario puede leer y borrar cualquier cosa, y saltarse toda restricción de fila.`,
        remediation:
          'Dejar superusuario sólo donde es imprescindible. Para tareas concretas existen roles predefinidos: pg_monitor, pg_read_all_data, pg_write_all_data, pg_signal_backend.',
        evidence: { superusers: superusers.map((principal) => principal.name) },
      });
    } else {
      findings.push(
        ok('pg_superuser_sprawl', 'privilegios', 'Superusuarios', `${superusers.length} superusuario(s) con login.`),
      );
    }

    // Búho auditándose a sí mismo: si el colector entra como superusuario, el
    // riesgo lo introdujo esta herramienta y toca decirlo.
    const self = roles.rows.find((row) => row['es_buho'] === true);
    if (self?.['rolsuper'] === true) {
      findings.push({
        checkId: 'pg_monitor_is_superuser',
        category: 'privilegios',
        severity: 'media',
        title: 'Búho se conecta como superusuario',
        detail: `El usuario de monitoreo (${self['rolname']}) es superusuario. Búho sólo necesita lectura de estadísticas, así que este privilegio amplía la superficie de ataque sin darle nada a cambio.`,
        remediation:
          'Crear un rol dedicado y usarlo en el config: create role buho_monitor login password \'…\'; grant pg_monitor to buho_monitor;',
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
        title: 'Roles que ignoran la seguridad de filas',
        detail: `${bypass.length} rol(es) no superusuarios tienen BYPASSRLS: ${bypass
          .map((principal) => principal.name)
          .join(', ')}. Las políticas de row level security no les aplican.`,
        remediation: 'Quitar el atributo salvo que el rol exista precisamente para saltarse RLS: alter role … nobypassrls;',
        evidence: { roles: bypass.map((principal) => principal.name) },
      });
    }
  }

  // -------------------------------------------- método de contraseña por rol
  const authid = await tryQuery(
    client,
    `select rolname,
            case when rolpassword is null then 'sin contraseña'
                 when rolpassword like 'SCRAM-SHA-256%' then 'scram-sha-256'
                 when rolpassword like 'md5%' then 'md5'
                 else 'otro' end as metodo
       from pg_authid
      where rolcanlogin`,
  );

  if (authid.error) {
    findings.push(
      unverifiable(
        'pg_password_hashes',
        'autenticacion',
        'Cifrado de las contraseñas existentes',
        'Requiere superusuario o pertenencia a pg_read_all_stats para leer pg_authid. Sin esto no se puede saber si quedan contraseñas en md5, aunque password_encryption ya sea scram.',
        authid.error,
      ),
    );
  } else {
    for (const row of authid.rows) {
      const principal = principals.find((candidate) => candidate.name === row['rolname']);
      if (principal) principal.authMethod = String(row['metodo']);
    }

    const md5 = authid.rows.filter((row) => row['metodo'] === 'md5');
    const nopass = authid.rows.filter((row) => row['metodo'] === 'sin contraseña');

    if (md5.length > 0) {
      findings.push({
        checkId: 'pg_md5_passwords',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Contraseñas guardadas en md5',
        detail: `${md5.length} rol(es) todavía tienen su contraseña en md5: ${md5
          .map((row) => String(row['rolname']))
          .join(', ')}. Cambiar password_encryption no reescribe los hashes viejos.`,
        remediation: 'Pedir a esos roles que vuelvan a establecer su contraseña con password_encryption ya en scram-sha-256.',
        evidence: { roles: md5.map((row) => row['rolname']) },
      });
    }

    if (nopass.length > 0) {
      findings.push({
        checkId: 'pg_no_password',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Roles con login y sin contraseña',
        detail: `${nopass.length} rol(es) pueden iniciar sesión y no tienen contraseña definida: ${nopass
          .map((row) => String(row['rolname']))
          .join(', ')}. Sólo los protege la regla de pg_hba.conf que les aplique; si esa regla es trust, no los protege nada.`,
        remediation: 'Asignar contraseña, o quitar el atributo LOGIN si el rol sólo agrupa permisos.',
        evidence: { roles: nopass.map((row) => row['rolname']) },
      });
    }

    if (md5.length === 0 && nopass.length === 0) {
      findings.push(
        ok('pg_md5_passwords', 'autenticacion', 'Contraseñas existentes', `${authid.rows.length} rol(es) con login, todos en scram-sha-256.`),
      );
    }
  }

  // ---------------------------------------------------------- acceso público
  const publicAccess = await tryQuery(
    client,
    `select n.nspname as esquema,
            has_schema_privilege('public', n.nspname, 'CREATE') as puede_crear
       from pg_namespace n
      where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'`,
  );

  if (publicAccess.error) {
    findings.push(
      unverifiable('pg_public_schema', 'acceso_publico', 'Permisos de PUBLIC', 'Requiere lectura del catálogo de esquemas.', publicAccess.error),
    );
  } else {
    const writable = publicAccess.rows.filter((row) => row['puede_crear'] === true);
    if (writable.length > 0) {
      findings.push({
        checkId: 'pg_public_schema_create',
        category: 'acceso_publico',
        severity: 'media',
        title: 'PUBLIC puede crear objetos',
        detail: `El rol PUBLIC —es decir, cualquier usuario— puede crear objetos en ${writable.length} esquema(s): ${writable
          .map((row) => String(row['esquema']))
          .join(', ')}. Es la vía del ataque de suplantación de funciones por search_path.`,
        remediation: 'revoke create on schema … from public; (en PostgreSQL 15 y posteriores ya es el valor por omisión para el esquema public)',
        evidence: { esquemas: writable.map((row) => row['esquema']) },
      });
    } else {
      findings.push(
        ok('pg_public_schema_create', 'acceso_publico', 'Permisos de PUBLIC', 'PUBLIC no puede crear objetos en ningún esquema.'),
      );
    }
  }

  // ------------------------------------------------------ superficie y auditoría
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
        title: 'Extensiones que amplían la superficie de ataque',
        detail: `Instaladas: ${risky.join(', ')}. Los lenguajes sin restricciones (plpythonu, plperlu) ejecutan código arbitrario en el servidor, y las de acceso remoto (dblink, postgres_fdw) permiten alcanzar otros sistemas con la identidad del servidor.`,
        remediation:
          'Quitar las que no se usen. Para las necesarias, restringir quién puede ejecutarlas: revoke execute … from public y conceder sólo a los roles que las requieren.',
        evidence: { extensiones: risky },
      });
    } else {
      findings.push(ok('pg_risky_extensions', 'superficie', 'Extensiones sensibles', 'Ninguna instalada.'));
    }

    if (!installed.includes('pgaudit')) {
      findings.push({
        checkId: 'pg_pgaudit',
        category: 'auditoria',
        severity: 'baja',
        title: 'Sin auditoría detallada',
        detail:
          'pgaudit no está instalado. El registro nativo puede decir qué sentencias corrieron, pero no da la pista de auditoría por objeto y por rol que suelen pedir las certificaciones.',
        remediation: 'Instalar pgaudit y agregarlo a shared_preload_libraries si hay un requisito de cumplimiento que lo exija.',
        evidence: {},
      });
    } else {
      findings.push(ok('pg_pgaudit', 'auditoria', 'Auditoría detallada', 'pgaudit instalado.'));
    }
  }

  const { score, verified, total } = securityScore(findings);
  return { engine: 'postgres', findings, principals, score, verified, total };
}
