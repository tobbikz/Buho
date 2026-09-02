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
    why: 'permite ejecutar comandos del sistema operativo con la cuenta del servicio de SQL Server',
  },
  'Ole Automation Procedures': {
    severity: 'alta',
    why: 'permite instanciar objetos COM y salir del motor',
  },
  'Ad Hoc Distributed Queries': {
    severity: 'media',
    why: 'permite abrir conexiones arbitrarias con OPENROWSET desde una consulta',
  },
  'clr enabled': { severity: 'media', why: 'ejecuta ensamblados .NET dentro del motor' },
  'Database Mail XPs': { severity: 'media', why: 'permite enviar correo, y con ello exfiltrar datos' },
  'cross db ownership chaining': {
    severity: 'media',
    why: 'extiende los permisos entre bases por cadena de propiedad y rompe el aislamiento',
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
        'Logins del servidor',
        'Requiere VIEW ANY DEFINITION o pertenencia a securityadmin. Sin esto no se ven los logins ni su política de contraseñas.',
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
        title: 'Los administradores del sistema son sysadmin',
        detail:
          'El grupo BUILTIN\\Administrators pertenece al rol sysadmin: cualquier administrador del servidor operativo tiene control total de SQL Server sin que nadie le haya concedido permisos en la base.',
        remediation:
          'Quitar el grupo del rol y conceder sysadmin a cuentas nominales: alter server role sysadmin drop member [BUILTIN\\Administrators];',
        evidence: { miembros: builtin.map((principal) => principal.name) },
      });
    }

    if (sysadmins.length > 3) {
      findings.push({
        checkId: 'mssql_sysadmin_sprawl',
        category: 'privilegios',
        severity: 'media',
        title: 'Demasiados sysadmin',
        detail: `${sysadmins.length} logins activos son sysadmin: ${sysadmins
          .map((principal) => principal.name)
          .join(', ')}.`,
        remediation: 'Revisar la lista y dejar sólo lo imprescindible; para tareas concretas existen roles como dbcreator, processadmin o diskadmin.',
        evidence: { sysadmins: sysadmins.map((principal) => principal.name) },
      });
    } else {
      findings.push(ok('mssql_sysadmin_sprawl', 'privilegios', 'Miembros de sysadmin', `${sysadmins.length} login(s).`));
    }

    const sa = logins.rows.find((row) => String(row['name']).toLowerCase() === 'sa');
    if (sa && sa['is_disabled'] !== true) {
      findings.push({
        checkId: 'mssql_sa_enabled',
        category: 'autenticacion',
        severity: 'alta',
        title: 'La cuenta sa está habilitada',
        detail:
          'sa está activa y con su nombre original. Es la primera cuenta que prueba cualquier ataque automatizado, y su nombre no se puede adivinar mal porque es idéntico en todas las instalaciones.',
        remediation:
          'Deshabilitarla si no se usa (alter login sa disable) o al menos renombrarla (alter login sa with name = …), dejando cuentas nominales para la administración.',
        evidence: { create_date: sa['create_date'] },
      });
    } else if (sa) {
      findings.push(ok('mssql_sa_enabled', 'autenticacion', 'Cuenta sa', 'Deshabilitada.'));
    }

    const noPolicy = logins.rows.filter((row) => row['is_policy_checked'] === false);
    if (noPolicy.length > 0) {
      findings.push({
        checkId: 'mssql_password_policy',
        category: 'autenticacion',
        severity: 'alta',
        title: 'Logins exentos de la política de contraseñas',
        detail: `${noPolicy.length} login(s) tienen CHECK_POLICY desactivado, así que aceptan cualquier contraseña por débil que sea: ${noPolicy
          .map((row) => String(row['name']))
          .join(', ')}.`,
        remediation: 'alter login … with check_policy = on;',
        evidence: { logins: noPolicy.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_password_policy', 'autenticacion', 'Política de contraseñas', 'Todos los logins la aplican.'));
    }

    const noExpiry = logins.rows.filter(
      (row) => row['is_expiration_checked'] === false && row['is_disabled'] !== true,
    );
    if (noExpiry.length > 0) {
      findings.push({
        checkId: 'mssql_password_expiration',
        category: 'autenticacion',
        severity: 'media',
        title: 'Contraseñas que nunca caducan',
        detail: `${noExpiry.length} login(s) activos tienen CHECK_EXPIRATION desactivado: ${noExpiry
          .map((row) => String(row['name']))
          .join(', ')}. Una credencial filtrada sirve para siempre.`,
        remediation: 'alter login … with check_expiration = on; y acordar una rotación.',
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
        'Contraseñas conocidas',
        'Requiere CONTROL SERVER o pertenencia a securityadmin para leer password_hash de sys.sql_logins.',
        weak.error,
      ),
    );
  } else if (weak.rows.length > 0) {
    const active = weak.rows.filter((row) => row['is_disabled'] !== true);
    findings.push({
      checkId: 'mssql_weak_passwords',
      category: 'autenticacion',
      severity: active.length > 0 ? 'critica' : 'media',
      title: 'Logins con contraseña de diccionario',
      detail: `${weak.rows.length} login(s) tienen una contraseña de una lista de doce valores triviales${
        active.length < weak.rows.length ? ' (algunos deshabilitados)' : ''
      }: ${weak.rows.map((row) => String(row['name'])).join(', ')}. La comprobación usa PWDCOMPARE, que compara contra el hash sin intentar iniciar sesión.`,
      remediation: 'Cambiar esas contraseñas ya y activar CHECK_POLICY en los logins afectados.',
      evidence: { logins: weak.rows.map((row) => row['name']) },
    });
  } else {
    findings.push(
      ok(
        'mssql_weak_passwords',
        'autenticacion',
        'Contraseñas conocidas',
        'Ningún login coincide con las doce contraseñas triviales probadas (blanco, nombre del login, password, Password1, sa, 123456 y similares).',
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
      title: 'Autenticación mixta habilitada',
      detail:
        'El servidor acepta logins de SQL Server además de los de Windows. No es un fallo, pero cada login de SQL es una contraseña que hay que rotar y vigilar por separado, sin las políticas del directorio.',
      remediation: 'Si todos los clientes pueden usar autenticación integrada, cambiar el modo a "sólo Windows".',
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
      unverifiable('mssql_tde', 'cifrado', 'Cifrado de datos en reposo', 'Requiere lectura de sys.databases.', databases.error),
    );
  } else {
    const userDbs = databases.rows.filter((row) => Number(row['database_id']) > 4);
    const unencrypted = userDbs.filter((row) => row['is_encrypted'] !== true);

    if (userDbs.length === 0) {
      findings.push(ok('mssql_tde', 'cifrado', 'Cifrado en reposo', 'No hay bases de usuario que evaluar.'));
    } else if (unencrypted.length > 0) {
      findings.push({
        checkId: 'mssql_tde',
        category: 'cifrado',
        severity: 'media',
        title: 'Bases sin cifrado en reposo',
        detail: `${unencrypted.length} de ${userDbs.length} base(s) de usuario no tienen TDE: ${unencrypted
          .map((row) => String(row['name']))
          .join(', ')}. Quien obtenga los archivos .mdf o una copia de respaldo puede leerlos íntegros.`,
        remediation:
          'Habilitar Transparent Data Encryption, y guardar la copia de seguridad de la clave maestra en un lugar distinto al de los respaldos.',
        evidence: { bases: unencrypted.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_tde', 'cifrado', 'Cifrado en reposo', 'Todas las bases de usuario tienen TDE.'));
    }

    // TRUSTWORTHY en msdb viene activado de fábrica; en una base de usuario es
    // una vía conocida de escalada a sysadmin.
    const trustworthy = userDbs.filter((row) => row['is_trustworthy_on'] === true);
    if (trustworthy.length > 0) {
      findings.push({
        checkId: 'mssql_trustworthy',
        category: 'privilegios',
        severity: 'alta',
        title: 'Bases de usuario con TRUSTWORTHY activado',
        detail: `${trustworthy.map((row) => String(row['name'])).join(', ')} tienen TRUSTWORTHY ON. Combinado con un propietario sysadmin, es una vía conocida de escalada de privilegios: quien pueda crear un procedimiento en esa base puede llegar a sysadmin.`,
        remediation: 'alter database … set trustworthy off; y usar firma de módulos con certificado si se necesita acceso entre bases.',
        evidence: { bases: trustworthy.map((row) => row['name']) },
      });
    } else {
      findings.push(ok('mssql_trustworthy', 'privilegios', 'TRUSTWORTHY', 'Ninguna base de usuario lo tiene activado.'));
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
        title: 'Hay conexiones sin cifrar ahora mismo',
        detail: `${plain['total']} de ${total} conexión(es) activas no están cifradas. No es una configuración teórica: son sesiones reales enviando datos y credenciales en claro por la red.`,
        remediation:
          'Activar Force Encryption en la configuración de red del servidor y verificar que los clientes usen Encrypt=true con validación de certificado.',
        evidence: { conexiones: connections.rows },
      });
    } else if (total > 0) {
      findings.push(ok('mssql_unencrypted_connections', 'cifrado', 'Conexiones cifradas', `Las ${total} conexiones activas están cifradas.`));
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
      title: 'Cifrado obligatorio en el protocolo',
      detail:
        'No se pudo leer ForceEncryption: sys.dm_server_registry sólo devuelve datos en instalaciones sobre Windows. En Linux esta opción se configura con mssql-conf y no se expone por T-SQL.',
      remediation: 'En Linux, verificar a mano con: mssql-conf get network.forceencryption',
      evidence: {},
    });
  } else {
    const forced = String(registry.rows[0]?.['value_data'] ?? '0') === '1';
    findings.push(
      forced
        ? ok('mssql_force_encryption', 'cifrado', 'Cifrado obligatorio', 'ForceEncryption activado.')
        : {
            checkId: 'mssql_force_encryption',
            category: 'cifrado',
            severity: 'alta',
            title: 'El cifrado no es obligatorio',
            detail: 'ForceEncryption está desactivado: el cliente decide si cifra, y por omisión muchos no lo hacen.',
            remediation: 'Activar Force Encryption en SQL Server Configuration Manager.',
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
        title: 'Opciones peligrosas habilitadas',
        detail: enabled
          .map((row) => `${row['name']} (${SURFACE_AREA[String(row['name'])]?.why})`)
          .join('; '),
        remediation:
          'Deshabilitar lo que no se use: exec sp_configure \'<opción>\', 0; reconfigure with override;',
        evidence: { opciones: enabled.map((row) => row['name']) },
      });
    } else {
      findings.push(
        ok('mssql_surface_area', 'superficie', 'Opciones peligrosas', 'xp_cmdshell, CLR, OLE Automation y consultas distribuidas ad hoc están deshabilitadas.'),
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
      unverifiable('mssql_audit', 'auditoria', 'Auditoría del servidor', 'Requiere VIEW ANY DEFINITION.', audits.error),
    );
  } else {
    const active = audits.rows.filter((row) => row['is_state_enabled'] === true);
    if (active.length === 0) {
      findings.push({
        checkId: 'mssql_audit',
        category: 'auditoria',
        severity: 'media',
        title: 'Sin auditoría configurada',
        detail:
          audits.rows.length === 0
            ? 'No existe ninguna especificación de SQL Server Audit. No hay registro de accesos ni de cambios de permisos.'
            : `Hay ${audits.rows.length} auditoría(s) definidas pero ninguna habilitada.`,
        remediation:
          'Crear una auditoría de servidor con al menos los grupos de acciones de inicio de sesión fallido y cambios de permisos, y habilitarla.',
        evidence: { definidas: audits.rows.length },
      });
    } else {
      findings.push(ok('mssql_audit', 'auditoria', 'Auditoría del servidor', `${active.length} auditoría(s) habilitada(s).`));
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
      title: 'Certificados por vencer',
      detail: certificates.rows
        .map((row) => `${row['name']} vence el ${String(row['expiry_date']).slice(0, 10)}`)
        .join('; '),
      remediation: 'Renovar el certificado antes del vencimiento; si respalda TDE, planificar la rotación de la clave.',
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
