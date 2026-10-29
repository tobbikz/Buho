-- Paste into packages/store/src/schema.sql (Deep Platform — DDL audit trail)
-- Collector persists rows via store.saveDdlEvents (wired separately).

create table if not exists buho.ddl_events (
  ddl_event_id  bigint generated always as identity primary key,
  instance_id   bigint      not null references buho.instances (instance_id) on delete cascade,
  at            timestamptz not null,
  command_tag   text        not null,
  object_name   text        not null,
  sql_text      text        not null,
  captured_at   timestamptz not null default now()
);

create index if not exists ddl_events_instance_at
  on buho.ddl_events (instance_id, at desc);
