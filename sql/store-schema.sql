-- Schema-only dump of buho store (partition children omitted)
-- Generated: 2026-11-20T09:58:05-06:00
-- Source volume: buho_buho_store
-- Full partition DDL: sql/store-schema-full-with-partitions.sql

--
-- PostgreSQL database dump
--

\restrict ZNZuQQv481VqsteEXBPF5d4ccIhXSeTpgNf4e6IdKAdi9KCxDePWRfZJz22akUO

-- Dumped from database version 18.7
-- Dumped by pg_dump version 18.7

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: buho; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA buho;


--
-- Name: pgstattuple; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgstattuple WITH SCHEMA buho;


--
-- Name: EXTENSION pgstattuple; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgstattuple IS 'show tuple-level statistics';


--
-- Name: build_baselines(integer); Type: FUNCTION; Schema: buho; Owner: -
--

CREATE FUNCTION buho.build_baselines(weeks integer DEFAULT 4) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: build_rollups(interval); Type: FUNCTION; Schema: buho; Owner: -
--

CREATE FUNCTION buho.build_rollups(since interval DEFAULT '02:00:00'::interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: ensure_partitions(text, integer); Type: FUNCTION; Schema: buho; Owner: -
--

CREATE FUNCTION buho.ensure_partitions(parent text, days_ahead integer DEFAULT 3) RETURNS integer
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: prune_partitions(text, integer); Type: FUNCTION; Schema: buho; Owner: -
--

CREATE FUNCTION buho.prune_partitions(parent text, keep_days integer DEFAULT 7) RETURNS integer
    LANGUAGE plpgsql
    AS $_$
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
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alert_channels; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alert_channels (
    channel_id bigint NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_channels_kind_check CHECK ((kind = ANY (ARRAY['webhook'::text, 'slack'::text, 'teams'::text, 'discord'::text, 'googlechat'::text, 'mattermost'::text, 'telegram'::text, 'rocketchat'::text, 'pagerduty'::text, 'smtp'::text])))
);


--
-- Name: alert_channels_channel_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alert_channels ALTER COLUMN channel_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alert_channels_channel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alert_definitions; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alert_definitions (
    definition_id bigint NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    match_instance_id bigint,
    match_engine text,
    severity text NOT NULL,
    sql text NOT NULL,
    threshold_type text NOT NULL,
    threshold jsonb DEFAULT '{}'::jsonb NOT NULL,
    message_template text NOT NULL,
    remediation text DEFAULT ''::text NOT NULL,
    recovery_message text,
    send_recovery boolean DEFAULT true NOT NULL,
    cooldown_minutes integer DEFAULT 0 NOT NULL,
    display_columns text[] DEFAULT '{}'::text[] NOT NULL,
    hysteresis integer,
    channel_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT alert_definitions_check CHECK (((match_instance_id IS NOT NULL) OR (match_engine IS NOT NULL))),
    CONSTRAINT alert_definitions_cooldown_minutes_check CHECK ((cooldown_minutes >= 0)),
    CONSTRAINT alert_definitions_hysteresis_check CHECK (((hysteresis IS NULL) OR ((hysteresis >= 1) AND (hysteresis <= 20)))),
    CONSTRAINT alert_definitions_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT alert_definitions_threshold_type_check CHECK ((threshold_type = ANY (ARRAY['rows'::text, 'no_rows'::text, 'numeric'::text, 'freshness'::text, 'text_match'::text, 'numeric_per_row'::text, 'numeric_max_across_rows'::text, 'delta'::text])))
);


--
-- Name: alert_definitions_definition_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alert_definitions ALTER COLUMN definition_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alert_definitions_definition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alert_deliveries; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alert_deliveries (
    delivery_id bigint NOT NULL,
    alert_id bigint NOT NULL,
    channel_id bigint NOT NULL,
    event text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_deliveries_event_check CHECK ((event = ANY (ARRAY['fired'::text, 'resolved'::text]))),
    CONSTRAINT alert_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: alert_deliveries_delivery_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alert_deliveries ALTER COLUMN delivery_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alert_deliveries_delivery_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alert_rules; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alert_rules (
    rule_id bigint NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    match_check_id text,
    match_instance_id bigint,
    match_engine text,
    match_severities text[] DEFAULT ARRAY['critical'::text, 'warning'::text] NOT NULL,
    action text DEFAULT 'alert'::text NOT NULL,
    hysteresis integer,
    severity_override text,
    channel_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    notify_resolved boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT alert_rules_action_check CHECK ((action = ANY (ARRAY['alert'::text, 'suppress'::text]))),
    CONSTRAINT alert_rules_hysteresis_check CHECK (((hysteresis IS NULL) OR ((hysteresis >= 1) AND (hysteresis <= 20)))),
    CONSTRAINT alert_rules_severity_override_check CHECK (((severity_override IS NULL) OR (severity_override = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))))
);


--
-- Name: alert_rules_rule_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alert_rules ALTER COLUMN rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alert_rules_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alert_silences; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alert_silences (
    silence_id bigint NOT NULL,
    instance_id bigint,
    check_id text,
    reason text NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_silences_check CHECK ((ends_at > starts_at))
);


--
-- Name: alert_silences_silence_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alert_silences ALTER COLUMN silence_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alert_silences_silence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alerts; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.alerts (
    alert_id bigint NOT NULL,
    instance_id bigint NOT NULL,
    dedupe_key text NOT NULL,
    check_id text NOT NULL,
    object text,
    severity text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    remediation text NOT NULL,
    status text NOT NULL,
    pending_count integer DEFAULT 0 NOT NULL,
    fired_at timestamp with time zone,
    resolved_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alerts_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT alerts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'firing'::text, 'resolved'::text])))
);


--
-- Name: alerts_alert_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.alerts ALTER COLUMN alert_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.alerts_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: backup_state; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.backup_state (
    instance_id bigint NOT NULL,
    database text NOT NULL,
    kind text NOT NULL,
    finished_at timestamp with time zone,
    size_bytes bigint,
    source text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bloat_requests; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.bloat_requests (
    request_id bigint NOT NULL,
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    mode text NOT NULL,
    state text DEFAULT 'pendiente'::text NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error text,
    table_bytes bigint,
    tuple_count bigint,
    tuple_bytes bigint,
    dead_count bigint,
    dead_bytes bigint,
    free_bytes bigint,
    free_pct double precision,
    dead_pct double precision,
    estimated_pct double precision,
    CONSTRAINT bloat_requests_mode_check CHECK ((mode = ANY (ARRAY['exacto'::text, 'aproximado'::text]))),
    CONSTRAINT bloat_requests_state_check CHECK ((state = ANY (ARRAY['pendiente'::text, 'corriendo'::text, 'listo'::text, 'error'::text])))
);


--
-- Name: bloat_requests_request_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.bloat_requests ALTER COLUMN request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.bloat_requests_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: catalog_columns; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.catalog_columns (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    column_name text NOT NULL,
    data_type text NOT NULL,
    not_null boolean NOT NULL,
    "position" integer NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: catalog_tables; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.catalog_tables (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    size_bytes bigint NOT NULL,
    partitions integer DEFAULT 0 NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: check_results; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.check_results (
    check_result_id bigint NOT NULL,
    instance_id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    check_id text NOT NULL,
    title text NOT NULL,
    severity text NOT NULL,
    object text,
    message text NOT NULL,
    remediation text NOT NULL,
    value double precision,
    CONSTRAINT check_results_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))
);


--
-- Name: check_results_check_result_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.check_results ALTER COLUMN check_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.check_results_check_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collector_events; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.collector_events (
    event_id bigint NOT NULL,
    instance_id bigint,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    level text NOT NULL,
    component text NOT NULL,
    message text NOT NULL,
    detail jsonb,
    status text DEFAULT 'open'::text NOT NULL,
    acked_at timestamp with time zone,
    acked_by text,
    CONSTRAINT collector_events_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text]))),
    CONSTRAINT collector_events_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text])))
);


--
-- Name: collector_events_event_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.collector_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.collector_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collector_heartbeat; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.collector_heartbeat (
    component text NOT NULL,
    last_ok_at timestamp with time zone NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: console_events; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.console_events (
    event_id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    username text NOT NULL,
    action text NOT NULL,
    detail text DEFAULT ''::text NOT NULL
);


--
-- Name: console_events_event_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.console_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.console_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: discovered; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.discovered (
    host text NOT NULL,
    port integer NOT NULL,
    engine text NOT NULL,
    version_text text,
    banner text,
    latency_ms integer,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    ignored boolean DEFAULT false NOT NULL
);


--
-- Name: disk_objects; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.disk_objects (
    instance_id bigint NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    container text DEFAULT ''::text NOT NULL,
    size_bytes bigint,
    used_bytes bigint,
    free_bytes bigint,
    max_bytes bigint,
    location text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: engine_info; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.engine_info (
    instance_id bigint NOT NULL,
    engine text NOT NULL,
    version_num integer,
    version_text text NOT NULL,
    edition text,
    product_level text,
    update_level text,
    server_collation text,
    started_at timestamp with time zone,
    cores integer,
    memory_bytes bigint,
    eol_date date,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: health_scores; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.health_scores (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    score integer NOT NULL,
    critical integer DEFAULT 0 NOT NULL,
    warning integer DEFAULT 0 NOT NULL,
    info integer DEFAULT 0 NOT NULL,
    CONSTRAINT health_scores_score_check CHECK (((score >= 0) AND (score <= 100)))
);


--
-- Name: index_objects; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.index_objects (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    index_name text NOT NULL,
    size_bytes bigint NOT NULL,
    idx_scan bigint DEFAULT 0 NOT NULL,
    idx_tup_read bigint DEFAULT 0 NOT NULL,
    idx_tup_fetch bigint DEFAULT 0 NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_unique boolean DEFAULT false NOT NULL,
    is_valid boolean DEFAULT true NOT NULL,
    is_partial boolean DEFAULT false NOT NULL,
    has_expression boolean DEFAULT false NOT NULL,
    columns text[] DEFAULT '{}'::text[] NOT NULL,
    definition text,
    status text DEFAULT 'ok'::text NOT NULL,
    covered_by text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT index_objects_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'unused'::text, 'redundant'::text, 'invalid'::text])))
);


--
-- Name: infra_discovery; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.infra_discovery (
    discovery_id bigint NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    host text NOT NULL,
    icmp_ok boolean DEFAULT false NOT NULL,
    icmp_ms double precision,
    open_ports integer[] DEFAULT '{}'::integer[] NOT NULL,
    adopted boolean DEFAULT false NOT NULL
);


--
-- Name: infra_discovery_discovery_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.infra_discovery ALTER COLUMN discovery_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.infra_discovery_discovery_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: instance_capabilities; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.instance_capabilities (
    instance_id bigint NOT NULL,
    version_num integer NOT NULL,
    version_text text NOT NULL,
    in_recovery boolean NOT NULL,
    has_pg_monitor boolean NOT NULL,
    is_superuser boolean NOT NULL,
    track_io_timing boolean NOT NULL,
    stat_statements text NOT NULL,
    extensions jsonb DEFAULT '{}'::jsonb NOT NULL,
    server_started_at timestamp with time zone,
    probed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instance_capabilities_stat_statements_check CHECK ((stat_statements = ANY (ARRAY['active'::text, 'preloaded_not_created'::text, 'not_preloaded'::text])))
);


--
-- Name: instance_tags; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.instance_tags (
    instance_id bigint NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: instances; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.instances (
    instance_id bigint NOT NULL,
    tenant text DEFAULT 'default'::text NOT NULL,
    alias text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    database text NOT NULL,
    environment text DEFAULT 'prod'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    engine text DEFAULT 'postgres'::text NOT NULL,
    retired boolean DEFAULT false NOT NULL,
    CONSTRAINT instances_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text, 'mssql'::text, 'mongodb'::text, 'redis'::text, 'oracle'::text, 'cassandra'::text, 'elasticsearch'::text, 'endpoint'::text, 'infra'::text])))
);


--
-- Name: instances_instance_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.instances ALTER COLUMN instance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.instances_instance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_notes; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.inventory_notes (
    instance_id bigint NOT NULL,
    domain text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_notes_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.jobs (
    instance_id bigint NOT NULL,
    scope text DEFAULT ''::text NOT NULL,
    name text NOT NULL,
    enabled boolean,
    last_run_at timestamp with time zone,
    last_status text,
    last_duration_ms bigint,
    next_run_at timestamp with time zone,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: licensing; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.licensing (
    instance_id bigint NOT NULL,
    edition text,
    license_model text,
    cores integer,
    cores_limit integer,
    memory_bytes bigint,
    memory_limit_bytes bigint,
    production_ok boolean,
    note text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lock_episodes; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.lock_episodes (
    episode_id bigint NOT NULL,
    instance_id bigint NOT NULL,
    waiter_pid integer NOT NULL,
    waiter_query_start timestamp with time zone,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    samples integer DEFAULT 1 NOT NULL,
    wait_seconds double precision NOT NULL,
    waiter_user text,
    waiter_application text,
    waiter_database text,
    waiter_query text NOT NULL,
    wait_event_type text,
    wait_event text,
    lock_type text,
    lock_mode text,
    lock_object text,
    blocker_pids integer[] DEFAULT '{}'::integer[] NOT NULL,
    blocker_pid integer,
    blocker_state text,
    blocker_query text,
    blocker_user text,
    blocker_application text,
    blocker_xact_seconds double precision
);


--
-- Name: lock_episodes_episode_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.lock_episodes ALTER COLUMN episode_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.lock_episodes_episode_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log_cursors; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.log_cursors (
    instance_id bigint NOT NULL,
    source text NOT NULL,
    cursor text,
    detail text,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    entries bigint DEFAULT 0 NOT NULL
);


--
-- Name: log_events; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.log_events (
    instance_id bigint NOT NULL,
    at timestamp with time zone NOT NULL,
    level text NOT NULL,
    kind text NOT NULL,
    sqlstate text,
    message text NOT NULL,
    detail text,
    hint text,
    query text,
    context text,
    pid integer,
    username text,
    database text,
    application text,
    fingerprint text NOT NULL,
    raw text
)
PARTITION BY RANGE (at);


--
-- Name: metric_baselines; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.metric_baselines (
    instance_id bigint NOT NULL,
    metric text NOT NULL,
    scope text NOT NULL,
    dow smallint NOT NULL,
    hour smallint NOT NULL,
    samples integer NOT NULL,
    p10 double precision,
    p50 double precision,
    p90 double precision,
    avg_value double precision,
    max_value double precision,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT metric_baselines_hour_check CHECK (((hour >= 0) AND (hour <= 23))),
    CONSTRAINT metric_baselines_scope_check CHECK ((scope = ANY (ARRAY['hora_semana'::text, 'hora_dia'::text])))
);


--
-- Name: metric_rollup_1h; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.metric_rollup_1h (
    instance_id bigint NOT NULL,
    bucket timestamp with time zone NOT NULL,
    metric text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    samples integer NOT NULL,
    avg_value double precision NOT NULL,
    min_value double precision NOT NULL,
    max_value double precision NOT NULL
);


--
-- Name: metric_rollup_5m; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.metric_rollup_5m (
    instance_id bigint CONSTRAINT metric_rollup_5m_instance_id_not_null1 NOT NULL,
    bucket timestamp with time zone CONSTRAINT metric_rollup_5m_bucket_not_null1 NOT NULL,
    metric text CONSTRAINT metric_rollup_5m_metric_not_null1 NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb CONSTRAINT metric_rollup_5m_labels_not_null1 NOT NULL,
    samples integer CONSTRAINT metric_rollup_5m_samples_not_null1 NOT NULL,
    avg_value double precision CONSTRAINT metric_rollup_5m_avg_value_not_null1 NOT NULL,
    min_value double precision CONSTRAINT metric_rollup_5m_min_value_not_null1 NOT NULL,
    max_value double precision CONSTRAINT metric_rollup_5m_max_value_not_null1 NOT NULL
)
PARTITION BY RANGE (bucket);


--
-- Name: metric_samples; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.metric_samples (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    metric text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    value double precision NOT NULL
)
PARTITION BY RANGE (ts);


--
-- Name: monitor_targets; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.monitor_targets (
    target_id bigint NOT NULL,
    tenant text DEFAULT 'default'::text NOT NULL,
    alias text NOT NULL,
    engine text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    database text DEFAULT ''::text NOT NULL,
    username text NOT NULL,
    password text DEFAULT ''::text NOT NULL,
    environment text DEFAULT 'prod'::text NOT NULL,
    ssl boolean DEFAULT false NOT NULL,
    tags jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    host_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    endpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT monitor_targets_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text, 'mssql'::text, 'mongodb'::text, 'redis'::text, 'oracle'::text, 'cassandra'::text, 'elasticsearch'::text, 'endpoint'::text, 'infra'::text])))
);


--
-- Name: monitor_targets_target_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.monitor_targets ALTER COLUMN target_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.monitor_targets_target_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mssql_heap_pressure; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.mssql_heap_pressure (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    forwarded_fetch_count bigint DEFAULT 0 NOT NULL,
    write_count bigint DEFAULT 0 NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mssql_index_fragmentation; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.mssql_index_fragmentation (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    index_name text NOT NULL,
    fragmentation_pct double precision NOT NULL,
    page_count bigint NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: obs_service_tags; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.obs_service_tags (
    entity_kind text NOT NULL,
    entity_key text NOT NULL,
    tag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT obs_service_tags_entity_kind_check CHECK ((entity_kind = ANY (ARRAY['apm'::text, 'synthetics'::text]))),
    CONSTRAINT obs_service_tags_tag_check CHECK (((char_length(TRIM(BOTH FROM tag)) > 0) AND (char_length(tag) <= 64)))
);


--
-- Name: otlp_log_records; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.otlp_log_records (
    log_pk bigint NOT NULL,
    time_unix_nano text NOT NULL,
    observed_ts timestamp with time zone NOT NULL,
    severity_text text DEFAULT ''::text NOT NULL,
    severity_number integer DEFAULT 0 NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    service_name text DEFAULT 'unknown'::text NOT NULL,
    trace_id text,
    span_id text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: otlp_log_records_log_pk_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.otlp_log_records ALTER COLUMN log_pk ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.otlp_log_records_log_pk_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: otlp_spans; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.otlp_spans (
    span_pk bigint NOT NULL,
    trace_id text NOT NULL,
    span_id text NOT NULL,
    parent_span_id text,
    name text NOT NULL,
    kind text DEFAULT 'INTERNAL'::text NOT NULL,
    service_name text NOT NULL,
    start_ts timestamp with time zone NOT NULL,
    end_ts timestamp with time zone NOT NULL,
    duration_ms double precision NOT NULL,
    status_code text DEFAULT 'UNSET'::text NOT NULL,
    status_message text,
    http_method text,
    http_url text,
    http_status integer,
    sql_text text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: otlp_spans_span_pk_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.otlp_spans ALTER COLUMN span_pk ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.otlp_spans_span_pk_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: otlp_traces; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.otlp_traces (
    trace_id text NOT NULL,
    root_service text,
    root_name text,
    start_ts timestamp with time zone NOT NULL,
    end_ts timestamp with time zone NOT NULL,
    duration_ms double precision NOT NULL,
    span_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    has_sql boolean DEFAULT false NOT NULL,
    http_status integer,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: overview_layouts; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.overview_layouts (
    username text NOT NULL,
    instance_id bigint NOT NULL,
    layout jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plan_requests; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.plan_requests (
    request_id bigint NOT NULL,
    instance_id bigint NOT NULL,
    queryid bigint,
    sql text NOT NULL,
    mode text NOT NULL,
    state text DEFAULT 'pendiente'::text NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error text,
    plan jsonb,
    plan_text text,
    findings jsonb DEFAULT '[]'::jsonb NOT NULL,
    planning_ms double precision,
    execution_ms double precision,
    total_cost double precision,
    CONSTRAINT plan_requests_mode_check CHECK ((mode = ANY (ARRAY['estimate'::text, 'generic'::text, 'analyze'::text]))),
    CONSTRAINT plan_requests_state_check CHECK ((state = ANY (ARRAY['pendiente'::text, 'corriendo'::text, 'listo'::text, 'error'::text])))
);


--
-- Name: plan_requests_request_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.plan_requests ALTER COLUMN request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.plan_requests_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: procedure_slow_events; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.procedure_slow_events (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    object_id bigint NOT NULL,
    database text,
    schema_name text,
    proc_name text NOT NULL,
    duration_sec double precision NOT NULL
);


--
-- Name: procedure_stats; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.procedure_stats (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    object_id bigint NOT NULL,
    database text,
    calls double precision NOT NULL,
    exec_ms double precision NOT NULL,
    worker_ms double precision DEFAULT 0 NOT NULL,
    logical_reads double precision DEFAULT 0 NOT NULL,
    avg_duration_sec double precision
)
PARTITION BY RANGE (ts);


--
-- Name: procedure_texts; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.procedure_texts (
    instance_id bigint NOT NULL,
    object_id bigint NOT NULL,
    database text NOT NULL,
    schema_name text NOT NULL,
    proc_name text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: query_actors; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.query_actors (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    queryid bigint NOT NULL,
    application text NOT NULL,
    username text NOT NULL,
    database text NOT NULL,
    samples integer NOT NULL
)
PARTITION BY RANGE (ts);


--
-- Name: replication_state; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.replication_state (
    instance_id bigint NOT NULL,
    role text NOT NULL,
    peer text DEFAULT ''::text NOT NULL,
    state text,
    lag_bytes bigint,
    lag_seconds double precision,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_cases; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.security_cases (
    case_id bigint NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    severity text DEFAULT 'media'::text NOT NULL,
    assignee text,
    finding_keys jsonb DEFAULT '[]'::jsonb NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_cases_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acked'::text, 'closed'::text])))
);


--
-- Name: security_cases_case_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.security_cases ALTER COLUMN case_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.security_cases_case_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: security_findings; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.security_findings (
    instance_id bigint NOT NULL,
    check_id text NOT NULL,
    category text NOT NULL,
    severity text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    remediation text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_findings_severity_check CHECK ((severity = ANY (ARRAY['critica'::text, 'alta'::text, 'media'::text, 'baja'::text, 'ok'::text, 'no_verificable'::text])))
);


--
-- Name: security_posture; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.security_posture (
    instance_id bigint NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    score integer NOT NULL,
    critical integer DEFAULT 0 NOT NULL,
    high integer DEFAULT 0 NOT NULL,
    medium integer DEFAULT 0 NOT NULL,
    low integer DEFAULT 0 NOT NULL,
    verified integer DEFAULT 0 NOT NULL,
    total integer DEFAULT 0 NOT NULL
);


--
-- Name: security_principals; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.security_principals (
    instance_id bigint NOT NULL,
    name text NOT NULL,
    host text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    can_login boolean DEFAULT false NOT NULL,
    is_superuser boolean DEFAULT false NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    auth_method text,
    password_set_at timestamp with time zone,
    expires_at timestamp with time zone,
    privileges text[] DEFAULT '{}'::text[] NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: server_settings; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.server_settings (
    instance_id bigint NOT NULL,
    name text NOT NULL,
    value text NOT NULL,
    unit text,
    category text,
    is_default boolean,
    requires_restart boolean,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: service_deps; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.service_deps (
    dep_id bigint NOT NULL,
    from_instance_id bigint,
    from_service_name text,
    to_instance_id bigint NOT NULL,
    relation text DEFAULT 'depends_on'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_deps_check CHECK (((from_instance_id IS NOT NULL) OR (from_service_name IS NOT NULL)))
);


--
-- Name: service_deps_dep_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.service_deps ALTER COLUMN dep_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.service_deps_dep_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: session_samples; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.session_samples (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    pid integer NOT NULL,
    state text NOT NULL,
    wait_type text,
    wait_event text,
    application text NOT NULL,
    username text NOT NULL,
    database text NOT NULL,
    queryid bigint,
    query_ms numeric,
    xact_ms numeric,
    blocked_by integer,
    query text
)
PARTITION BY RANGE (ts);


--
-- Name: settings; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: snmp_traps; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.snmp_traps (
    trap_id bigint NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    source_address text NOT NULL,
    source_port integer DEFAULT 0 NOT NULL,
    community text,
    pdu_type text,
    oid text,
    varbinds jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: snmp_traps_trap_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.snmp_traps ALTER COLUMN trap_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.snmp_traps_trap_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: statement_slow_events; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.statement_slow_events (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    queryid bigint NOT NULL,
    database text,
    username text,
    duration_sec double precision NOT NULL,
    rows_sent double precision,
    rows_examined double precision,
    source text DEFAULT 'digest'::text NOT NULL,
    CONSTRAINT statement_slow_events_source_check CHECK ((source = ANY (ARRAY['digest'::text, 'slow_log'::text, 'processlist'::text])))
);


--
-- Name: statement_stats; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.statement_stats (
    instance_id bigint CONSTRAINT statement_stats_instance_id_not_null1 NOT NULL,
    ts timestamp with time zone CONSTRAINT statement_stats_ts_not_null1 NOT NULL,
    queryid bigint CONSTRAINT statement_stats_queryid_not_null1 NOT NULL,
    database text,
    username text,
    toplevel boolean DEFAULT true CONSTRAINT statement_stats_toplevel_not_null1 NOT NULL,
    calls double precision CONSTRAINT statement_stats_calls_not_null1 NOT NULL,
    exec_ms double precision CONSTRAINT statement_stats_exec_ms_not_null1 NOT NULL,
    rows double precision CONSTRAINT statement_stats_rows_not_null1 NOT NULL,
    shared_hit double precision DEFAULT 0 CONSTRAINT statement_stats_shared_hit_not_null1 NOT NULL,
    shared_read double precision DEFAULT 0 CONSTRAINT statement_stats_shared_read_not_null1 NOT NULL,
    temp_read double precision DEFAULT 0 CONSTRAINT statement_stats_temp_read_not_null1 NOT NULL,
    temp_written double precision DEFAULT 0 CONSTRAINT statement_stats_temp_written_not_null1 NOT NULL,
    wal_bytes double precision DEFAULT 0 CONSTRAINT statement_stats_wal_bytes_not_null1 NOT NULL
)
PARTITION BY RANGE (ts);


--
-- Name: statement_texts; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.statement_texts (
    instance_id bigint NOT NULL,
    queryid bigint NOT NULL,
    query text NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    truncated boolean DEFAULT false NOT NULL
);


--
-- Name: suppressed_aliases; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.suppressed_aliases (
    alias text NOT NULL,
    suppressed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: table_fks; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.table_fks (
    instance_id bigint NOT NULL,
    from_schema text NOT NULL,
    from_table text NOT NULL,
    to_schema text NOT NULL,
    to_table text NOT NULL,
    constraint_name text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: topology_edges; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.topology_edges (
    instance_id bigint NOT NULL,
    week_start date NOT NULL,
    actor text NOT NULL,
    schema_name text NOT NULL,
    relation text NOT NULL,
    direction text NOT NULL,
    weight double precision NOT NULL,
    samples integer DEFAULT 0 NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT topology_edges_direction_check CHECK ((direction = ANY (ARRAY['escritura'::text, 'lectura'::text])))
);


--
-- Name: users; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.users (
    user_id bigint NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    last_login_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'viewer'::text])))
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: buho; Owner: -
--

ALTER TABLE buho.users ALTER COLUMN user_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME buho.users_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vacuum_progress; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.vacuum_progress (
    instance_id bigint NOT NULL,
    pid integer NOT NULL,
    kind text NOT NULL,
    schema_name text,
    table_name text,
    phase text,
    heap_blks_total bigint,
    heap_blks_scanned bigint,
    heap_blks_vacuumed bigint,
    index_vacuum_count bigint,
    dead_tuple_bytes bigint,
    max_dead_tuple_bytes bigint,
    progress_pct double precision,
    started_at timestamp with time zone,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vacuum_tables; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.vacuum_tables (
    instance_id bigint NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    live_tuples bigint NOT NULL,
    dead_tuples bigint NOT NULL,
    dead_pct double precision,
    last_autovacuum timestamp with time zone,
    last_vacuum timestamp with time zone,
    last_autoanalyze timestamp with time zone,
    last_analyze timestamp with time zone,
    autovacuum_count bigint DEFAULT 0 NOT NULL,
    analyze_count bigint DEFAULT 0 NOT NULL,
    threshold double precision,
    remaining bigint,
    autovacuum_enabled boolean DEFAULT true NOT NULL,
    size_bytes bigint NOT NULL,
    heap_bytes bigint NOT NULL,
    bloat_bytes bigint,
    bloat_pct double precision,
    bloat_note text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    xid_age bigint DEFAULT 0 NOT NULL,
    mxid_age bigint DEFAULT 0 NOT NULL,
    freeze_max_age bigint DEFAULT 0 NOT NULL,
    xid_pct double precision,
    mxid_pct double precision
);


--
-- Name: wait_samples; Type: TABLE; Schema: buho; Owner: -
--

CREATE TABLE buho.wait_samples (
    instance_id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    wait_type text NOT NULL,
    wait_event text,
    sessions integer NOT NULL
)
PARTITION BY RANGE (ts);


--
-- Name: alert_channels alert_channels_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_channels
    ADD CONSTRAINT alert_channels_pkey PRIMARY KEY (channel_id);


--
-- Name: alert_definitions alert_definitions_name_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_definitions
    ADD CONSTRAINT alert_definitions_name_key UNIQUE (name);


--
-- Name: alert_definitions alert_definitions_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_definitions
    ADD CONSTRAINT alert_definitions_pkey PRIMARY KEY (definition_id);


--
-- Name: alert_deliveries alert_deliveries_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_deliveries
    ADD CONSTRAINT alert_deliveries_pkey PRIMARY KEY (delivery_id);


--
-- Name: alert_rules alert_rules_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (rule_id);


--
-- Name: alert_silences alert_silences_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_silences
    ADD CONSTRAINT alert_silences_pkey PRIMARY KEY (silence_id);


--
-- Name: alerts alerts_instance_id_dedupe_key_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alerts
    ADD CONSTRAINT alerts_instance_id_dedupe_key_key UNIQUE (instance_id, dedupe_key);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (alert_id);


--
-- Name: backup_state backup_state_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.backup_state
    ADD CONSTRAINT backup_state_pkey PRIMARY KEY (instance_id, database, kind);


--
-- Name: bloat_requests bloat_requests_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.bloat_requests
    ADD CONSTRAINT bloat_requests_pkey PRIMARY KEY (request_id);


--
-- Name: catalog_columns catalog_columns_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.catalog_columns
    ADD CONSTRAINT catalog_columns_pkey PRIMARY KEY (instance_id, schema_name, table_name, column_name);


--
-- Name: catalog_tables catalog_tables_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.catalog_tables
    ADD CONSTRAINT catalog_tables_pkey PRIMARY KEY (instance_id, schema_name, table_name);


--
-- Name: check_results check_results_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.check_results
    ADD CONSTRAINT check_results_pkey PRIMARY KEY (check_result_id);


--
-- Name: collector_events collector_events_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.collector_events
    ADD CONSTRAINT collector_events_pkey PRIMARY KEY (event_id);


--
-- Name: collector_heartbeat collector_heartbeat_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.collector_heartbeat
    ADD CONSTRAINT collector_heartbeat_pkey PRIMARY KEY (component);


--
-- Name: console_events console_events_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.console_events
    ADD CONSTRAINT console_events_pkey PRIMARY KEY (event_id);


--
-- Name: discovered discovered_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.discovered
    ADD CONSTRAINT discovered_pkey PRIMARY KEY (host, port);


--
-- Name: disk_objects disk_objects_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.disk_objects
    ADD CONSTRAINT disk_objects_pkey PRIMARY KEY (instance_id, kind, container, name);


--
-- Name: engine_info engine_info_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.engine_info
    ADD CONSTRAINT engine_info_pkey PRIMARY KEY (instance_id);


--
-- Name: health_scores health_scores_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.health_scores
    ADD CONSTRAINT health_scores_pkey PRIMARY KEY (instance_id, ts);


--
-- Name: index_objects index_objects_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.index_objects
    ADD CONSTRAINT index_objects_pkey PRIMARY KEY (instance_id, schema_name, table_name, index_name);


--
-- Name: infra_discovery infra_discovery_host_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.infra_discovery
    ADD CONSTRAINT infra_discovery_host_key UNIQUE (host);


--
-- Name: infra_discovery infra_discovery_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.infra_discovery
    ADD CONSTRAINT infra_discovery_pkey PRIMARY KEY (discovery_id);


--
-- Name: instance_capabilities instance_capabilities_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instance_capabilities
    ADD CONSTRAINT instance_capabilities_pkey PRIMARY KEY (instance_id);


--
-- Name: instance_tags instance_tags_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instance_tags
    ADD CONSTRAINT instance_tags_pkey PRIMARY KEY (instance_id, key);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (instance_id);


--
-- Name: instances instances_tenant_alias_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instances
    ADD CONSTRAINT instances_tenant_alias_key UNIQUE (tenant, alias);


--
-- Name: inventory_notes inventory_notes_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.inventory_notes
    ADD CONSTRAINT inventory_notes_pkey PRIMARY KEY (instance_id, domain, message);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (instance_id, scope, name);


--
-- Name: licensing licensing_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.licensing
    ADD CONSTRAINT licensing_pkey PRIMARY KEY (instance_id);


--
-- Name: lock_episodes lock_episodes_identity; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.lock_episodes
    ADD CONSTRAINT lock_episodes_identity UNIQUE NULLS NOT DISTINCT (instance_id, waiter_pid, waiter_query_start);


--
-- Name: lock_episodes lock_episodes_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.lock_episodes
    ADD CONSTRAINT lock_episodes_pkey PRIMARY KEY (episode_id);


--
-- Name: log_cursors log_cursors_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.log_cursors
    ADD CONSTRAINT log_cursors_pkey PRIMARY KEY (instance_id);


--
-- Name: metric_baselines metric_baselines_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.metric_baselines
    ADD CONSTRAINT metric_baselines_pkey PRIMARY KEY (instance_id, metric, scope, dow, hour);


--
-- Name: metric_rollup_1h metric_rollup_1h_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.metric_rollup_1h
    ADD CONSTRAINT metric_rollup_1h_pkey PRIMARY KEY (instance_id, metric, labels, bucket);


--
-- Name: metric_rollup_5m metric_rollup_5m_pkey1; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.metric_rollup_5m
    ADD CONSTRAINT metric_rollup_5m_pkey1 PRIMARY KEY (instance_id, metric, labels, bucket);


--
-- Name: monitor_targets monitor_targets_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.monitor_targets
    ADD CONSTRAINT monitor_targets_pkey PRIMARY KEY (target_id);


--
-- Name: monitor_targets monitor_targets_tenant_alias_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.monitor_targets
    ADD CONSTRAINT monitor_targets_tenant_alias_key UNIQUE (tenant, alias);


--
-- Name: mssql_heap_pressure mssql_heap_pressure_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.mssql_heap_pressure
    ADD CONSTRAINT mssql_heap_pressure_pkey PRIMARY KEY (instance_id, schema_name, table_name);


--
-- Name: mssql_index_fragmentation mssql_index_fragmentation_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.mssql_index_fragmentation
    ADD CONSTRAINT mssql_index_fragmentation_pkey PRIMARY KEY (instance_id, schema_name, table_name, index_name);


--
-- Name: obs_service_tags obs_service_tags_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.obs_service_tags
    ADD CONSTRAINT obs_service_tags_pkey PRIMARY KEY (entity_kind, entity_key, tag);


--
-- Name: otlp_log_records otlp_log_records_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.otlp_log_records
    ADD CONSTRAINT otlp_log_records_pkey PRIMARY KEY (log_pk);


--
-- Name: otlp_spans otlp_spans_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.otlp_spans
    ADD CONSTRAINT otlp_spans_pkey PRIMARY KEY (span_pk);


--
-- Name: otlp_spans otlp_spans_trace_id_span_id_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.otlp_spans
    ADD CONSTRAINT otlp_spans_trace_id_span_id_key UNIQUE (trace_id, span_id);


--
-- Name: otlp_traces otlp_traces_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.otlp_traces
    ADD CONSTRAINT otlp_traces_pkey PRIMARY KEY (trace_id);


--
-- Name: overview_layouts overview_layouts_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.overview_layouts
    ADD CONSTRAINT overview_layouts_pkey PRIMARY KEY (username, instance_id);


--
-- Name: plan_requests plan_requests_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.plan_requests
    ADD CONSTRAINT plan_requests_pkey PRIMARY KEY (request_id);


--
-- Name: procedure_slow_events procedure_slow_events_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.procedure_slow_events
    ADD CONSTRAINT procedure_slow_events_pkey PRIMARY KEY (instance_id, ts, object_id);


--
-- Name: procedure_texts procedure_texts_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.procedure_texts
    ADD CONSTRAINT procedure_texts_pkey PRIMARY KEY (instance_id, object_id);


--
-- Name: replication_state replication_state_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.replication_state
    ADD CONSTRAINT replication_state_pkey PRIMARY KEY (instance_id, role, peer);


--
-- Name: security_cases security_cases_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_cases
    ADD CONSTRAINT security_cases_pkey PRIMARY KEY (case_id);


--
-- Name: security_findings security_findings_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_findings
    ADD CONSTRAINT security_findings_pkey PRIMARY KEY (instance_id, check_id);


--
-- Name: security_posture security_posture_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_posture
    ADD CONSTRAINT security_posture_pkey PRIMARY KEY (instance_id, captured_at);


--
-- Name: security_principals security_principals_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_principals
    ADD CONSTRAINT security_principals_pkey PRIMARY KEY (instance_id, name, host);


--
-- Name: server_settings server_settings_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.server_settings
    ADD CONSTRAINT server_settings_pkey PRIMARY KEY (instance_id, name);


--
-- Name: service_deps service_deps_from_instance_id_to_instance_id_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.service_deps
    ADD CONSTRAINT service_deps_from_instance_id_to_instance_id_key UNIQUE (from_instance_id, to_instance_id);


--
-- Name: service_deps service_deps_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.service_deps
    ADD CONSTRAINT service_deps_pkey PRIMARY KEY (dep_id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: snmp_traps snmp_traps_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.snmp_traps
    ADD CONSTRAINT snmp_traps_pkey PRIMARY KEY (trap_id);


--
-- Name: statement_slow_events statement_slow_events_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.statement_slow_events
    ADD CONSTRAINT statement_slow_events_pkey PRIMARY KEY (instance_id, ts, queryid, source);


--
-- Name: statement_texts statement_texts_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.statement_texts
    ADD CONSTRAINT statement_texts_pkey PRIMARY KEY (instance_id, queryid);


--
-- Name: suppressed_aliases suppressed_aliases_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.suppressed_aliases
    ADD CONSTRAINT suppressed_aliases_pkey PRIMARY KEY (alias);


--
-- Name: table_fks table_fks_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.table_fks
    ADD CONSTRAINT table_fks_pkey PRIMARY KEY (instance_id, from_schema, from_table, constraint_name);


--
-- Name: topology_edges topology_edges_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.topology_edges
    ADD CONSTRAINT topology_edges_pkey PRIMARY KEY (instance_id, week_start, actor, schema_name, relation, direction);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: vacuum_progress vacuum_progress_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.vacuum_progress
    ADD CONSTRAINT vacuum_progress_pkey PRIMARY KEY (instance_id, pid, kind);


--
-- Name: vacuum_tables vacuum_tables_pkey; Type: CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.vacuum_tables
    ADD CONSTRAINT vacuum_tables_pkey PRIMARY KEY (instance_id, schema_name, table_name);


--
-- Name: alert_definitions_instance_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_definitions_instance_idx ON buho.alert_definitions USING btree (match_instance_id);


--
-- Name: alert_definitions_scope; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_definitions_scope ON buho.alert_definitions USING btree (enabled, match_engine, match_instance_id);


--
-- Name: alert_deliveries_alert_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_deliveries_alert_idx ON buho.alert_deliveries USING btree (alert_id);


--
-- Name: alert_deliveries_channel_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_deliveries_channel_idx ON buho.alert_deliveries USING btree (channel_id);


--
-- Name: alert_deliveries_pending; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_deliveries_pending ON buho.alert_deliveries USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: alert_rules_instance_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_rules_instance_idx ON buho.alert_rules USING btree (match_instance_id);


--
-- Name: alert_rules_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_rules_lookup ON buho.alert_rules USING btree (enabled, priority, match_check_id, match_instance_id);


--
-- Name: alert_silences_active; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_silences_active ON buho.alert_silences USING btree (ends_at);


--
-- Name: alert_silences_instance_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alert_silences_instance_idx ON buho.alert_silences USING btree (instance_id);


--
-- Name: alerts_open_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX alerts_open_lookup ON buho.alerts USING btree (status, severity, last_seen_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'firing'::text]));


--
-- Name: bloat_requests_history_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX bloat_requests_history_idx ON buho.bloat_requests USING btree (instance_id, schema_name, table_name, requested_at DESC);


--
-- Name: bloat_requests_pending_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX bloat_requests_pending_idx ON buho.bloat_requests USING btree (requested_at) WHERE (state = ANY (ARRAY['pendiente'::text, 'corriendo'::text]));


--
-- Name: check_results_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX check_results_lookup ON buho.check_results USING btree (instance_id, ts DESC);


--
-- Name: check_results_ts_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX check_results_ts_idx ON buho.check_results USING btree (ts);


--
-- Name: collector_events_instance_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX collector_events_instance_idx ON buho.collector_events USING btree (instance_id);


--
-- Name: collector_events_open_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX collector_events_open_idx ON buho.collector_events USING btree (ts DESC) WHERE (status = 'open'::text);


--
-- Name: collector_events_ts; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX collector_events_ts ON buho.collector_events USING btree (ts DESC);


--
-- Name: console_events_at_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX console_events_at_idx ON buho.console_events USING btree (at DESC);


--
-- Name: index_objects_size; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX index_objects_size ON buho.index_objects USING btree (instance_id, size_bytes DESC);


--
-- Name: index_objects_status; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX index_objects_status ON buho.index_objects USING btree (instance_id, status);


--
-- Name: infra_discovery_scanned_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX infra_discovery_scanned_idx ON buho.infra_discovery USING btree (scanned_at DESC);


--
-- Name: instance_tags_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX instance_tags_lookup ON buho.instance_tags USING btree (key, value);


--
-- Name: lock_episodes_recent; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX lock_episodes_recent ON buho.lock_episodes USING btree (instance_id, last_seen_at DESC);


--
-- Name: log_events_group; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX log_events_group ON ONLY buho.log_events USING btree (instance_id, fingerprint, at DESC);


--
-- Name: log_events_identity; Type: INDEX; Schema: buho; Owner: -
--

CREATE UNIQUE INDEX log_events_identity ON ONLY buho.log_events USING btree (instance_id, at, kind, fingerprint, pid) NULLS NOT DISTINCT;


--
-- Name: log_events_kind; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX log_events_kind ON ONLY buho.log_events USING btree (instance_id, kind, at DESC);


--
-- Name: log_events_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX log_events_lookup ON ONLY buho.log_events USING btree (instance_id, at DESC);


--
-- Name: metric_baselines_metric; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX metric_baselines_metric ON buho.metric_baselines USING btree (instance_id, metric, scope);


--
-- Name: metric_rollup_5m_bucket_brin; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX metric_rollup_5m_bucket_brin ON ONLY buho.metric_rollup_5m USING brin (bucket);


--
-- Name: metric_rollup_5m_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX metric_rollup_5m_lookup ON ONLY buho.metric_rollup_5m USING btree (instance_id, metric, bucket DESC);


--
-- Name: metric_samples_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX metric_samples_lookup ON ONLY buho.metric_samples USING btree (instance_id, metric, ts DESC);


--
-- Name: metric_samples_ts_brin; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX metric_samples_ts_brin ON ONLY buho.metric_samples USING brin (ts);


--
-- Name: monitor_targets_enabled_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX monitor_targets_enabled_idx ON buho.monitor_targets USING btree (enabled) WHERE enabled;


--
-- Name: mssql_index_fragmentation_pct; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX mssql_index_fragmentation_pct ON buho.mssql_index_fragmentation USING btree (instance_id, fragmentation_pct DESC);


--
-- Name: obs_service_tags_tag; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX obs_service_tags_tag ON buho.obs_service_tags USING btree (tag);


--
-- Name: otlp_log_records_observed; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_log_records_observed ON buho.otlp_log_records USING btree (observed_ts DESC);


--
-- Name: otlp_log_records_service; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_log_records_service ON buho.otlp_log_records USING btree (service_name, observed_ts DESC);


--
-- Name: otlp_log_records_trace; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_log_records_trace ON buho.otlp_log_records USING btree (trace_id) WHERE (trace_id IS NOT NULL);


--
-- Name: otlp_spans_service; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_spans_service ON buho.otlp_spans USING btree (service_name, start_ts DESC);


--
-- Name: otlp_spans_sql; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_spans_sql ON buho.otlp_spans USING btree (start_ts DESC) WHERE (sql_text IS NOT NULL);


--
-- Name: otlp_spans_start; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_spans_start ON buho.otlp_spans USING btree (start_ts DESC);


--
-- Name: otlp_spans_trace; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_spans_trace ON buho.otlp_spans USING btree (trace_id);


--
-- Name: otlp_traces_start; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX otlp_traces_start ON buho.otlp_traces USING btree (start_ts DESC);


--
-- Name: plan_requests_history_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX plan_requests_history_idx ON buho.plan_requests USING btree (instance_id, queryid, requested_at DESC);


--
-- Name: plan_requests_pending_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX plan_requests_pending_idx ON buho.plan_requests USING btree (requested_at) WHERE (state = ANY (ARRAY['pendiente'::text, 'corriendo'::text]));


--
-- Name: procedure_slow_events_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX procedure_slow_events_lookup ON buho.procedure_slow_events USING btree (instance_id, ts DESC);


--
-- Name: procedure_stats_by_object; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX procedure_stats_by_object ON ONLY buho.procedure_stats USING btree (instance_id, object_id, ts DESC);


--
-- Name: procedure_stats_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX procedure_stats_lookup ON ONLY buho.procedure_stats USING btree (instance_id, ts DESC);


--
-- Name: query_actors_by_query; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX query_actors_by_query ON ONLY buho.query_actors USING btree (instance_id, queryid, ts DESC);


--
-- Name: query_actors_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX query_actors_lookup ON ONLY buho.query_actors USING btree (instance_id, ts DESC);


--
-- Name: security_cases_status_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX security_cases_status_idx ON buho.security_cases USING btree (status, updated_at DESC);


--
-- Name: security_findings_severity_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX security_findings_severity_idx ON buho.security_findings USING btree (severity, category);


--
-- Name: service_deps_to; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX service_deps_to ON buho.service_deps USING btree (to_instance_id);


--
-- Name: session_samples_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX session_samples_lookup ON ONLY buho.session_samples USING btree (instance_id, ts DESC);


--
-- Name: snmp_traps_received_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX snmp_traps_received_idx ON buho.snmp_traps USING btree (received_at DESC);


--
-- Name: snmp_traps_source_idx; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX snmp_traps_source_idx ON buho.snmp_traps USING btree (source_address, received_at DESC);


--
-- Name: statement_slow_events_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX statement_slow_events_lookup ON buho.statement_slow_events USING btree (instance_id, ts DESC);


--
-- Name: statement_stats_by_query; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX statement_stats_by_query ON ONLY buho.statement_stats USING btree (instance_id, queryid, ts DESC);


--
-- Name: statement_stats_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX statement_stats_lookup ON ONLY buho.statement_stats USING btree (instance_id, ts DESC);


--
-- Name: table_fks_to; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX table_fks_to ON buho.table_fks USING btree (instance_id, to_schema, to_table);


--
-- Name: topology_edges_week; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX topology_edges_week ON buho.topology_edges USING btree (instance_id, week_start DESC);


--
-- Name: vacuum_tables_bloat; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX vacuum_tables_bloat ON buho.vacuum_tables USING btree (instance_id, bloat_bytes DESC NULLS LAST);


--
-- Name: vacuum_tables_dead; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX vacuum_tables_dead ON buho.vacuum_tables USING btree (instance_id, dead_tuples DESC);


--
-- Name: vacuum_tables_xid; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX vacuum_tables_xid ON buho.vacuum_tables USING btree (instance_id, xid_pct DESC NULLS LAST);


--
-- Name: wait_samples_lookup; Type: INDEX; Schema: buho; Owner: -
--

CREATE INDEX wait_samples_lookup ON ONLY buho.wait_samples USING btree (instance_id, ts DESC);


--
-- Name: alert_definitions alert_definitions_match_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_definitions
    ADD CONSTRAINT alert_definitions_match_instance_id_fkey FOREIGN KEY (match_instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: alert_deliveries alert_deliveries_alert_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_deliveries
    ADD CONSTRAINT alert_deliveries_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES buho.alerts(alert_id) ON DELETE CASCADE;


--
-- Name: alert_deliveries alert_deliveries_channel_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_deliveries
    ADD CONSTRAINT alert_deliveries_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES buho.alert_channels(channel_id) ON DELETE CASCADE;


--
-- Name: alert_rules alert_rules_match_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_rules
    ADD CONSTRAINT alert_rules_match_instance_id_fkey FOREIGN KEY (match_instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: alert_silences alert_silences_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alert_silences
    ADD CONSTRAINT alert_silences_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: alerts alerts_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.alerts
    ADD CONSTRAINT alerts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: backup_state backup_state_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.backup_state
    ADD CONSTRAINT backup_state_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: bloat_requests bloat_requests_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.bloat_requests
    ADD CONSTRAINT bloat_requests_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: catalog_columns catalog_columns_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.catalog_columns
    ADD CONSTRAINT catalog_columns_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: catalog_tables catalog_tables_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.catalog_tables
    ADD CONSTRAINT catalog_tables_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: check_results check_results_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.check_results
    ADD CONSTRAINT check_results_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: collector_events collector_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.collector_events
    ADD CONSTRAINT collector_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: disk_objects disk_objects_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.disk_objects
    ADD CONSTRAINT disk_objects_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: engine_info engine_info_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.engine_info
    ADD CONSTRAINT engine_info_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: health_scores health_scores_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.health_scores
    ADD CONSTRAINT health_scores_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: index_objects index_objects_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.index_objects
    ADD CONSTRAINT index_objects_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: instance_capabilities instance_capabilities_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instance_capabilities
    ADD CONSTRAINT instance_capabilities_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: instance_tags instance_tags_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.instance_tags
    ADD CONSTRAINT instance_tags_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: inventory_notes inventory_notes_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.inventory_notes
    ADD CONSTRAINT inventory_notes_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: jobs jobs_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.jobs
    ADD CONSTRAINT jobs_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: licensing licensing_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.licensing
    ADD CONSTRAINT licensing_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: lock_episodes lock_episodes_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.lock_episodes
    ADD CONSTRAINT lock_episodes_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: log_cursors log_cursors_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.log_cursors
    ADD CONSTRAINT log_cursors_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: log_events log_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.log_events
    ADD CONSTRAINT log_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: metric_baselines metric_baselines_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.metric_baselines
    ADD CONSTRAINT metric_baselines_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: metric_rollup_1h metric_rollup_1h_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.metric_rollup_1h
    ADD CONSTRAINT metric_rollup_1h_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: metric_rollup_5m metric_rollup_5m_instance_id_fkey1; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.metric_rollup_5m
    ADD CONSTRAINT metric_rollup_5m_instance_id_fkey1 FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: metric_samples metric_samples_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.metric_samples
    ADD CONSTRAINT metric_samples_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: mssql_heap_pressure mssql_heap_pressure_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.mssql_heap_pressure
    ADD CONSTRAINT mssql_heap_pressure_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: mssql_index_fragmentation mssql_index_fragmentation_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.mssql_index_fragmentation
    ADD CONSTRAINT mssql_index_fragmentation_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: overview_layouts overview_layouts_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.overview_layouts
    ADD CONSTRAINT overview_layouts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: plan_requests plan_requests_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.plan_requests
    ADD CONSTRAINT plan_requests_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: procedure_slow_events procedure_slow_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.procedure_slow_events
    ADD CONSTRAINT procedure_slow_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: procedure_stats procedure_stats_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.procedure_stats
    ADD CONSTRAINT procedure_stats_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: procedure_texts procedure_texts_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.procedure_texts
    ADD CONSTRAINT procedure_texts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: query_actors query_actors_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.query_actors
    ADD CONSTRAINT query_actors_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: replication_state replication_state_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.replication_state
    ADD CONSTRAINT replication_state_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: security_findings security_findings_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_findings
    ADD CONSTRAINT security_findings_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: security_posture security_posture_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_posture
    ADD CONSTRAINT security_posture_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: security_principals security_principals_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.security_principals
    ADD CONSTRAINT security_principals_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: server_settings server_settings_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.server_settings
    ADD CONSTRAINT server_settings_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: service_deps service_deps_from_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.service_deps
    ADD CONSTRAINT service_deps_from_instance_id_fkey FOREIGN KEY (from_instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: service_deps service_deps_to_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.service_deps
    ADD CONSTRAINT service_deps_to_instance_id_fkey FOREIGN KEY (to_instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: session_samples session_samples_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.session_samples
    ADD CONSTRAINT session_samples_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: statement_slow_events statement_slow_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.statement_slow_events
    ADD CONSTRAINT statement_slow_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: statement_stats statement_stats_instance_id_fkey1; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.statement_stats
    ADD CONSTRAINT statement_stats_instance_id_fkey1 FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: statement_texts statement_texts_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.statement_texts
    ADD CONSTRAINT statement_texts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: table_fks table_fks_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.table_fks
    ADD CONSTRAINT table_fks_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: topology_edges topology_edges_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.topology_edges
    ADD CONSTRAINT topology_edges_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: vacuum_progress vacuum_progress_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.vacuum_progress
    ADD CONSTRAINT vacuum_progress_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: vacuum_tables vacuum_tables_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE ONLY buho.vacuum_tables
    ADD CONSTRAINT vacuum_tables_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- Name: wait_samples wait_samples_instance_id_fkey; Type: FK CONSTRAINT; Schema: buho; Owner: -
--

ALTER TABLE buho.wait_samples
    ADD CONSTRAINT wait_samples_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES buho.instances(instance_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict ZNZuQQv481VqsteEXBPF5d4ccIhXSeTpgNf4e6IdKAdi9KCxDePWRfZJz22akUO

