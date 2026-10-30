'use client';

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle',
  cassandra: 'Cassandra',
  elasticsearch: 'Elasticsearch',
  kafka: 'Kafka',
  cdc: 'CDC',
  airflow: 'Airflow',
};

export function FleetScopeFilters({
  engines,
  instances,
  engine,
  conn,
  preserve,
}: {
  engines: string[];
  instances: { alias: string; engine: string }[];
  engine: string;
  conn: string;
  preserve?: Record<string, string>;
}) {
  const kept = Object.entries(preserve ?? {}).filter(([, value]) => value);

  return (
    <form method="get" className="flex flex-wrap items-end gap-3" onChange={(event) => event.currentTarget.requestSubmit()}>
      {kept.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Engine
        <select name="engine" defaultValue={engine} className="input min-w-[10rem]">
          <option value="">All engines</option>
          {engines.map((value) => (
            <option key={value} value={value}>
              {ENGINE_LABEL[value] ?? value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Connection
        <select name="conn" defaultValue={conn} className="input min-w-[18rem] max-w-[28rem] font-mono">
          <option value="">All connections</option>
          {instances.map((row) => (
            <option key={row.alias} value={row.alias}>
              {row.alias}
              {row.engine ? ` · ${ENGINE_LABEL[row.engine] ?? row.engine}` : ''}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
