import { query } from './db';
import {
  defaultOverviewLayout,
  mergeWithDefaults,
  parseOverviewLayout,
  type OverviewLayout,
} from './overview-layout-types';

export type {
  OverviewLayout,
  OverviewMetricUnit,
  OverviewSqlMode,
  OverviewWidget,
  OverviewWidgetKind,
  OverviewWidgetSpan,
} from './overview-layout-types';
export {
  defaultOverviewLayout,
  mergeWithDefaults,
  newCustomWidgetId,
  parseOverviewLayout,
} from './overview-layout-types';

let schemaReady = false;

async function ensureOverviewLayoutSchema(): Promise<void> {
  if (schemaReady) return;
  await query(
    `create table if not exists buho.overview_layouts (
       username    text        not null,
       instance_id bigint      not null references buho.instances (instance_id) on delete cascade,
       layout      jsonb       not null,
       updated_at  timestamptz not null default now(),
       primary key (username, instance_id)
     )`,
  );
  schemaReady = true;
}

export async function getOverviewLayout(
  username: string,
  instanceId: number,
  engine = 'postgres',
): Promise<OverviewLayout> {
  await ensureOverviewLayoutSchema();
  const rows = await query<{ layout: unknown }>(
    `select layout from buho.overview_layouts where username = $1 and instance_id = $2`,
    [username, instanceId],
  );
  const parsed = parseOverviewLayout(rows[0]?.layout ?? null, engine);
  return mergeWithDefaults(parsed, engine);
}

export async function saveOverviewLayout(
  username: string,
  instanceId: number,
  layout: OverviewLayout,
  engine = 'postgres',
): Promise<OverviewLayout> {
  await ensureOverviewLayoutSchema();
  const merged = mergeWithDefaults(layout, engine);
  await query(
    `insert into buho.overview_layouts (username, instance_id, layout, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (username, instance_id) do update set
       layout = excluded.layout,
       updated_at = now()`,
    [username, instanceId, JSON.stringify(merged)],
  );
  return merged;
}

export async function resetOverviewLayout(
  username: string,
  instanceId: number,
  engine = 'postgres',
): Promise<OverviewLayout> {
  await ensureOverviewLayoutSchema();
  await query(`delete from buho.overview_layouts where username = $1 and instance_id = $2`, [
    username,
    instanceId,
  ]);
  return defaultOverviewLayout(engine);
}
