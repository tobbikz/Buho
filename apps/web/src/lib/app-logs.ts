import { query } from './db';

export type AppLogRecord = {
  id: number;
  at: Date;
  severity: string;
  body: string;
  serviceName: string;
  traceId: string | null;
  spanId: string | null;
};

export async function listAppLogRecords(
  hours = 24,
  limit = 200,
  service?: string | null,
): Promise<AppLogRecord[]> {
  const rows = await query<Record<string, unknown>>(
    `select log_pk, observed_ts, severity_text, body, service_name, trace_id, span_id
       from buho.otlp_log_records
      where observed_ts >= now() - ($1 || ' hours')::interval
        and ($3::text is null or service_name = $3)
      order by observed_ts desc
      limit $2`,
    [hours, limit, service?.trim() || null],
  );
  return rows.map((row) => ({
    id: Number(row['log_pk']),
    at: row['observed_ts'] as Date,
    severity: String(row['severity_text'] ?? ''),
    body: String(row['body'] ?? ''),
    serviceName: String(row['service_name'] ?? 'unknown'),
    traceId: (row['trace_id'] as string | null) ?? null,
    spanId: (row['span_id'] as string | null) ?? null,
  }));
}

export async function countAppLogsByService(hours = 24): Promise<
  Array<{ serviceName: string; times: number }>
> {
  const rows = await query<{ service_name: string; times: string }>(
    `select service_name, count(*)::text as times
       from buho.otlp_log_records
      where observed_ts >= now() - ($1 || ' hours')::interval
      group by service_name
      order by count(*) desc
      limit 40`,
    [hours],
  );
  return rows.map((r) => ({
    serviceName: r.service_name,
    times: Number(r.times),
  }));
}
