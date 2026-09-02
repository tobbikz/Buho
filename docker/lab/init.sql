-- Healthy lab defaults for Búho demo instances (runs on first init only).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Clean slate so cache_hit / temp_spill checks stay quiet on a fresh cluster.
SELECT pg_stat_reset();
