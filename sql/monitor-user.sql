-- Usuario de monitoreo para PostgreSQL — mínimo privilegio
--
-- Búho nunca escribe en la instancia vigilada. Este rol no necesita ni puede
-- modificar datos: `pg_monitor` sólo agrega lectura de estadísticas y de
-- parámetros.
--
-- Ejecutar como superusuario, una vez por clúster:
--     psql -h SERVIDOR -U postgres -d postgres -f monitor-user.sql
--
-- Cambiar la contraseña antes de correrlo. Si el clúster acepta conexiones por
-- red, revisar además pg_hba.conf: `scram-sha-256`, nunca `trust` ni `md5`.

\set buho_password 'CAMBIAR-ESTA-CONTRASENA'

-- ---------------------------------------------------------------- el rol

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'buho_monitor') then
    execute format('create role buho_monitor login password %L', :'buho_password');
  else
    raise notice 'buho_monitor ya existe; no se toca su contraseña';
  end if;
end
$$;

-- Lectura de estadísticas y parámetros. Incluye pg_read_all_stats (que da
-- acceso a pg_stat_statements y a las consultas de otros usuarios en
-- pg_stat_activity) y pg_read_all_settings.
grant pg_monitor to buho_monitor;

-- Un tope de conexiones evita que un colector mal configurado agote los slots
-- del servidor. Búho abre un pool por instancia del config.
alter role buho_monitor connection limit 5;

-- Sin esto el rol puede autenticarse pero no entrar a ninguna base.
grant connect on database :"DBNAME" to buho_monitor;

-- Repetir por cada base a vigilar. Las métricas por base (tamaño, cache hit,
-- edad de XID) salen de vistas del clúster y no necesitan conexión; las de
-- tabla (tuplas muertas, tamaños, índices sin uso) sí, porque
-- pg_stat_user_tables es local a la base conectada.
--
--     grant connect on database otra_base to buho_monitor;


-- --------------------------------------------- opcional: pg_stat_statements
--
-- Búho no la crea: instalar una extensión es una decisión del dueño de la base,
-- y requiere reiniciar si falta en shared_preload_libraries.
--
-- 1. En postgresql.conf:  shared_preload_libraries = 'pg_stat_statements'
-- 2. Reiniciar el servidor.
-- 3. Por cada base a vigilar:
--
--     create extension if not exists pg_stat_statements;
--
-- La consola muestra un asistente con estos pasos cuando detecta que falta.


-- ------------------------------------------------- opcional: lectura del log
--
-- El log es de donde salen los deadlocks completos y los errores de la
-- aplicación, que no aparecen en ninguna vista de estadísticas.
--
-- Hay dos formas y conviene entender el intercambio:
--
-- A. **Sin acceso al sistema operativo** — una función envoltorio. Búho lee el
--    log por SQL, pero `pg_read_server_files` permitiría leer *cualquier*
--    archivo del servidor, así que no se otorga. En su lugar se crea una
--    función SECURITY DEFINER que sólo puede leer dentro del directorio de log.
--
-- B. **Con acceso al sistema operativo** — declarar `logs` en config.json con
--    origen `local`, `ssh` o `journal`. No requiere ningún permiso en la base.
--    Es la única opción cuando `logging_collector = off` y el log va a
--    journald, que es lo normal en instalaciones por paquete de Linux.
--
-- Para la opción A, ejecutar como superusuario:
--
--     create or replace function buho_read_log(archivo text, desde bigint, largo integer)
--       returns text
--       language plpgsql
--       security definer
--       set search_path = pg_catalog, pg_temp
--     as $fn$
--     declare
--       directorio text;
--       ruta       text;
--     begin
--       -- Sin esto, un `..` en el nombre lee cualquier archivo del servidor y la
--       -- función deja de ser más segura que el permiso que evita.
--       if archivo !~ '^[A-Za-z0-9._%+-]+$' then
--         raise exception 'nombre de archivo no permitido: %', archivo;
--       end if;
--
--       select setting into directorio from pg_settings where name = 'log_directory';
--       if directorio is null then
--         raise exception 'log_directory no está definido';
--       end if;
--
--       -- log_directory puede ser relativo al directorio de datos.
--       if left(directorio, 1) <> '/' then
--         directorio := (select setting from pg_settings where name = 'data_directory')
--                       || '/' || directorio;
--       end if;
--
--       ruta := directorio || '/' || archivo;
--       return pg_read_file(ruta, desde, largo);
--     end
--     $fn$;
--
--     revoke all on function buho_read_log(text, bigint, integer) from public;
--     grant execute on function buho_read_log(text, bigint, integer) to buho_monitor;
--
-- `pg_ls_logdir()` ya es ejecutable por miembros de pg_monitor, así que el rol
-- puede listar el directorio sin permisos extra.
--
-- Para que el log traiga algo aprovechable, en postgresql.conf:
--
--     logging_collector = on          # requiere reinicio
--     log_destination = 'jsonlog'     # PG 15+; en PG 13-14 usar 'csvlog'
--     log_lock_waits = on             # esperas de bloqueo con su detalle
--     log_checkpoints = on
--     log_autovacuum_min_duration = '1s'
--     log_min_duration_statement = '1s'   # ajustar al volumen real
--
-- Con `log_destination = 'stderr'` Búho igual lee el log, pero tiene que
-- deducir la estructura desde `log_line_prefix` y algunos campos no existen.


-- ---------------------------------------------------------------- verificar

-- Conectarse con el rol nuevo y correr esto: si algo falla, falta un permiso.
--
--     select count(*) from pg_stat_activity;             -- pg_read_all_stats
--     select count(*) from pg_stat_database;
--     select setting from pg_settings where name = 'data_directory';  -- settings
--     select count(*) from pg_stat_user_tables;          -- necesita connect
--     select count(*) from pg_stat_statements;           -- si está instalada
--
-- O más corto, desde la máquina de Búho:
--
--     npm run check -- --instance ALIAS
