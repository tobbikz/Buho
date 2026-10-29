import { formatAgo } from '@/lib/format';
import { query } from '@/lib/db';

type PlanRegressionRow = {
  ts: Date;
  object: string | null;
  message: string;
};

type DdlRow = {
  at: Date;
  command_tag: string;
  object_name: string;
  sql_text: string;
};

export interface DdlPlanCorrelation {
  planAt: Date;
  planObject: string | null;
  planMessage: string;
  ddlEvents: DdlRow[];
}

async function listPlanRegressions(instanceId: number, windowMinutes: number): Promise<PlanRegressionRow[]> {
  return query<PlanRegressionRow>(
    `select ts, object, message
       from buho.check_results
      where instance_id = $1
        and check_id = 'plan_regression'
        and ts > now() - ($2::text || ' minutes')::interval
      order by ts desc
      limit 12`,
    [instanceId, String(windowMinutes)],
  );
}

async function listDdlNear(
  instanceId: number,
  from: Date,
  to: Date,
): Promise<DdlRow[]> {
  try {
    return await query<DdlRow>(
      `select at, command_tag, coalesce(object_name, '') as object_name,
              left(coalesce(sql, ''), 240) as sql_text
         from buho.ddl_events
        where instance_id = $1
          and at >= $2
          and at <= $3
        order by at desc
        limit 20`,
      [instanceId, from, to],
    );
  } catch {
    return [];
  }
}

/**
 * Lists plan_regression checks with DDL captured in a short window before each event.
 */
export async function DdlPlanCorrelate({
  instanceId,
  windowMinutes = 60,
  correlateMinutes = 45,
}: {
  instanceId: number;
  windowMinutes?: number;
  correlateMinutes?: number;
}) {
  const regressions = await listPlanRegressions(instanceId, windowMinutes);
  const correlations: DdlPlanCorrelation[] = [];

  for (const row of regressions) {
    const planAt = row.ts instanceof Date ? row.ts : new Date(row.ts);
    const from = new Date(planAt.getTime() - correlateMinutes * 60_000);
    const ddlEvents = await listDdlNear(instanceId, from, planAt);
    correlations.push({
      planAt,
      planObject: row.object,
      planMessage: row.message,
      ddlEvents,
    });
  }

  const ddlTableMissing = correlations.length > 0 && correlations.every((c) => c.ddlEvents.length === 0);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">DDL near plan regression</span>
        <span className="tag tag--info">correlate</span>
      </div>
      <div className="panel-body">
        {regressions.length === 0 ? (
          <p className="text-[12px] text-foreground-muted">
            No <code className="font-mono text-[11px]">plan_regression</code> findings in the last{' '}
            {windowMinutes}m.
          </p>
        ) : (
          <ul className="m-0 list-none flex flex-col gap-3 p-0">
            {correlations.map((item) => (
              <li key={item.planAt.toISOString()} className="rounded border border-border/70 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-foreground-secondary">
                    {item.planObject ?? '(query)'}
                  </span>
                  <span className="font-mono text-[10px] text-foreground-muted">{formatAgo(item.planAt)}</span>
                </div>
                <p className="mt-1 text-[12px] text-foreground-secondary leading-snug">{item.planMessage}</p>
                {item.ddlEvents.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
                    {item.ddlEvents.map((ddl) => (
                      <li key={`${ddl.at}-${ddl.command_tag}-${ddl.object_name}`} className="text-[11px]">
                        <span className="tag tag--warn mr-1">{ddl.command_tag}</span>
                        <span className="font-mono text-foreground-secondary">{ddl.object_name}</span>
                        <span className="ml-2 font-mono text-[10px] text-foreground-muted">
                          {formatAgo(ddl.at instanceof Date ? ddl.at : new Date(ddl.at))}
                        </span>
                        <pre className="mt-1 overflow-x-auto rounded bg-surface-muted p-1.5 font-mono text-[10px] text-foreground-muted">
                          {ddl.sql_text}
                        </pre>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-foreground-muted">
                    No DDL in the {correlateMinutes}m before this regression.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {ddlTableMissing && regressions.length > 0 ? (
          <p className="mt-3 text-[11px] text-foreground-muted">
            Apply <code className="font-mono">buho.ddl_events</code> schema (see store migration fragment) and wire
            the collector DDL hook to populate rows.
          </p>
        ) : null}
      </div>
    </section>
  );
}
