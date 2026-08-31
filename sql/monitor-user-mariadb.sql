-- Usuario de monitoreo para MariaDB y MySQL — mínimo privilegio
--
-- Búho hace inventario y auditoría de seguridad sobre MariaDB; no escribe nada.
--
-- Ejecutar como root, una vez por servidor:
--     mariadb -h SERVIDOR -u root -p < monitor-user-mariadb.sql
--
-- Cambiar la contraseña y el host de origen antes de correrlo. `'%'` acepta
-- conexiones desde cualquier parte: si la máquina de Búho tiene IP fija, poner
-- esa IP en su lugar y el usuario deja de servirle a nadie más.

create user if not exists 'buho_monitor'@'%'
  identified by 'CAMBIAR-ESTA-CONTRASENA';

-- ------------------------------------------------------------- nivel 1: base
--
-- Con esto funcionan: versión y edición, configuración del servidor, estado de
-- replicación, y el inventario de cuentas de la auditoría de seguridad.

-- Ver los procesos de todos los usuarios, no sólo los propios.
grant process on *.* to 'buho_monitor'@'%';

-- Estado de replicación. En MariaDB 10.5+ existe SLAVE MONITOR, más acotado que
-- REPLICATION CLIENT; se otorgan los dos porque el nombre cambió y el servidor
-- ignora el que no conoce.
grant replication client on *.* to 'buho_monitor'@'%';
-- grant slave monitor on *.* to 'buho_monitor'@'%';   -- MariaDB 10.5+

-- Las cuentas, sus métodos de autenticación y sus privilegios. Es lo que lee la
-- auditoría de seguridad; sin esto la pantalla reporta "no verificable" en vez
-- de inventar.
grant select on mysql.user to 'buho_monitor'@'%';
grant select on mysql.db to 'buho_monitor'@'%';
-- MariaDB 10.4+ guarda account_locked y password_last_changed acá, en un JSON.
grant select on mysql.global_priv to 'buho_monitor'@'%';

-- Esquema de rendimiento, si está habilitado.
grant select on performance_schema.* to 'buho_monitor'@'%';


-- --------------------------------------------------- nivel 2: tamaños reales
--
-- `information_schema.tables` sólo muestra los objetos sobre los que el usuario
-- tiene algún privilegio. Sin nivel 2, el inventario de disco reporta el
-- tamaño de los archivos que ve y **no** el del servidor completo, lo que da
-- una impresión falsa de holgura.
--
-- El intercambio es real: SELECT global permite leer los datos. No permite
-- modificarlos, pero es lectura de todo. Dos opciones:
--
-- A. Global (inventario completo de disco):
--
--     grant select on *.* to 'buho_monitor'@'%';
--
-- B. Por esquema (sólo lo que se quiera medir):
--
--     grant select on nombre_del_esquema.* to 'buho_monitor'@'%';
--
-- Búho declara en la pestaña de cobertura del parque qué esquemas quedaron
-- fuera, así que la opción B no miente: dice qué no está midiendo.


-- ------------------------------------------------------------------- límites

-- Un colector mal configurado no debe agotar las conexiones del servidor.
alter user 'buho_monitor'@'%' with max_user_connections 5;

-- Obligar TLS si el servidor lo tiene configurado. Descomentar sólo si hay
-- certificado: con REQUIRE SSL y sin certificado, el usuario no puede entrar.
-- alter user 'buho_monitor'@'%' require ssl;

flush privileges;


-- ---------------------------------------------------------------- verificar
--
-- Conectarse con el usuario nuevo y correr:
--
--     select version();
--     show global status like 'Uptime';
--     select count(*) from information_schema.processlist;   -- PROCESS
--     show replica status;                                   -- REPLICATION CLIENT
--     select count(*) from mysql.user;                       -- auditoría
--     select count(*) from information_schema.tables;         -- tamaños visibles
--
-- Lo que falle indica exactamente qué permiso falta.
