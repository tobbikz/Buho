-- Usuario de monitoreo para SQL Server — mínimo privilegio
--
-- Búho hace inventario y auditoría de seguridad sobre SQL Server; no escribe.
--
-- Ejecutar como sysadmin, una vez por instancia:
--     sqlcmd -S SERVIDOR -U sa -i monitor-user-mssql.sql
--
-- Cambiar la contraseña antes de correrlo. En Linux o en contenedor, la
-- instancia suele no tener autenticación de Windows disponible, así que el
-- login SQL es el camino.

use master;
go

-- ------------------------------------------------------------------- el login

if not exists (select 1 from sys.server_principals where name = 'buho_monitor')
begin
  create login buho_monitor with password = 'CAMBIAR-ESTA-Contrasena1!',
    check_policy = on;
end
else
  print 'buho_monitor ya existe; no se toca su contraseña';
go

grant connect sql to buho_monitor;
go

-- ------------------------------------------------------- permisos de servidor

-- Las DMV de estado: sesiones, esperas, memoria, archivos. Es el permiso que
-- sostiene casi todo el inventario.
grant view server state to buho_monitor;
go

-- Metadatos de objetos que el login no posee: bases, logins, trabajos. Sin
-- esto, sys.databases devuelve sólo master y el parque se ve vacío.
grant view any definition to buho_monitor;
go

-- Los hashes de contraseña de sys.sql_logins, que la auditoría usa con
-- PWDCOMPARE para detectar contraseñas débiles sin intentar autenticarse.
-- Requiere CONTROL SERVER en versiones anteriores a 2022; en 2022+ alcanza
-- VIEW SERVER SECURITY STATE, que es mucho más acotado.
--
-- Si esto no se otorga, la comprobación de contraseñas débiles aparece como
-- "no verificable" en la pantalla de cobertura, que es lo correcto: no se
-- reporta como aprobada algo que no se pudo mirar.
begin try
  grant view server security state to buho_monitor;   -- SQL Server 2022+
end try
begin catch
  print 'VIEW SERVER SECURITY STATE no existe en esta versión.';
  print 'Para detectar contraseñas débiles hace falta CONTROL SERVER, que es';
  print 'demasiado; sin él, esa comprobación queda como no verificable.';
end catch
go


-- ------------------------------------------------- msdb: trabajos y respaldos

-- El historial de respaldos y el estado del Agent viven en msdb. Sin esto, la
-- pantalla de respaldos del parque no puede decir cuándo fue el último y
-- reporta "no verificable" en lugar de un dato inventado.
use msdb;
go

if not exists (select 1 from sys.database_principals where name = 'buho_monitor')
  create user buho_monitor for login buho_monitor;
go

-- Lectura del historial de trabajos del Agent.
alter role sqlagentreaderrole add member buho_monitor;
go

-- Historial de respaldos.
grant select on dbo.backupset to buho_monitor;
grant select on dbo.backupmediafamily to buho_monitor;
go


-- ------------------------------------------------ cada base: tamaños de disco

-- `sys.database_files` es local a cada base: para medir el tamaño real de los
-- archivos hay que tener un usuario en cada una. Repetir por base.
--
--     use [NOMBRE_DE_LA_BASE];
--     create user buho_monitor for login buho_monitor;
--     grant view database state to buho_monitor;
--
-- Sin esto el inventario de disco muestra sólo las bases del sistema. La
-- pestaña de cobertura del parque dice cuáles quedaron fuera.


-- ---------------------------------------------------------------- verificar
--
-- Conectarse con el login nuevo y correr:
--
--     select @@version;
--     select count(*) from sys.dm_exec_sessions;      -- VIEW SERVER STATE
--     select count(*) from sys.databases;             -- VIEW ANY DEFINITION
--     select count(*) from sys.sql_logins;            -- auditoría de cuentas
--     select top 1 backup_finish_date from msdb.dbo.backupset
--       order by backup_finish_date desc;             -- respaldos
--     select count(*) from msdb.dbo.sysjobs;          -- trabajos
--
-- Lo que falle indica exactamente qué permiso falta.
