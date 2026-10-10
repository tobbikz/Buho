import { query } from './db';
import { servicePath } from './obs-service';

const ALIAS_RE = /^[a-zA-Z0-9._-]+$/;

export async function getEndpointTargetId(alias: string): Promise<number | null> {
  const rows = await query<{ target_id: number }>(
    `select target_id from buho.monitor_targets
      where tenant = 'default' and alias = $1 and engine = 'endpoint'`,
    [alias],
  );
  return rows[0] ? Number(rows[0].target_id) : null;
}

export async function renameObsService(
  from: string,
  to: string,
): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  const src = from.trim();
  const dest = to.trim();
  if (!src || !dest) return { ok: false, error: 'name required' };
  if (!ALIAS_RE.test(dest)) {
    return { ok: false, error: 'Use letters, digits, . _ - only' };
  }
  if (src === dest) return { ok: true, href: servicePath(dest) };

  const clash = await query<{ n: number }>(
    `select (
       (select count(*)::int from buho.instances where tenant='default' and alias=$1)
     + (select count(*)::int from buho.monitor_targets where tenant='default' and alias=$1)
     + (select count(*)::int from buho.otlp_traces
         where coalesce(nullif(root_service,''),'(unknown)')=$1
           and start_ts > now() - interval '7 days')
     ) as n`,
    [dest],
  );
  if (Number(clash[0]?.n ?? 0) > 0) {
    return { ok: false, error: `Name «${dest}» already in use` };
  }

  await query(
    `update buho.monitor_targets set alias = $2, updated_at = now()
      where tenant = 'default' and alias = $1 and engine = 'endpoint'`,
    [src, dest],
  );
  await query(
    `update buho.instances set alias = $2
      where tenant = 'default' and alias = $1 and engine = 'endpoint'`,
    [src, dest],
  );

  await query(
    `update buho.otlp_traces set root_service = $2
      where coalesce(nullif(root_service, ''), '(unknown)') = $1`,
    [src, dest],
  );
  await query(
    `update buho.otlp_spans set service_name = $2 where service_name = $1`,
    [src, dest],
  );
  await query(
    `update buho.service_deps set from_service_name = $2
      where from_service_name = $1`,
    [src, dest],
  );
  await query(
    `update buho.obs_service_tags set entity_key = $2
      where entity_kind = 'apm' and entity_key = $1`,
    [src, dest],
  );

  return { ok: true, href: servicePath(dest) };
}

/**
 * Delete an uptime probe. Works for:
 * - monitors with monitor_targets row
 * - orphan endpoint instances (no monitor_targets) — common lab leftovers
 */
export async function deleteObsProbe(
  alias: string,
): Promise<{ ok: true; instanceId: number | null } | { ok: false; error: string }> {
  const name = alias.trim();
  if (!name) return { ok: false, error: 'alias required' };

  const inst = await query<{ instance_id: number }>(
    `select instance_id from buho.instances
      where tenant = 'default' and alias = $1 and engine = 'endpoint'`,
    [name],
  );
  const instanceId = inst[0] ? Number(inst[0].instance_id) : null;
  const targetId = await getEndpointTargetId(name);

  if (targetId == null && instanceId == null) {
    return { ok: false, error: 'No HTTP probe for this service' };
  }

  if (targetId != null) {
    await query(`delete from buho.monitor_targets where target_id = $1`, [targetId]);
  }

  if (instanceId != null) {
    // Best-effort cleanup for tables that may not CASCADE (rollups, etc.).
    await query(`delete from buho.metric_rollup_1h where instance_id = $1`, [instanceId]).catch(
      () => undefined,
    );
    await query(`delete from buho.metric_rollup_5m where instance_id = $1`, [instanceId]).catch(
      () => undefined,
    );
    await query(
      `delete from buho.obs_service_tags
        where entity_kind = 'synthetics' and entity_key = $1`,
      [String(instanceId)],
    );
    await query(`delete from buho.instances where instance_id = $1 and engine = 'endpoint'`, [
      instanceId,
    ]);
  }

  return { ok: true, instanceId };
}

export async function deleteObsApm(
  serviceName: string,
): Promise<{ ok: true; deletedTraces: number } | { ok: false; error: string }> {
  const name = serviceName.trim();
  if (!name) return { ok: false, error: 'service required' };

  const traces = await query<{ n: number }>(
    `with del as (
       delete from buho.otlp_traces
        where coalesce(nullif(root_service, ''), '(unknown)') = $1
       returning 1
     )
     select count(*)::int as n from del`,
    [name],
  );
  await query(`delete from buho.otlp_spans where service_name = $1`, [name]);
  await query(
    `update buho.service_deps set from_service_name = null where from_service_name = $1`,
    [name],
  );
  await query(
    `delete from buho.obs_service_tags where entity_kind = 'apm' and entity_key = $1`,
    [name],
  );

  return { ok: true, deletedTraces: Number(traces[0]?.n ?? 0) };
}

/** Remove probe and/or APM data for a service name. */
export async function deleteObsService(
  name: string,
  scope: 'probe' | 'apm' | 'all',
): Promise<{ ok: true } | { ok: false; error: string }> {
  let removedSomething = false;
  const errors: string[] = [];

  if (scope === 'probe' || scope === 'all') {
    const r = await deleteObsProbe(name);
    if (r.ok) removedSomething = true;
    else if (scope === 'probe') return r;
    else errors.push(r.error);
  }

  if (scope === 'apm' || scope === 'all') {
    const r = await deleteObsApm(name);
    if (!r.ok) {
      if (scope === 'apm') return r;
      errors.push(r.error);
    } else if (r.deletedTraces > 0) {
      removedSomething = true;
    }
  }

  if (scope === 'all' && !removedSomething) {
    // Probe path may have been the only thing; if probe succeeded we're fine.
    // If both no-ops, surface a clear error.
    const still = await query<{ n: number }>(
      `select (
         (select count(*)::int from buho.instances
           where tenant='default' and alias=$1 and engine='endpoint')
       + (select count(*)::int from buho.otlp_traces
           where coalesce(nullif(root_service,''),'(unknown)')=$1
             and start_ts > now() - interval '7 days')
       ) as n`,
      [name],
    );
    if (Number(still[0]?.n ?? 0) > 0) {
      return {
        ok: false,
        error: errors[0] ?? 'Could not delete this service (still present)',
      };
    }
  }

  return { ok: true };
}
