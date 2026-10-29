-- Canonical shape matches packages/store/src/schema.sql (applied by migrate).
-- Kept as a readable fragment for operators applying DDL by hand.

create table if not exists buho.ddl_events (
  ddl_id       bigint generated always as identity primary key,
  instance_id  bigint      not null references buho.instances (instance_id) on delete cascade,
  at           timestamptz not null default now(),
  command_tag  text        not null,
  object_name  text,
  sql          text,
  username     text,
  database     text
);

create index if not exists ddl_events_lookup
  on buho.ddl_events (instance_id, at desc);
