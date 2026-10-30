import { revalidatePath } from 'next/cache';
import { EventsFeed } from '@/components/EventsFeed';
import { FleetScopeFilters } from '@/components/FleetScopeFilters';
import { FleetLogPatterns } from '@/components/FleetLogPatterns';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import {
  acknowledgeAllOpenEvents,
  acknowledgeEvents,
  getEvents,
  type EventFeedView,
} from '@/lib/queries';
import { getFleetLogLevelCounts, getFleetLogPatterns } from '@/lib/logs';
import { currentSession } from '@/lib/session';
import { listScopeChoices, matchesScope, scopeEngines } from '@/lib/fleet-scope';

export const dynamic = 'force-dynamic';

async function ackEvents(eventIds: number[]) {
  'use server';
  const session = await currentSession();
  if (session.role !== 'admin') throw new Error('Administrator role required.');
  await acknowledgeEvents(eventIds, session.username);
  revalidatePath('/events');
}

async function ackAllEvents() {
  'use server';
  const session = await currentSession();
  if (session.role !== 'admin') throw new Error('Administrator role required.');
  await acknowledgeAllOpenEvents(session.username);
  revalidatePath('/events');
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; engine?: string; conn?: string }>;
}) {
  const { view: viewParam, engine: engineParam, conn: connParam } = await searchParams;
  const view: EventFeedView = viewParam === 'history' ? 'history' : 'open';
  const engine = engineParam ?? '';
  const conn = connParam ?? '';
  const session = await currentSession();

  let events;
  let patterns;
  let levelCounts;
  let choices: Awaited<ReturnType<typeof listScopeChoices>> = [];
  try {
    [events, patterns, levelCounts, choices] = await Promise.all([
      getEvents(null, view === 'history' ? 250 : 100, view),
      getFleetLogPatterns(24, 40),
      getFleetLogLevelCounts(24),
      listScopeChoices(),
    ]);
    const activeAliases = new Set(choices.map((row) => row.alias));
    const engineOf = new Map(choices.map((row) => [row.alias, row.engine]));
    const inScope = (alias: string | null, rowEngine: string | null) => {
      // Active fleet only (retired Admin targets never appear in choices).
      if (alias && !activeAliases.has(alias)) return false;
      const resolved = rowEngine || (alias ? engineOf.get(alias) : '') || '';
      if (!alias && (engine || conn)) return false;
      return matchesScope({ alias: alias ?? '', engine: resolved }, engine, conn);
    };
    events = events.filter((event) => inScope(event.instanceAlias, null));
    patterns = patterns.filter((row) => inScope(row.alias, row.engine));
    levelCounts = levelCounts.filter((row) => inScope(row.alias, row.engine));
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Events' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const openCount = view === 'open' ? events.length : null;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Events' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Collector events</h1>
            <p className="page-sub">
              {view === 'open'
                ? `${openCount ?? events.length} open group(s) — click a row for details. Acknowledge to triage; History keeps the full log.`
                : `Full event log (${events.length} entries). Click a row for message and detail.`}
            </p>
          </div>
        </header>

        <FleetScopeFilters
          engines={scopeEngines(choices)}
          instances={choices}
          engine={engine}
          conn={conn}
          preserve={view === 'history' ? { view: 'history' } : undefined}
        />

        <FleetLogPatterns patterns={patterns} levelCounts={levelCounts} hours={24} />

        <section className="panel">
          <EventsFeed
            events={events}
            view={view}
            canAcknowledge={session.role === 'admin'}
            onAcknowledge={ackEvents}
            onAcknowledgeAll={ackAllEvents}
          />
        </section>
      </div>
    </>
  );
}

export const metadata = { title: 'Events · Búho' };
