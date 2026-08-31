import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatNumber } from '@/lib/format';
import {
  getFleetCheckTotals,
  getFleetChecks,
  getInstanceScores,
  type CheckGroup,
  type InstanceScore,
  type Severity,
} from '@/lib/checks';

export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; severities: Severity[] }[] = [
  { key: 'accionable', label: 'Accionable', severities: ['critical', 'warning'] },
  { key: 'critico', label: 'Sólo crítico', severities: ['critical'] },
  { key: 'todo', label: 'Todo', severities: ['critical', 'warning', 'info'] },
];

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'crítico',
  warning: 'advertencia',
  info: 'informativo',
};

function scoreTone(score: number | null): string {
  if (score === null) return 'text-foreground-muted';
  if (score < 60) return 'text-[var(--error)]';
  if (score < 80) return 'text-[var(--warning)]';
  return 'text-[var(--ok)]';
}

function GroupCard({ group }: { group: CheckGroup }) {
  // Abierto de entrada cuando afecta a una sola instancia: cerrarlo esconde la
  // única línea que importa. Con varias, la lista sí estorba.
  const open = group.instances === 1;

  return (
    <details className="check-group" open={open}>
      <summary className="check-group__head">
        <span className={`tag ${SEVERITY_TAG[group.severity]}`}>{SEVERITY_LABEL[group.severity]}</span>
        <span className="check-group__title">{group.title}</span>
        <span className="check-group__count font-mono">
          {group.instances} instancia{group.instances === 1 ? '' : 's'}
          {group.findings > group.instances ? ` · ${group.findings} hallazgos` : ''}
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">{group.checkId}</span>
      </summary>

      <div className="check-group__body">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Instancia</th>
                <th>Objeto</th>
                <th>Qué encontró</th>
                <th className="text-right">Medido</th>
              </tr>
            </thead>
            <tbody>
              {group.occurrences.map((entry, index) => (
                <tr key={`${entry.instanceId}:${entry.object ?? ''}:${index}`}>
                  <td>
                    <Link href={`/instances/${entry.instanceId}`} className="font-mono text-[11.5px] underline">
                      {entry.alias}
                    </Link>
                    <span className="ml-1.5 text-[10px] text-foreground-muted">
                      {entry.group ?? entry.environment}
                    </span>
                  </td>
                  <td className="font-mono text-[11px] text-foreground-secondary">{entry.object ?? '—'}</td>
                  <td className="text-[11.5px]">{entry.message}</td>
                  <td className="num font-mono text-[11px]">
                    {entry.value === null ? '—' : formatNumber(Math.round(entry.value * 100) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {group.remediation && (
          <div className="check-group__fix">
            <span className="check-group__fix-label">Cómo se arregla</span>
            <p>{group.remediation}</p>
          </div>
        )}
      </div>
    </details>
  );
}

function ScoreRow({ instance }: { instance: InstanceScore }) {
  return (
    <tr>
      <td>
        <Link href={`/instances/${instance.instanceId}`} className="font-mono text-[11.5px] underline">
          {instance.alias}
        </Link>
      </td>
      <td className="text-[11px] text-foreground-muted">{instance.group ?? '—'}</td>
      <td className="text-[11px] text-foreground-muted">{instance.environment}</td>
      <td className={`num font-mono text-[12px] font-semibold ${scoreTone(instance.score)}`}>
        {instance.score ?? '—'}
      </td>
      <td className="num">{instance.critical > 0 ? <span className="tag tag--error">{instance.critical}</span> : '—'}</td>
      <td className="num">{instance.warning > 0 ? <span className="tag tag--warn">{instance.warning}</span> : '—'}</td>
      <td className="num text-[11px] text-foreground-muted">{instance.info || '—'}</td>
      <td className="num font-mono text-[10px] text-foreground-muted">
        {instance.ts ? formatAgo(instance.ts) : 'nunca corrió'}
      </td>
    </tr>
  );
}

export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ ver?: string }>;
}) {
  const { ver } = await searchParams;
  const filter = FILTERS.find((entry) => entry.key === ver) ?? FILTERS[0]!;

  let groups: CheckGroup[];
  let totals: Awaited<ReturnType<typeof getFleetCheckTotals>>;
  let scores: InstanceScore[];
  try {
    [groups, totals, scores] = await Promise.all([
      getFleetChecks(filter.severities),
      getFleetCheckTotals(),
      getInstanceScores(),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Chequeos' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const repeated = groups.filter((group) => group.instances > 1);

  return (
    <>
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Chequeos' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Chequeos de la flota</h1>
            <p className="page-sub">
              Los 22 chequeos de todas las instancias en una sola lista, ordenada por severidad y después por
              cuántas instancias afecta. Un mismo problema repetido en media flota se arregla una vez y baja
              muchos hallazgos: eso es lo que esta pantalla busca hacer visible.
            </p>
          </div>
          <AutoRefresh intervalMs={60000} />
        </header>

        <div className="stat-grid">
          <StatCard
            label="Críticos"
            value={formatNumber(totals.critical)}
            tone={totals.critical > 0 ? 'error' : 'ok'}
            hint="riesgo de pérdida o caída"
          />
          <StatCard
            label="Advertencias"
            value={formatNumber(totals.warning)}
            tone={totals.warning > 0 ? 'warn' : 'ok'}
          />
          <StatCard label="Informativos" value={formatNumber(totals.info)} tone="neutral" />
          <StatCard
            label="Instancias con hallazgos"
            value={`${formatNumber(totals.instancesAffected)} de ${formatNumber(totals.instancesReporting)}`}
            tone={totals.instancesAffected > 0 ? 'warn' : 'ok'}
            hint={`${formatNumber(totals.instancesClean)} sin nada que reportar`}
          />
          <StatCard
            label="Peor puntaje"
            value={totals.worstScore === null ? '—' : String(totals.worstScore)}
            tone={
              totals.worstScore === null
                ? 'neutral'
                : totals.worstScore < 60
                  ? 'error'
                  : totals.worstScore < 80
                    ? 'warn'
                    : 'ok'
            }
          />
          <StatCard
            label="Última corrida"
            value={totals.lastRunAt ? formatAgo(totals.lastRunAt) : '—'}
            tone="neutral"
            hint="los chequeos corren cada 5 min"
          />
        </div>

        {totals.instancesSilent > 0 && (
          <div className="notice notice--warn">
            <strong>
              {formatNumber(totals.instancesSilent)} instancia{totals.instancesSilent === 1 ? '' : 's'} de
              PostgreSQL sin chequeos.
            </strong>{' '}
            Nunca reportaron una corrida, así que su ausencia en esta lista no significa que estén bien: significa
            que no se sabe. Suele ser un colector que no arranca o credenciales sin{' '}
            <span className="font-mono">pg_monitor</span>.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Ver</span>
          {FILTERS.map((entry) => (
            <a
              key={entry.key}
              href={`/checks?ver=${entry.key}`}
              className={`tag ${entry.key === filter.key ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        {repeated.length > 0 && (
          <div className="notice">
            <strong>Arreglos que rinden más.</strong>{' '}
            {repeated
              .slice(0, 3)
              .map((group) => `${group.title} (${group.instances} instancias)`)
              .join(' · ')}
            . Son problemas de plataforma, no de un servidor.
          </div>
        )}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {filter.label} · {groups.length} chequeo{groups.length === 1 ? '' : 's'} con hallazgos
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">
              severidad, después alcance
            </span>
          </div>

          {groups.length === 0 ? (
            <div className="empty">
              Ningún chequeo con hallazgos de esta severidad en la última corrida de cada instancia.
            </div>
          ) : (
            <div className="check-list">
              {groups.map((group) => (
                <GroupCard key={group.checkId} group={group} />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Puntaje por instancia</span>
            <span className="font-mono text-[10px] text-foreground-muted">peor primero</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Grupo</th>
                  <th>Entorno</th>
                  <th className="text-right">Puntaje</th>
                  <th className="text-right">Crít.</th>
                  <th className="text-right">Adv.</th>
                  <th className="text-right">Info</th>
                  <th className="text-right">Corrida</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((instance) => (
                  <ScoreRow key={instance.instanceId} instance={instance} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
