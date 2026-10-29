import Link from 'next/link';
import { defaultHaReplicationSlo, evaluateHaReplicationSamples } from '@buho/checks';
import type { CheckResult } from '@buho/checks';
import type { Sample } from '@buho/core';
import { getLabeled } from '@/lib/queries';

function pushLabeled(samples: Sample[], metric: string, rows: Awaited<ReturnType<typeof getLabeled>>) {
  for (const row of rows) {
    samples.push({ metric, value: row.value, labels: row.labels });
  }
}

function worstSeverity(results: CheckResult[]): 'ok' | 'warning' | 'critical' {
  if (results.some((r) => r.severity === 'critical')) return 'critical';
  if (results.some((r) => r.severity === 'warning')) return 'warning';
  return 'ok';
}

/** Compact HA / replication SLO from recent metric samples (Blame grid). */
export async function HaSloPanel({
  instanceId,
  windowMinutes = 15,
}: {
  instanceId: number;
  windowMinutes?: number;
}) {
  const [
    replayLag,
    foreignLag,
    standbyLag,
    subLag,
    slotActive,
    slotSafe,
    pausedRows,
    walRows,
  ] = await Promise.all([
    getLabeled(instanceId, 'replication_replay_lag_seconds', 8, windowMinutes),
    getLabeled(instanceId, 'replication_lag_seconds', 8, windowMinutes),
    getLabeled(instanceId, 'standby_replay_delay_seconds', 4, windowMinutes),
    getLabeled(instanceId, 'replication_subscription_lag_seconds', 4, windowMinutes),
    getLabeled(instanceId, 'replication_slot_active', 12, windowMinutes),
    getLabeled(instanceId, 'replication_slot_safe_wal_size_bytes', 12, windowMinutes),
    getLabeled(instanceId, 'standby_replay_paused', 1, windowMinutes).catch(() => []),
    getLabeled(instanceId, 'wal_buffers_full', 1, windowMinutes).catch(() => []),
  ]);

  const samples: Sample[] = [];
  pushLabeled(samples, 'replication_replay_lag_seconds', replayLag);
  pushLabeled(samples, 'replication_lag_seconds', foreignLag);
  pushLabeled(samples, 'standby_replay_delay_seconds', standbyLag);
  pushLabeled(samples, 'replication_subscription_lag_seconds', subLag);
  pushLabeled(samples, 'replication_slot_active', slotActive);
  pushLabeled(samples, 'replication_slot_safe_wal_size_bytes', slotSafe);
  if (pausedRows[0]) {
    samples.push({ metric: 'standby_replay_paused', value: pausedRows[0].value });
  }
  if (walRows[0]) {
    samples.push({ metric: 'wal_buffers_full', value: walRows[0].value });
  }

  const findings = evaluateHaReplicationSamples(samples, defaultHaReplicationSlo());
  const state = worstSeverity(findings);
  const slo = defaultHaReplicationSlo();

  const tagClass =
    state === 'critical'
      ? 'tag tag--error'
      : state === 'warning'
        ? 'tag tag--warn'
        : 'tag tag--ok';

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">HA / replication SLO</span>
        <Link className="text-[12px] underline" href={`/instances/${instanceId}/replication`}>
          Replication
        </Link>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
        <div className="flex items-center gap-2">
          <span className={tagClass}>{state === 'ok' ? 'within SLO' : state}</span>
          <span className="text-foreground-secondary">
            Lag warn {slo.lagWarningSeconds}s / crit {slo.lagCriticalSeconds}s
          </span>
        </div>
        {findings.length === 0 ? (
          <p className="text-foreground-secondary">
            No replication lag or slot/WAL risks in the last {windowMinutes}m of samples.
          </p>
        ) : (
          <ul className="list-disc pl-4 text-[12.5px]">
            {findings.slice(0, 5).map((f) => (
              <li key={`${f.checkId}-${f.object ?? ''}-${f.message}`}>
                <span
                  className={
                    f.severity === 'critical'
                      ? 'text-error'
                      : f.severity === 'warning'
                        ? 'text-warn'
                        : ''
                  }
                >
                  {f.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
