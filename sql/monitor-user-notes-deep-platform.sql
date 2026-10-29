-- Búho Deep Platform — notes for new engines (Kafka / Airflow / CDC / actions).
-- These are not SQL GRANTs; they document least-privilege for non-SQL targets.

-- Kafka: create a principal that can DescribeCluster, DescribeConfigs,
-- DescribeGroups, and Read offsets for monitored consumer groups.
-- Do NOT grant Alter / Delete on production topics to the monitor principal.
-- Action rewind_consumer requires a separate dual-control principal.

-- Airflow: use a read-only API user for monitoring (GET dags, health, pools).
-- pause/unpause DAG actions need a separate account with DAG edit permission;
-- configure it under instance.actions + airflow credentials only when enabled.

-- CDC / DataSync: monitor Kafka apply groups + optional HTTP health URL.
-- Health endpoint should be unauthenticated only on a private network, or
-- behind a token the collector can send.

-- PostgreSQL actions (kill/cancel): create a dedicated role, e.g.
--   create role buho_action login password '...';
--   grant pg_signal_backend to buho_action;
-- Never reuse the read-only buho_monitor role for terminate/cancel.
