import Link from 'next/link';
import { Store } from '@buho/store';
import { getVacuumTables } from '@/lib/vacuum';
import { query, storeUrl } from '@/lib/db';
import { getLockEpisodes } from '@/lib/queries';
import {
  resolveBlamePlaybooks,
  type BlamePlaybookSignals,
  type PlaybookView,
} from '@/lib/playbooks';

function PlaybookCard({ playbook }: { playbook: PlaybookView }) {
  return (
    <article className="rounded-md border border-border/60 bg-surface/40 p-3">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{playbook.title}</h3>
        <span className="font-mono text-[10px] text-foreground-muted">{playbook.key}</span>
      </header>
      <p className="mb-2 text-[12px] text-foreground-secondary">{playbook.reason}</p>
      <ol className="m-0 list-decimal pl-4 text-[12px] text-foreground-secondary">
        {playbook.steps.map((step) => (
          <li key={step.label} className="mb-1 leading-snug">
            {step.href ? (
              <Link href={step.href} className="underline decoration-dotted text-foreground">
                {step.label}
              </Link>
            ) : (
              <span className="text-foreground">{step.label}</span>
            )}
            {step.detail ? (
              <span className="block font-mono text-[10px] text-foreground-muted">{step.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
  );
}

async function loadSignals(
  instanceId: number,
  alias: string,
  engine: string,
  windowMinutes: number,
  blockedSessions: number,
): Promise<BlamePlaybookSignals> {
  const hours = Math.max(1, Math.round(windowMinutes / 60));
  const store = new Store(storeUrl());

  let lockWaitPct: number | null = null;
  let planRegressionQueryid: string | null = null;
  let vacuumRiskTables = 0;
  let rpoAtRisk = false;
  let activeLockEpisodes = 0;

  try {
    const [classShare, blame, lockPack, rpoCheck] = await Promise.all([
      store.listWaitClassShare(instanceId, windowMinutes),
      store.listWaitSqlBlame(instanceId, windowMinutes),
      getLockEpisodes(instanceId, hours, 1, 0).catch(() => ({ active: 0, total: 0, episodes: [] })),
      query<{ severity: string }>(
        `select severity
           from buho.check_results
          where instance_id = $1
            and check_id = any(array['pack.rpo_exposure', 'rpo_exposure'])
            and ts > now() - interval '24 hours'
          order by ts desc
          limit 1`,
        [instanceId],
      ).catch(() => []),
    ]);

    activeLockEpisodes = lockPack.active;
    const lockRow = classShare.find((r) => r.waitClass === 'Lock');
    lockWaitPct = lockRow?.pct ?? null;

    const regCheck = await query<{ object: string | null }>(
      `select object
         from buho.check_results
        where instance_id = $1
          and check_id = 'plan_regression'
          and severity in ('critical', 'warning')
          and ts > now() - interval '24 hours'
        order by ts desc
        limit 1`,
      [instanceId],
    ).catch(() => []);

    const regObject = regCheck[0]?.object;
    if (regObject && /^\d+$/.test(regObject)) {
      planRegressionQueryid = regObject;
    } else {
      const top = blame.find((b) => b.queryid);
      if (top) {
        const qid = Number(top.queryid);
        if (Number.isFinite(qid)) {
          const fps = await store.listPlanFingerprints(instanceId, qid, 6);
          const shapes = new Set(fps.map((f) => f.fingerprint));
          if (shapes.size >= 2) planRegressionQueryid = top.queryid;
        }
      }
    }

    const sev = rpoCheck[0]?.severity;
    rpoAtRisk = sev === 'critical' || sev === 'warning';

    if (engine === 'postgres') {
      const tables = await getVacuumTables(instanceId, 'muertas', 12).catch(() => []);
      vacuumRiskTables = tables.filter((t) => {
        const freeze = Math.max(t.xidPct ?? 0, t.mxidPct ?? 0);
        return (t.deadPct ?? 0) >= 5 || (t.bloatPct ?? 0) >= 20 || freeze >= 50;
      }).length;
    }
  } finally {
    await store.close();
  }

  return {
    instanceId,
    alias,
    engine,
    lockWaitPct,
    activeLockEpisodes,
    blockedSessions,
    planRegressionQueryid,
    vacuumRiskTables,
    rpoAtRisk,
  };
}

/** Contextual ops steps for the Blame war room. */
export async function BlamePlaybook({
  instanceId,
  alias,
  engine,
  windowMinutes = 60,
  blockedSessions = 0,
}: {
  instanceId: number;
  alias: string;
  engine: string;
  windowMinutes?: number;
  blockedSessions?: number;
}) {
  const signals = await loadSignals(instanceId, alias, engine, windowMinutes, blockedSessions);
  const playbooks = resolveBlamePlaybooks(signals);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Ops playbook</span>
        <span className="tag tag--muted">runbook</span>
      </div>
      {playbooks.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No active runbooks for this window — lock, plan, vacuum, and RPO signals look calm.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 px-4 pb-4 lg:grid-cols-2">
          {playbooks.map((pb) => (
            <PlaybookCard key={pb.key} playbook={pb} />
          ))}
        </div>
      )}
    </section>
  );
}
