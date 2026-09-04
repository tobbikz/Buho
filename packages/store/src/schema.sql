-- Búho — schema del store.
-- Idempotente: se puede aplicar en cada arranque.
--
-- Decisión: particionado declarativo nativo + rollups propios, sin TimescaleDB.
-- La extensión no está disponible en muchas instalaciones y añade una
-- dependencia difícil de justificar en un despliegue on-prem.

create schema if not exists buho;

-- ---------------------------------------------------------------- inventario

create table if not exists buho.instances (
  instance_id   bigint generated always as identity primary key,
  tenant        text        not null default 'default',
  alias         text        not null,
  host          text        not null,
  port          integer     not null,
  database      text        not null,
  environment   text        not null default 'prod',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  unique (tenant, alias)
);

-- Etiquetas de instancia: el único mecanismo de organización.
--
-- Se eligió etiquetas clave/valor en vez de un campo "grupo" porque un grupo
-- fuerza una sola jerarquía y la realidad tiene varias a la vez: la misma
-- instancia es del equipo de datos, del cliente ACME y del sitio de San José.
-- Con etiquetas, "agrupar por" es elegir cuál de esas dimensiones se mira hoy,
-- y no hay que rehacer el modelo cuando aparece la cuarta.
--
-- La verdad vive en config.json y el colector reemplaza estas filas en cada
-- arranque. La consola no las edita: dos dueños para el mismo dato terminan en
-- que el colector borra lo que alguien acaba de escribir en la interfaz.
create table if not exists buho.instance_tags (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  key         text        not null,
  value       text        not null,
  captured_at timestamptz not null default now(),
  primary key (instance_id, key)
);

create index if not exists instance_tags_lookup on buho.instance_tags (key, value);

create table if not exists buho.instance_capabilities (
  instance_id          bigint      primary key references buho.instances (instance_id) on delete cascade,
  version_num          integer     not null,
  version_text         text        not null,
  in_recovery          boolean     not null,
  has_pg_monitor       boolean     not null,
  is_superuser         boolean     not null,
  track_io_timing      boolean     not null,
  stat_statements      text        not null
    check (stat_statements in ('active', 'preloaded_not_created', 'not_preloaded')),
  extensions           jsonb       not null default '{}',
  server_started_at    timestamptz,
  probed_at            timestamptz not null default now()
);

-- ------------------------------------------------------------------- series

create table if not exists buho.metric_samples (
  instance_id bigint           not null references buho.instances (instance_id) on delete cascade,
  ts          timestamptz      not null,
  metric      text             not null,
  labels      jsonb            not null default '{}',
  value       double precision not null
) partition by range (ts);

-- Partición por defecto: una inserción nunca debe fallar por falta de partición.
create table if not exists buho.metric_samples_default
  partition of buho.metric_samples default;

create index if not exists metric_samples_ts_brin
  on buho.metric_samples using brin (ts);
create index if not exists metric_samples_lookup
  on buho.metric_samples (instance_id, metric, ts desc);

create table if not exists buho.metric_rollup_5m (
  instance_id bigint           not null references buho.instances (instance_id) on delete cascade,
  bucket      timestamptz      not null,
  metric      text             not null,
  labels      jsonb            not null default '{}',
  samples     integer          not null,
  avg_value   double precision not null,
  min_value   double precision not null,
  max_value   double precision not null,
  primary key (instance_id, metric, labels, bucket)
);

create table if not exists buho.metric_rollup_1h (
  instance_id bigint           not null references buho.instances (instance_id) on delete cascade,
  bucket      timestamptz      not null,
  metric      text             not null,
  labels      jsonb            not null default '{}',
  samples     integer          not null,
  avg_value   double precision not null,
  min_value   double precision not null,
  max_value   double precision not null,
  primary key (instance_id, metric, labels, bucket)
);

-- ------------------------------------------------------------------- checks

create table if not exists buho.check_results (
  check_result_id bigint      generated always as identity primary key,
  instance_id     bigint      not null references buho.instances (instance_id) on delete cascade,
  ts              timestamptz not null default now(),
  check_id        text        not null,
  title           text        not null,
  severity        text        not null check (severity in ('critical', 'warning', 'info')),
  object          text,
  message         text        not null,
  remediation     text        not null,
  value           double precision
);

create index if not exists check_results_lookup
  on buho.check_results (instance_id, ts desc);

create table if not exists buho.health_scores (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  ts          timestamptz not null,
  score       integer     not null check (score between 0 and 100),
  critical    integer     not null default 0,
  warning     integer     not null default 0,
  info        integer     not null default 0,
  primary key (instance_id, ts)
);

-- ------------------------------------------------------------------ bloqueos

-- Episodios, no muestras: cada fila es "esta sesión estuvo esperando este
-- lock". La identidad natural es (instancia, pid del que espera, inicio de su
-- query); mientras el bloqueo sigue vivo se actualiza la misma fila en vez de
-- acumular una por muestreo.
--
-- `nulls not distinct` (PG15+) es lo que hace que query_start nulo no genere
-- una fila nueva en cada ciclo. El store siempre es nuestro, así que exigir
-- PG15 aquí no le cuesta nada al cliente.
create table if not exists buho.lock_episodes (
  episode_id           bigint           generated always as identity primary key,
  instance_id          bigint           not null references buho.instances (instance_id) on delete cascade,
  waiter_pid           integer          not null,
  waiter_query_start   timestamptz,
  first_seen_at        timestamptz      not null,
  last_seen_at         timestamptz      not null,
  samples              integer          not null default 1,
  wait_seconds         double precision not null,
  waiter_user          text,
  waiter_application   text,
  waiter_database      text,
  waiter_query         text             not null,
  wait_event_type      text,
  wait_event           text,
  lock_type            text,
  lock_mode            text,
  lock_object          text,
  blocker_pids         integer[]        not null default '{}',
  blocker_pid          integer,
  blocker_state        text,
  blocker_query        text,
  blocker_user         text,
  blocker_application  text,
  blocker_xact_seconds double precision,
  constraint lock_episodes_identity
    unique nulls not distinct (instance_id, waiter_pid, waiter_query_start)
);

create index if not exists lock_episodes_recent
  on buho.lock_episodes (instance_id, last_seen_at desc);

-- ---------------------------------------------------- análisis por consulta

-- El texto normalizado se guarda una vez por queryid, no en cada muestra: son
-- hasta 4 KB por fila y no cambian.
create table if not exists buho.statement_texts (
  instance_id   bigint      not null references buho.instances (instance_id) on delete cascade,
  queryid       bigint      not null,
  query         text        not null,
  -- El texto se guardó cortado a 4000 caracteres. Importa saberlo: una consulta
  -- incompleta no se puede explicar, y mostrarla sin avisar hace creer que eso
  -- es todo lo que ejecuta la aplicación.
  truncated     boolean     not null default false,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  primary key (instance_id, queryid)
);

alter table buho.statement_texts
  add column if not exists truncated boolean not null default false;

-- ------------------------------------------- atribución por aplicación
--
-- Observaciones de qué aplicación estaba ejecutando qué consulta. Es un
-- muestreo de pg_stat_activity, no una cuenta: se guarda el número de veces que
-- se vio activa cada combinación, y con eso se reparte después el peso que
-- pg_stat_statements sí midió. Particionada porque es una serie de tiempo y se
-- purga con la misma política que las demás muestras crudas.
create table if not exists buho.query_actors (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  ts          timestamptz not null,
  queryid     bigint      not null,
  application text        not null,
  username    text        not null,
  database    text        not null,
  samples     integer     not null
) partition by range (ts);

create table if not exists buho.query_actors_default
  partition of buho.query_actors default;

create index if not exists query_actors_lookup
  on buho.query_actors (instance_id, ts desc);
create index if not exists query_actors_by_query
  on buho.query_actors (instance_id, queryid, ts desc);

-- ------------------------------------- muestreo de sesiones y esperas
--
-- Dos tablas porque son dos preguntas. El agregado contesta "en qué se va el
-- tiempo" y tiene que ser barato de consultar sobre semanas; el detalle
-- contesta "qué estaba corriendo a las 3:04" y sólo guarda las sesiones que
-- valen la pena reconstruir.
--
-- Es muestreo, no contabilidad: una espera de dos milisegundos casi nunca cae
-- en una foto cada diez segundos. Lo que mide bien es la duración: si una
-- espera aparece en el 40 % de las fotos, ocupó el 40 % del tiempo.
create table if not exists buho.wait_samples (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  ts          timestamptz not null,
  wait_type   text        not null,
  wait_event  text,
  sessions    integer     not null
) partition by range (ts);

create table if not exists buho.wait_samples_default
  partition of buho.wait_samples default;

create index if not exists wait_samples_lookup
  on buho.wait_samples (instance_id, ts desc);

create table if not exists buho.session_samples (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  ts          timestamptz not null,
  pid         integer     not null,
  state       text        not null,
  wait_type   text,
  wait_event  text,
  application text        not null,
  username    text        not null,
  database    text        not null,
  queryid     bigint,
  query_ms    numeric,
  xact_ms     numeric,
  blocked_by  integer,
  query       text
) partition by range (ts);

create table if not exists buho.session_samples_default
  partition of buho.session_samples default;

create index if not exists session_samples_lookup
  on buho.session_samples (instance_id, ts desc);

-- ------------------------------------- topología app ↔ tabla (semanal)
--
-- Congela el grafo vivo del flujo una vez por semana. Sirve para comparar
-- "antes del deploy vs. ahora" sin rehacer el análisis léxico sobre meses de
-- statement_stats. No está particionada: son cientos de filas por instancia
-- y semana, no una serie cruda.
create table if not exists buho.topology_edges (
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  week_start   date        not null,
  actor        text        not null,
  schema_name  text        not null,
  relation     text        not null,
  direction    text        not null check (direction in ('escritura', 'lectura')),
  weight       double precision not null,
  samples      integer     not null default 0,
  captured_at  timestamptz not null default now(),
  primary key (instance_id, week_start, actor, schema_name, relation, direction)
);

create index if not exists topology_edges_week
  on buho.topology_edges (instance_id, week_start desc);

-- La primera versión de esta tabla no estaba particionada. Una tabla plana no
-- se convierte con ALTER, así que se renombra, se recrea particionada y se
-- copian las filas (que caen en la partición por defecto y de ahí las mueve la
-- purga normal).
do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'buho' and c.relname = 'statement_stats' and c.relkind = 'r'
  ) then
    alter table buho.statement_stats rename to statement_stats_flat;
  end if;
end $$;

-- Deltas por intervalo, no acumulados: "las consultas más caras de la última
-- hora" se responde sumando intervalos, no leyendo el contador desde el último
-- reset del servidor.
create table if not exists buho.statement_stats (
  instance_id  bigint           not null references buho.instances (instance_id) on delete cascade,
  ts           timestamptz      not null,
  queryid      bigint           not null,
  database     text,
  username     text,
  toplevel     boolean          not null default true,
  calls        double precision not null,
  exec_ms      double precision not null,
  rows         double precision not null,
  shared_hit   double precision not null default 0,
  shared_read  double precision not null default 0,
  temp_read    double precision not null default 0,
  temp_written double precision not null default 0,
  wal_bytes    double precision not null default 0
) partition by range (ts);

create table if not exists buho.statement_stats_default
  partition of buho.statement_stats default;

create index if not exists statement_stats_lookup
  on buho.statement_stats (instance_id, ts desc);
create index if not exists statement_stats_by_query
  on buho.statement_stats (instance_id, queryid, ts desc);

do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'buho' and c.relname = 'statement_stats_flat'
  ) then
    insert into buho.statement_stats select * from buho.statement_stats_flat;
    drop table buho.statement_stats_flat;
  end if;
end $$;

-- ------------------------------------------------------ parque (multi-motor)
--
-- Estas tablas son **instantáneas del estado actual**, no series de tiempo: la
-- pregunta "¿qué servidor no tiene backup?" se hace sobre el último valor
-- conocido, y guardar una fila por hora de algo que cambia una vez al mes sólo
-- infla el store. Cada colector reemplaza el conjunto de filas de su instancia
-- (upsert + borrado de las que ya no vinieron) y deja `captured_at` para que la
-- UI pueda decir "esto se leyó hace 40 minutos".
--
-- El motor vive en buho.instances porque MariaDB y SQL Server entran por acá:
-- el pipeline de métricas de 5 s y los 22 checks siguen siendo de PostgreSQL.

alter table buho.instances
  add column if not exists engine text not null default 'postgres';

alter table buho.instances drop constraint if exists instances_engine_check;
alter table buho.instances
  add constraint instances_engine_check
  check (engine in ('postgres', 'mariadb', 'mssql', 'mongodb'));

create table if not exists buho.engine_info (
  instance_id      bigint      primary key references buho.instances (instance_id) on delete cascade,
  engine           text        not null,
  version_num      integer,
  version_text     text        not null,
  -- Edición y nivel de parche sólo existen en SQL Server; en los libres queda null.
  edition          text,
  product_level    text,
  update_level     text,
  -- "collation" es palabra reservada en PostgreSQL y no se puede usar sin comillas.
  server_collation text,
  started_at       timestamptz,
  cores            integer,
  memory_bytes     bigint,
  -- Fin de soporte del mayor: se resuelve con una tabla local, no consultando
  -- internet desde un despliegue on-prem que puede no tener salida.
  eol_date         date,
  captured_at      timestamptz not null default now()
);

create table if not exists buho.server_settings (
  instance_id      bigint      not null references buho.instances (instance_id) on delete cascade,
  name             text        not null,
  value            text        not null,
  unit             text,
  category         text,
  -- ¿el valor viene de un archivo o es el default del motor? Es la diferencia
  -- entre "alguien lo decidió" y "nadie lo tocó nunca".
  is_default       boolean,
  requires_restart boolean,
  captured_at      timestamptz not null default now(),
  primary key (instance_id, name)
);

create table if not exists buho.disk_objects (
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  -- 'database' | 'file' | 'tablespace' | 'volume'
  kind         text        not null,
  name         text        not null,
  container    text        not null default '',
  size_bytes   bigint,
  used_bytes   bigint,
  free_bytes   bigint,
  max_bytes    bigint,
  location     text,
  detail       jsonb       not null default '{}',
  captured_at  timestamptz not null default now(),
  primary key (instance_id, kind, container, name)
);

create table if not exists buho.replication_state (
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  -- 'primary' | 'standby' | 'slot' | 'replica' | 'availability_group'
  role         text        not null,
  peer         text        not null default '',
  state        text,
  lag_bytes    bigint,
  lag_seconds  double precision,
  detail       jsonb       not null default '{}',
  captured_at  timestamptz not null default now(),
  primary key (instance_id, role, peer)
);

create table if not exists buho.backup_state (
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  database     text        not null,
  -- 'full' | 'differential' | 'log' | 'wal_archive'
  kind         text        not null,
  finished_at  timestamptz,
  size_bytes   bigint,
  -- De dónde salió el dato: 'msdb' es un catálogo real; 'pg_stat_archiver' es
  -- una inferencia y la UI tiene que decirlo.
  source       text        not null,
  detail       jsonb       not null default '{}',
  captured_at  timestamptz not null default now(),
  primary key (instance_id, database, kind)
);

create table if not exists buho.jobs (
  instance_id      bigint      not null references buho.instances (instance_id) on delete cascade,
  scope            text        not null default '',
  name             text        not null,
  enabled          boolean,
  last_run_at      timestamptz,
  last_status      text,
  last_duration_ms bigint,
  next_run_at      timestamptz,
  detail           jsonb       not null default '{}',
  captured_at      timestamptz not null default now(),
  primary key (instance_id, scope, name)
);

create table if not exists buho.licensing (
  instance_id       bigint      primary key references buho.instances (instance_id) on delete cascade,
  edition           text,
  license_model     text,
  cores             integer,
  cores_limit       integer,
  memory_bytes      bigint,
  memory_limit_bytes bigint,
  -- null = no aplica (motor libre). false = hay un problema de licenciamiento.
  production_ok     boolean,
  note              text,
  detail            jsonb       not null default '{}',
  captured_at       timestamptz not null default now()
);

-- Por qué un dominio está vacío. Sin esto, el tab de Backups de PostgreSQL
-- parece un bug en vez de un límite del motor.
create table if not exists buho.inventory_notes (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  domain      text        not null,
  level       text        not null default 'info' check (level in ('info', 'warn', 'error')),
  message     text        not null,
  captured_at timestamptz not null default now(),
  primary key (instance_id, domain, message)
);

-- ------------------------------------------------------ auditoría de seguridad

-- Hallazgos de la última auditoría. Se reemplazan en cada corrida, igual que el
-- inventario: lo que importa es la postura actual, no la historia de cada
-- hallazgo individual.
--
-- La severidad incluye 'no_verificable' a propósito. Guardar sólo los problemas
-- confirmados dejaría indistinguibles dos situaciones opuestas: "esto está
-- bien" y "no tengo permiso para saberlo".
create table if not exists buho.security_findings (
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  check_id     text        not null,
  category     text        not null,
  severity     text        not null check (severity in ('critica','alta','media','baja','ok','no_verificable')),
  title        text        not null,
  detail       text        not null,
  remediation  text,
  evidence     jsonb       not null default '{}',
  captured_at  timestamptz not null default now(),
  primary key (instance_id, check_id)
);

create index if not exists security_findings_severity_idx
  on buho.security_findings (severity, category);

-- Cuentas con capacidad de conexión y sus privilegios globales.
create table if not exists buho.security_principals (
  instance_id     bigint      not null references buho.instances (instance_id) on delete cascade,
  name            text        not null,
  -- MariaDB identifica la cuenta por usuario + host, así que forma parte de la
  -- clave; los otros motores guardan cadena vacía.
  host            text        not null default '',
  kind            text        not null,
  can_login       boolean     not null default false,
  is_superuser    boolean     not null default false,
  disabled        boolean     not null default false,
  auth_method     text,
  password_set_at timestamptz,
  expires_at      timestamptz,
  privileges      text[]      not null default '{}',
  detail          jsonb       not null default '{}',
  captured_at     timestamptz not null default now(),
  primary key (instance_id, name, host)
);

alter table buho.security_principals add column if not exists detail jsonb not null default '{}';

-- La postura sí conserva historia: sirve para responder "¿mejoramos?" y es una
-- fila por instancia y por corrida, así que no crece de forma preocupante.
create table if not exists buho.security_posture (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  captured_at timestamptz not null default now(),
  score       integer     not null,
  critical    integer     not null default 0,
  high        integer     not null default 0,
  medium      integer     not null default 0,
  low         integer     not null default 0,
  verified    integer     not null default 0,
  total       integer     not null default 0,
  primary key (instance_id, captured_at)
);

-- -------------------------------------------------------------- líneas base

-- Qué es normal para esta instancia, esta métrica y este momento de la semana.
--
-- Un umbral fijo no sirve: 400 conexiones pueden ser un lunes cualquiera en un
-- servidor y una emergencia en otro. Y en el mismo servidor, 400 a las 3 de la
-- tarde de un martes puede ser rutina mientras que 400 un domingo a las 4 de la
-- mañana es un proceso que se soltó. La única referencia útil es el propio
-- pasado del servidor a la misma hora.
--
-- Se guardan dos alcances:
--
-- - `hora_semana`: día de la semana más hora. Es el bueno, y necesita varias
--   semanas de historia para tener suficientes observaciones por celda.
-- - `hora_dia`: sólo la hora. Alcanza con días de historia, y sirve mientras el
--   otro se llena. La consola dice cuál está usando en vez de fingir que
--   siempre tuvo semanas de datos.
create table if not exists buho.metric_baselines (
  instance_id bigint not null references buho.instances (instance_id) on delete cascade,
  metric      text   not null,
  scope       text   not null check (scope in ('hora_semana', 'hora_dia')),
  -- 0..6 con domingo en 0, como `extract(dow)`. -1 en el alcance por hora.
  dow         smallint not null,
  hour        smallint not null check (hour between 0 and 23),
  samples     integer  not null,
  p10         double precision,
  p50         double precision,
  p90         double precision,
  avg_value   double precision,
  max_value   double precision,
  computed_at timestamptz not null default now(),
  primary key (instance_id, metric, scope, dow, hour)
);

create index if not exists metric_baselines_metric
  on buho.metric_baselines (instance_id, metric, scope);


-- ----------------------------------------------------------- vacuum y bloat

-- Foto del estado de vacuum por tabla.
--
-- Las tuplas muertas ya viven como métrica, pero "cuándo pasó el autovacuum" y
-- "cuánto falta para que se dispare" son datos tabulares con marcas de tiempo,
-- no curvas. Se reemplaza en cada vuelta: interesa el estado actual, y la
-- evolución ya está en las métricas.
create table if not exists buho.vacuum_tables (
  instance_id        bigint  not null references buho.instances (instance_id) on delete cascade,
  schema_name        text    not null,
  table_name         text    not null,
  live_tuples        bigint  not null,
  dead_tuples        bigint  not null,
  dead_pct           double precision,
  last_autovacuum    timestamptz,
  last_vacuum        timestamptz,
  last_autoanalyze   timestamptz,
  last_analyze       timestamptz,
  autovacuum_count   bigint  not null default 0,
  analyze_count      bigint  not null default 0,
  threshold          double precision,
  remaining          bigint,
  autovacuum_enabled boolean not null default true,
  size_bytes         bigint  not null,
  heap_bytes         bigint  not null,
  bloat_bytes        bigint,
  bloat_pct          double precision,
  -- Por qué no se pudo estimar. Un cero diría "está bien" y eso es justo lo que
  -- no se sabe cuando falta un ANALYZE.
  bloat_note         text,
  -- Wraparound por tabla: la edad de la base es la de su tabla más vieja, así
  -- que para actuar hay que saber cuál es.
  xid_age            bigint  not null default 0,
  mxid_age           bigint  not null default 0,
  freeze_max_age     bigint  not null default 0,
  xid_pct            double precision,
  mxid_pct           double precision,
  captured_at        timestamptz not null default now(),
  primary key (instance_id, schema_name, table_name)
);

create index if not exists vacuum_tables_dead on buho.vacuum_tables (instance_id, dead_tuples desc);
create index if not exists vacuum_tables_bloat on buho.vacuum_tables (instance_id, bloat_bytes desc nulls last);

alter table buho.vacuum_tables add column if not exists xid_age        bigint not null default 0;
alter table buho.vacuum_tables add column if not exists mxid_age       bigint not null default 0;
alter table buho.vacuum_tables add column if not exists freeze_max_age bigint not null default 0;
alter table buho.vacuum_tables add column if not exists xid_pct        double precision;
alter table buho.vacuum_tables add column if not exists mxid_pct       double precision;

create index if not exists vacuum_tables_xid on buho.vacuum_tables (instance_id, xid_pct desc nulls last);

-- Index inventory (refreshed with each vacuum scan on PostgreSQL).
create table if not exists buho.index_objects (
  instance_id      bigint      not null references buho.instances (instance_id) on delete cascade,
  schema_name      text        not null,
  table_name       text        not null,
  index_name       text        not null,
  size_bytes       bigint      not null,
  idx_scan         bigint      not null default 0,
  idx_tup_read     bigint      not null default 0,
  idx_tup_fetch    bigint      not null default 0,
  is_primary       boolean     not null default false,
  is_unique        boolean     not null default false,
  is_valid         boolean     not null default true,
  is_partial       boolean     not null default false,
  has_expression   boolean     not null default false,
  columns          text[]      not null default '{}',
  definition       text,
  status           text        not null default 'ok'
                     check (status in ('ok', 'unused', 'redundant', 'invalid')),
  covered_by       text,
  captured_at      timestamptz not null default now(),
  primary key (instance_id, schema_name, table_name, index_name)
);

create index if not exists index_objects_status on buho.index_objects (instance_id, status);
create index if not exists index_objects_size on buho.index_objects (instance_id, size_bytes desc);

-- Foreign keys for the ORM graph (refreshed with each vacuum scan).
create table if not exists buho.table_fks (
  instance_id       bigint      not null references buho.instances (instance_id) on delete cascade,
  from_schema       text        not null,
  from_table        text        not null,
  to_schema         text        not null,
  to_table          text        not null,
  constraint_name   text        not null,
  captured_at       timestamptz not null default now(),
  primary key (instance_id, from_schema, from_table, constraint_name)
);

create index if not exists table_fks_to on buho.table_fks (instance_id, to_schema, to_table);

-- Vacuums y analyzes en curso. Se borra y se reescribe: es un estado vivo.
create table if not exists buho.vacuum_progress (
  instance_id          bigint  not null references buho.instances (instance_id) on delete cascade,
  pid                  integer not null,
  kind                 text    not null,
  schema_name          text,
  table_name           text,
  phase                text,
  heap_blks_total      bigint,
  heap_blks_scanned    bigint,
  heap_blks_vacuumed   bigint,
  index_vacuum_count   bigint,
  dead_tuple_bytes     bigint,
  max_dead_tuple_bytes bigint,
  progress_pct         double precision,
  started_at           timestamptz,
  captured_at          timestamptz not null default now(),
  primary key (instance_id, pid, kind)
);


-- ------------------------------------------------------- log de PostgreSQL

-- Entradas del log del servidor.
--
-- Hay cosas que no existen en ninguna vista de estadísticas y sólo están acá: el
-- reporte completo de un deadlock con las dos consultas que se cruzaron, los
-- errores que ve la aplicación, las esperas de bloqueo con su detalle.
-- `pg_stat_database` dice cuántos deadlocks hubo; sólo el log dice cuáles.
create table if not exists buho.log_events (
  instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
  at          timestamptz not null,
  level       text        not null,
  kind        text        not null,
  sqlstate    text,
  message     text        not null,
  detail      text,
  hint        text,
  query       text,
  context     text,
  pid         integer,
  username    text,
  database    text,
  application text,
  -- Mensaje normalizado: mil errores del mismo insert con mil identificadores
  -- distintos son un problema, no mil.
  fingerprint text        not null,
  raw         text
) partition by range (at);

create table if not exists buho.log_events_default
  partition of buho.log_events default;

create index if not exists log_events_lookup on buho.log_events (instance_id, at desc);
create index if not exists log_events_kind on buho.log_events (instance_id, kind, at desc);
create index if not exists log_events_group on buho.log_events (instance_id, fingerprint, at desc);

-- Releer el mismo tramo tiene que ser inofensivo: al arrancar sin cursor se
-- vuelve atrás una ventana para no perder lo ocurrido mientras el colector
-- estaba caído, y eso solapa con lo ya guardado.
create unique index if not exists log_events_identity
  on buho.log_events (instance_id, at, kind, fingerprint, pid) nulls not distinct;

-- Desde dónde seguir leyendo, y qué se pudo leer.
--
-- El cursor de journald continúa exactamente donde se quedó; para archivos es
-- nombre y desplazamiento en bytes. Los avisos se guardan para que la consola
-- pueda explicar una pantalla vacía en vez de dejar dudando si no hay errores o
-- si no se pudo leer.
create table if not exists buho.log_cursors (
  instance_id bigint      primary key references buho.instances (instance_id) on delete cascade,
  source      text        not null,
  cursor      text,
  detail      text,
  warnings    jsonb       not null default '[]',
  read_at     timestamptz not null default now(),
  entries     bigint      not null default 0
);


-- --------------------------------------------------- planes de ejecución

-- Encargos de EXPLAIN.
--
-- La consola **no** se conecta a las instancias monitoreadas: sólo lee este
-- store. Un plan de ejecución rompería esa frontera, porque es una pregunta que
-- hay que hacerle a la base viva. La solución es una cola: la web escribe el
-- encargo, el colector —que ya tiene las credenciales y el pool abierto— lo
-- ejecuta y deja el resultado acá.
--
-- Cuesta un segundo de espera y gana tres cosas: las credenciales de las bases
-- del cliente siguen existiendo en un solo proceso, cada plan queda con quién
-- lo pidió, y la tabla es además el historial de planes —que es justo lo que se
-- necesita para responder "esta consulta se puso lenta el martes, ¿le cambió el
-- plan?".
create table if not exists buho.plan_requests (
  request_id   bigint      generated always as identity primary key,
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  -- Puede ser null: también se explican consultas escritas a mano, no sólo las
  -- que vienen de pg_stat_statements.
  queryid      bigint,
  sql          text        not null,
  mode         text        not null check (mode in ('estimate', 'generic', 'analyze')),
  state        text        not null default 'pendiente'
    check (state in ('pendiente', 'corriendo', 'listo', 'error')),
  requested_by text        not null,
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text,
  plan         jsonb,
  plan_text    text,
  findings     jsonb       not null default '[]',
  planning_ms  double precision,
  execution_ms double precision,
  total_cost   double precision
);

-- El colector busca sólo pendientes, así que el índice parcial se mantiene
-- diminuto por más que la tabla acumule meses de historial.
create index if not exists plan_requests_pending_idx
  on buho.plan_requests (requested_at)
  where state in ('pendiente', 'corriendo');

create index if not exists plan_requests_history_idx
  on buho.plan_requests (instance_id, queryid, requested_at desc);

-- --------------------------------------------------- bloat medido: pgstattuple
--
-- La pantalla de vacuum estima el bloat con el ancho promedio de tupla, que es
-- gratis pero se equivoca cuando las filas son de tamaño muy variable. La
-- medida real la da pgstattuple, y cuesta una lectura completa de la tabla: en
-- una de 200 GB eso es media hora de I/O que nadie pidió.
--
-- Por eso es a demanda y en cola, igual que el EXPLAIN: el operador elige la
-- tabla, ve lo que va a costar antes de aceptar, y el colector la mide de a una.
create table if not exists buho.bloat_requests (
  request_id   bigint      generated always as identity primary key,
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  schema_name  text        not null,
  table_name   text        not null,
  -- 'exacto' lee toda la tabla; 'aproximado' usa pgstattuple_approx, que sólo
  -- visita el mapa de visibilidad y las páginas sucias.
  mode         text        not null check (mode in ('exacto', 'aproximado')),
  state        text        not null default 'pendiente'
    check (state in ('pendiente', 'corriendo', 'listo', 'error')),
  requested_by text        not null,
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text,
  -- Lo que devuelve pgstattuple, en las unidades en que lo devuelve.
  table_bytes    bigint,
  tuple_count    bigint,
  tuple_bytes    bigint,
  dead_count     bigint,
  dead_bytes     bigint,
  free_bytes     bigint,
  free_pct       double precision,
  dead_pct       double precision,
  -- Lo que la estimación decía antes de medir, para poder comparar las dos.
  estimated_pct  double precision
);

create index if not exists bloat_requests_pending_idx
  on buho.bloat_requests (requested_at)
  where state in ('pendiente', 'corriendo');

create index if not exists bloat_requests_history_idx
  on buho.bloat_requests (instance_id, schema_name, table_name, requested_at desc);

-- ------------------------------------------------- consola: usuarios y ajustes

-- Dos roles y nada más: admin y viewer.
--
-- Un modelo de permisos por recurso es lo que convierte una herramienta interna
-- en un proyecto de administración de accesos. La pregunta real de un equipo de
-- base de datos es más simple: quién puede *cambiar* cosas (retención, cuentas,
-- lanzar un descubrimiento) y quién sólo mira. Todo lo demás —qué instancias ve
-- cada quien— se puede agregar después sobre las etiquetas si alguien lo pide.
create table if not exists buho.users (
  user_id       bigint      generated always as identity primary key,
  username      text        not null unique,
  -- scrypt: sal y derivada, ambas en hex, separadas por ':'. Ver users.ts.
  password_hash text        not null,
  role          text        not null check (role in ('admin', 'viewer')),
  disabled      boolean     not null default false,
  created_at    timestamptz not null default now(),
  created_by    text,
  last_login_at timestamptz
);

-- Ajustes editables desde la consola. Hoy sólo retención, pero el patrón sirve
-- para cualquier knob que no deba requerir editar un archivo y reiniciar.
create table if not exists buho.settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Resultado del descubrimiento de red. Acumula: lo que se vio una vez sigue
-- listado con su last_seen_at, porque "esto apareció el martes y ya no está" es
-- justo la clase de cosa que interesa de un parque.
create table if not exists buho.discovered (
  host          text        not null,
  port          integer     not null,
  engine        text        not null,
  version_text  text,
  banner        text,
  latency_ms    integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Notas del operador: "es el servidor de pruebas de Juan, no monitorear".
  note          text,
  ignored       boolean     not null default false,
  primary key (host, port)
);

-- Bitácora de la consola: quién cambió qué. Separada de collector_events porque
-- esos son del proceso de recolección y estos son de personas.
create table if not exists buho.console_events (
  event_id   bigint      generated always as identity primary key,
  at         timestamptz not null default now(),
  username   text        not null,
  action     text        not null,
  detail     text        not null default ''
);

create index if not exists console_events_at_idx on buho.console_events (at desc);

-- ------------------------------------------------------ targets from the UI
--
-- Instances declared in config.json still work. Targets added from the console
-- live here so the operator does not have to edit a file and restart by hand.
-- The collector merges both sources every 30s (config wins on alias clash).
-- Passwords are stored in plaintext like config.json — this is an on-prem store
-- already holding credentials; encrypting only this table would be theatre.
create table if not exists buho.monitor_targets (
  target_id    bigint generated always as identity primary key,
  tenant       text        not null default 'default',
  alias        text        not null,
  engine       text        not null
               check (engine in ('postgres', 'mariadb', 'mssql', 'mongodb')),
  host         text        not null,
  port         integer     not null,
  database     text        not null default '',
  username     text        not null,
  password     text        not null default '',
  environment  text        not null default 'prod',
  ssl          boolean     not null default false,
  tags         jsonb       not null default '{}'::jsonb,
  enabled      boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   text,
  unique (tenant, alias)
);

create index if not exists monitor_targets_enabled_idx
  on buho.monitor_targets (enabled) where enabled;

-- Host metrics (CPU/mem/disk) declared from the console — same shape as config.json hostMetrics.
alter table buho.monitor_targets add column if not exists host_metrics jsonb not null default '{}'::jsonb;

-- Allow MongoDB on the instances table (older installs had a narrower check).
alter table buho.instances drop constraint if exists instances_engine_check;
alter table buho.instances
  add constraint instances_engine_check
  check (engine in ('postgres', 'mariadb', 'mssql', 'mongodb'));

-- --------------------------------------------------- registro de operaciones

create table if not exists buho.collector_events (
  event_id    bigint      generated always as identity primary key,
  instance_id bigint      references buho.instances (instance_id) on delete cascade,
  ts          timestamptz not null default now(),
  level       text        not null check (level in ('info', 'warn', 'error')),
  component   text        not null,
  message     text        not null,
  detail      jsonb,
  status      text        not null default 'open'
              check (status in ('open', 'acknowledged', 'resolved')),
  acked_at    timestamptz,
  acked_by    text
);

create index if not exists collector_events_ts on buho.collector_events (ts desc);

-- Older installs: add triage columns without rewriting history.
alter table buho.collector_events add column if not exists status text not null default 'open';
alter table buho.collector_events add column if not exists acked_at timestamptz;
alter table buho.collector_events add column if not exists acked_by text;
alter table buho.collector_events drop constraint if exists collector_events_status_check;
alter table buho.collector_events
  add constraint collector_events_status_check
  check (status in ('open', 'acknowledged', 'resolved'));

create index if not exists collector_events_open_idx
  on buho.collector_events (ts desc) where status = 'open';

-- ---------------------------------------------------- particiones y limpieza

-- Crea las particiones diarias que faltan de cualquier tabla particionada por
-- rango sobre ts, desde ayer hasta days_ahead. Genérica a propósito: hay dos
-- Creates daily range partitions for a parent table a few days ahead.
--
-- Bounds must stay consistent with partitions already attached. Casting a
-- `date` to `timestamptz` uses the session TimeZone; if that drifts from the
-- timezone used when older partitions were created (e.g. lab store on UTC vs
-- earlier America/Costa_Rica midnight → 06:00 UTC), CREATE fails with
-- "would overlap partition …" and the whole maintenance cycle aborts — which
-- also stops rollups and empties 24h charts that read metric_rollup_5m.
create or replace function buho.ensure_partitions(parent text, days_ahead integer default 3)
returns integer
language plpgsql
as $$
declare
  day            date;
  part_name      text;
  default_name   text := parent || '_default';
  key_column     text;
  has_rows       boolean;
  created        integer := 0;
  day_from       timestamptz;
  day_to         timestamptz;
  sample_from    timestamptz;
  sample_name    text;
  sample_day     date;
  bound_offset   interval := interval '0';
begin
  select a.attname
    into key_column
    from pg_partitioned_table p
    join pg_class c on c.oid = p.partrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = p.partattrs[0]
   where n.nspname = 'buho' and c.relname = parent;

  if key_column is null then
    raise exception 'buho.% is not a partitioned table', parent;
  end if;

  -- Learn the clock offset from the newest existing day partition, if any.
  select c.relname,
         (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                       E'FROM \\(''([^'']+)''\\)'))[1]::timestamptz
    into sample_name, sample_from
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_inherits i on i.inhrelid = c.oid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace pn on pn.oid = p.relnamespace
   where n.nspname = 'buho'
     and pn.nspname = 'buho'
     and p.relname = parent
     and c.relname ~ ('^' || parent || '_[0-9]{8}$')
   order by c.relname desc
   limit 1;

  if sample_from is not null and sample_name is not null then
    sample_day := to_date(right(sample_name, 8), 'YYYYMMDD');
    bound_offset := sample_from - (sample_day::timestamp AT TIME ZONE 'UTC');
  end if;

  for day in
    select generate_series(
             (timezone('utc', now()))::date - 1,
             (timezone('utc', now()))::date + days_ahead,
             interval '1 day'
           )::date
  loop
    part_name := format('%s_%s', parent, to_char(day, 'YYYYMMDD'));
    continue when exists (
      select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'buho' and c.relname = part_name
    );

    day_from := (day::timestamp AT TIME ZONE 'UTC') + bound_offset;
    day_to   := ((day + 1)::timestamp AT TIME ZONE 'UTC') + bound_offset;

    -- PostgreSQL rejects a range partition that would cover rows already in
    -- DEFAULT. Detach → create → move → reattach when that happens.
    execute format(
      'select exists (select 1 from buho.%I where %I >= %L::timestamptz and %I < %L::timestamptz)',
      default_name, key_column, day_from, key_column, day_to
    ) into has_rows;

    if has_rows then
      execute format('alter table buho.%I detach partition buho.%I', parent, default_name);
      execute format(
        'create table buho.%I partition of buho.%I for values from (%L::timestamptz) to (%L::timestamptz)',
        part_name, parent, day_from, day_to
      );
      execute format(
        'insert into buho.%I select * from buho.%I where %I >= %L::timestamptz and %I < %L::timestamptz',
        parent, default_name, key_column, day_from, key_column, day_to
      );
      execute format(
        'delete from buho.%I where %I >= %L::timestamptz and %I < %L::timestamptz',
        default_name, key_column, day_from, key_column, day_to
      );
      execute format('alter table buho.%I attach partition buho.%I default', parent, default_name);
    else
      execute format(
        'create table buho.%I partition of buho.%I for values from (%L::timestamptz) to (%L::timestamptz)',
        part_name, parent, day_from, day_to
      );
    end if;

    created := created + 1;
  end loop;
  return created;
end;
$$;

-- Recalcula las líneas base desde el rollup horario.
--
-- Se recalcula entera y no de forma incremental: son unas pocas miles de filas
-- por instancia, y el cálculo incremental de un percentil sobre una ventana
-- móvil pide guardar la distribución, que cuesta más que rehacer la cuenta.
--
-- Sólo métricas sin etiquetas: una línea base por tabla o por base de datos
-- multiplica las filas por cien y no contesta preguntas distintas de las que ya
-- contesta la métrica global.
create or replace function buho.build_baselines(weeks integer default 4)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
  written  integer;
  desde    timestamptz := now() - (weeks || ' weeks')::interval;
begin
  insert into buho.metric_baselines
        (instance_id, metric, scope, dow, hour, samples, p10, p50, p90, avg_value, max_value, computed_at)
  select instance_id, metric, 'hora_semana',
         extract(dow  from bucket)::smallint,
         extract(hour from bucket)::smallint,
         count(*),
         percentile_cont(0.10) within group (order by avg_value),
         percentile_cont(0.50) within group (order by avg_value),
         percentile_cont(0.90) within group (order by avg_value),
         avg(avg_value),
         max(max_value),
         now()
    from buho.metric_rollup_1h
   where bucket >= desde
     and labels = '{}'::jsonb
   group by 1, 2, 4, 5
      on conflict (instance_id, metric, scope, dow, hour) do update
         set samples = excluded.samples,
             p10 = excluded.p10,
             p50 = excluded.p50,
             p90 = excluded.p90,
             avg_value = excluded.avg_value,
             max_value = excluded.max_value,
             computed_at = excluded.computed_at;
  get diagnostics written = row_count;
  affected := affected + written;

  insert into buho.metric_baselines
        (instance_id, metric, scope, dow, hour, samples, p10, p50, p90, avg_value, max_value, computed_at)
  select instance_id, metric, 'hora_dia',
         -1::smallint,
         extract(hour from bucket)::smallint,
         count(*),
         percentile_cont(0.10) within group (order by avg_value),
         percentile_cont(0.50) within group (order by avg_value),
         percentile_cont(0.90) within group (order by avg_value),
         avg(avg_value),
         max(max_value),
         now()
    from buho.metric_rollup_1h
   where bucket >= desde
     and labels = '{}'::jsonb
   group by 1, 2, 5
      on conflict (instance_id, metric, scope, dow, hour) do update
         set samples = excluded.samples,
             p10 = excluded.p10,
             p50 = excluded.p50,
             p90 = excluded.p90,
             avg_value = excluded.avg_value,
             max_value = excluded.max_value,
             computed_at = excluded.computed_at;
  get diagnostics written = row_count;
  affected := affected + written;

  -- Lo que quedó fuera de la ventana ya no describe lo normal de hoy.
  delete from buho.metric_baselines where computed_at < now() - interval '2 days';

  return affected;
end;
$$;

-- Purga por DROP de partición, no por DELETE.
create or replace function buho.prune_partitions(parent text, keep_days integer default 7)
returns integer
language plpgsql
as $$
declare
  rec      record;
  dropped  integer := 0;
  cutoff   date := current_date - keep_days;
begin
  for rec in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'buho'
       and c.relname ~ ('^' || parent || '_[0-9]{8}$')
       and to_date(right(c.relname, 8), 'YYYYMMDD') < cutoff
  loop
    execute format('drop table if exists buho.%I', rec.relname);
    dropped := dropped + 1;
  end loop;
  return dropped;
end;
$$;

drop function if exists buho.ensure_metric_partitions(integer);
drop function if exists buho.prune_metric_partitions(integer);

-- Agrega las muestras crudas en buckets. Idempotente por la PK del rollup.
create or replace function buho.build_rollups(since interval default interval '2 hours')
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
  written  integer;
begin
  insert into buho.metric_rollup_5m
        (instance_id, bucket, metric, labels, samples, avg_value, min_value, max_value)
  select instance_id,
         date_bin('5 minutes', ts, timestamptz 'epoch'),
         metric, labels,
         count(*), avg(value), min(value), max(value)
    from buho.metric_samples
   where ts >= now() - since
   group by 1, 2, 3, 4
      on conflict (instance_id, metric, labels, bucket) do update
         set samples   = excluded.samples,
             avg_value = excluded.avg_value,
             min_value = excluded.min_value,
             max_value = excluded.max_value;
  get diagnostics written = row_count;
  affected := affected + written;

  insert into buho.metric_rollup_1h
        (instance_id, bucket, metric, labels, samples, avg_value, min_value, max_value)
  select instance_id,
         date_bin('1 hour', bucket, timestamptz 'epoch'),
         metric, labels,
         sum(samples)::integer,
         sum(avg_value * samples) / nullif(sum(samples), 0),
         min(min_value), max(max_value)
    from buho.metric_rollup_5m
   where bucket >= now() - greatest(since, interval '2 hours')
   group by 1, 2, 3, 4
      on conflict (instance_id, metric, labels, bucket) do update
         set samples   = excluded.samples,
             avg_value = excluded.avg_value,
             min_value = excluded.min_value,
             max_value = excluded.max_value;
  get diagnostics written = row_count;
  affected := affected + written;

  return affected;
end;
$$;

-- ------------------------------------------------------------------- alerts
--
-- Búho owns its own alerting (product decision 2026-09-03): checks produce
-- findings; this layer decides when to fire, silence, and deliver. Webhook
-- first; SMTP can reuse the same delivery queue later.

create table if not exists buho.alert_channels (
  channel_id  bigint      generated always as identity primary key,
  name        text        not null,
  kind        text        not null   check (kind in (
    'webhook', 'slack', 'teams', 'discord', 'googlechat', 'mattermost',
    'telegram', 'rocketchat', 'pagerduty', 'smtp'
  )),
  config      jsonb       not null default '{}',
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Drop rocketchat-only experiment rows used a different shape; widen kind check.
delete from buho.alert_channels where kind not in (
  'webhook', 'slack', 'teams', 'discord', 'googlechat', 'mattermost',
  'telegram', 'rocketchat', 'pagerduty', 'smtp'
);
alter table buho.alert_channels drop constraint if exists alert_channels_kind_check;
alter table buho.alert_channels
  add constraint alert_channels_kind_check
  check (kind in (
    'webhook', 'slack', 'teams', 'discord', 'googlechat', 'mattermost',
    'telegram', 'rocketchat', 'pagerduty', 'smtp'
  ));

create table if not exists buho.alerts (
  alert_id       bigint      generated always as identity primary key,
  instance_id    bigint      not null references buho.instances (instance_id) on delete cascade,
  dedupe_key     text        not null,
  check_id       text        not null,
  object         text,
  severity       text        not null check (severity in ('critical', 'warning', 'info')),
  title          text        not null,
  message        text        not null,
  remediation    text        not null,
  status         text        not null check (status in ('pending', 'firing', 'resolved')),
  pending_count  integer     not null default 0,
  fired_at       timestamptz,
  resolved_at    timestamptz,
  last_seen_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (instance_id, dedupe_key)
);

create index if not exists alerts_open_lookup
  on buho.alerts (status, severity, last_seen_at desc)
  where status in ('pending', 'firing');

create table if not exists buho.alert_silences (
  silence_id   bigint      generated always as identity primary key,
  instance_id  bigint      references buho.instances (instance_id) on delete cascade,
  check_id     text,
  reason       text        not null,
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  created_by   text,
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists alert_silences_active
  on buho.alert_silences (ends_at);

create table if not exists buho.alert_deliveries (
  delivery_id     bigint      generated always as identity primary key,
  alert_id        bigint      not null references buho.alerts (alert_id) on delete cascade,
  channel_id      bigint      not null references buho.alert_channels (channel_id) on delete cascade,
  event           text        not null check (event in ('fired', 'resolved')),
  status          text        not null check (status in ('pending', 'sent', 'failed')),
  attempts        integer     not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists alert_deliveries_pending
  on buho.alert_deliveries (next_attempt_at)
  where status = 'pending';

-- Per-check / per-instance routing. First matching rule by priority wins.
create table if not exists buho.alert_rules (
  rule_id            bigint      generated always as identity primary key,
  name               text        not null,
  enabled            boolean     not null default true,
  match_check_id     text,
  match_instance_id  bigint      references buho.instances (instance_id) on delete cascade,
  match_engine       text,
  match_severities   text[]      not null default array['critical','warning'],
  action             text        not null default 'alert'
                       check (action in ('alert', 'suppress')),
  hysteresis         integer     check (hysteresis is null or hysteresis between 1 and 20),
  severity_override  text        check (severity_override is null
                                   or severity_override in ('critical', 'warning', 'info')),
  channel_ids        bigint[]    not null default '{}',
  notify_resolved    boolean     not null default true,
  priority           integer     not null default 100,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         text
);

create index if not exists alert_rules_lookup
  on buho.alert_rules (enabled, priority, match_check_id, match_instance_id);

-- Custom SQL alerts (prod Sys_Alerts granularity): named query + threshold_type.
-- check_id in buho.alerts becomes custom.<name>. Scope with instance and/or engine.
create table if not exists buho.alert_definitions (
  definition_id      bigint      generated always as identity primary key,
  name               text        not null,
  title              text        not null,
  enabled            boolean     not null default true,
  match_instance_id  bigint      references buho.instances (instance_id) on delete cascade,
  match_engine       text,
  severity           text        not null check (severity in ('critical', 'warning', 'info')),
  sql                text        not null,
  threshold_type     text        not null
                       check (threshold_type in (
                         'rows', 'no_rows', 'numeric', 'freshness', 'text_match',
                         'numeric_per_row', 'numeric_max_across_rows', 'delta'
                       )),
  threshold          jsonb       not null default '{}'::jsonb,
  message_template   text        not null,
  remediation        text        not null default '',
  recovery_message   text,
  send_recovery      boolean     not null default true,
  cooldown_minutes   integer     not null default 0 check (cooldown_minutes >= 0),
  display_columns    text[]      not null default '{}',
  hysteresis         integer     check (hysteresis is null or hysteresis between 1 and 20),
  channel_ids        bigint[]    not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         text,
  unique (name),
  check (match_instance_id is not null or match_engine is not null)
);

create index if not exists alert_definitions_scope
  on buho.alert_definitions (enabled, match_engine, match_instance_id);

